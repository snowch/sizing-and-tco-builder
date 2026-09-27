/*
 * Working a model out, as sizing/evaluate.py does: the unit pass, and the point.
 *
 * The unit pass evaluates every formula on quantities (quantity.js) at a plausible magnitude for
 * each node, checks the unit it produces against the one the node declares, and records the
 * factor that converts one into the other. The point is one value per node, in plain floats, with
 * those factors applied. Both follow the book step for step, because where the book raises (a
 * division by zero, a logarithm of a negative) its verdict changes, and so must the engine's.
 *
 * Sampling is milestone 4. Until then a scenario is checked at the point and for everything the
 * book's sampler would refuse before it draws (a shape it cannot use, correlations no inputs can
 * have); a scenario whose draws alone go non-finite is not yet caught (PLAN.md, known gaps).
 */

import { blocked, measuredSd, measuredValue } from "./model.js";
import { MATH, PyError, float, isDict, iterate, isInt, get, sorted } from "./python.js";
import { Quantities, plain, quantity, unitKey } from "./quantity.js";

export class EvaluationError extends Error {}

export const SHAPES = ["uniform", "triangular", "lognormal", "normal"];
const PARAMETERS = {
  uniform: ["minimum", "maximum"],
  triangular: ["minimum", "likely", "maximum"],
  lognormal: ["p10", "p90"],
  normal: ["mean", "sd"],
};


// -- the plain-float walk (SCALAR_FUNCTIONS), with Python's raises -----------------------------------

/* A scalar is a number, or { complex: true } once Python has made it complex. */
const COMPLEX = { complex: true };
const isComplex = (x) => typeof x === "object" && x?.complex;

export function walk(tree, lookup) {
  switch (tree.op) {
    case "const":
      return tree.value;
    case "ref":
      if (!lookup.has(tree.name)) throw new EvaluationError(`'${tree.name}' has no value at this point in the graph`);
      return lookup.get(tree.name);
    case "neg": {
      const x = walk(tree.args[0], lookup);
      return isComplex(x) ? x : -x;
    }
    case "call": {
      const args = tree.args.map((arg) => walk(arg, lookup));
      if (args.some(isComplex) && (tree.fn === "min" || tree.fn === "max") && args.length > 1) {
        throw new PyError("TypeError", "'<' not supported between instances of 'complex' and 'float'");
      }
      return MATH[tree.fn](...args);
    }
    default: {
      const a = walk(tree.args[0], lookup);
      const b = walk(tree.args[1], lookup);
      if (tree.op === "/" && b === 0) throw new PyError("ZeroDivisionError", "float division by zero");
      if (isComplex(a) || isComplex(b)) return COMPLEX;
      switch (tree.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        default: {
          if (a === 0 && b < 0) throw new PyError("ZeroDivisionError", "0.0 cannot be raised to a negative power");
          if (a < 0 && Number.isFinite(b) && !Number.isInteger(b)) return COMPLEX;
          const r = a ** b;
          if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) {
            throw new PyError("OverflowError", "(34, 'Numerical result out of range')");
          }
          return r;
        }
      }
    }
  }
}

/* float() of a walked value: a complex result is refused, as Python refuses it. */
export function real(x) {
  if (isComplex(x)) throw new PyError("TypeError", "float() argument must be a string or a real number, not 'complex'");
  return x;
}

// -- distributions ------------------------------------------------------------------------------

/* mc.one_shape: exactly one of the four shapes, and its parameters. */
export function oneShape(spec) {
  if (spec === null || spec === undefined || typeof spec === "number" || typeof spec === "boolean" || isInt(spec)) {
    throw new PyError("TypeError", "the distribution is not iterable");
  }
  const declared = iterate(spec).filter((key) => typeof key === "string" && SHAPES.includes(key));
  if (declared.length !== 1) {
    throw new PyError("ValueError", `a distribution declares exactly one shape. Known shapes: ${[...SHAPES].sort().join(", ")}`);
  }
  const [shape] = declared;
  const parameters = isDict(spec) ? spec.get(shape) : null;
  if (!isDict(parameters)) throw new PyError("TypeError", `the ${shape} parameters are not a mapping`);
  const wanted = PARAMETERS[shape];
  const names = [...parameters.keys()];
  if (names.length !== wanted.length || !names.every((n) => wanted.includes(n))) {
    throw new PyError("TypeError", `${shape} takes ${wanted.join(", ")}`);
  }
  const values = {};
  for (const name of wanted) {
    const v = parameters.get(name);
    if (typeof v === "number") values[name] = v;
    else if (isInt(v)) values[name] = Number(v.value);
    else if (typeof v === "boolean") values[name] = v ? 1 : 0;
    else throw new PyError("TypeError", `${shape} ${name} is not a number`);
  }
  return [shape, values];
}

/* The shape's own checks, which mc makes before it draws anything. */
export function checkShape(shape, p) {
  if (shape === "triangular" && !(p.minimum <= p.likely && p.likely <= p.maximum)) {
    throw new PyError("ValueError", `triangular needs min <= likely <= max, got ${p.minimum}, ${p.likely}, ${p.maximum}`);
  }
  if (shape === "lognormal" && !(p.p10 > 0 && p.p10 < p.p90)) {
    throw new PyError("ValueError", `lognormal needs 0 < p10 < p90, got p10=${p.p10}, p90=${p.p90}`);
  }
  if (shape === "normal" && p.sd < 0) throw new PyError("ValueError", `normal needs sd >= 0, got ${p.sd}`);
}

/* The value at percentile u, each shape as mc computes it. */
export function ppf(shape, p, u) {
  checkShape(shape, p);
  switch (shape) {
    case "uniform":
      return p.minimum + u * (p.maximum - p.minimum);
    case "triangular": {
      if (p.maximum === p.minimum) return p.minimum;
      const width = p.maximum - p.minimum;
      const atMode = (p.likely - p.minimum) / width;
      if (u < atMode) return p.minimum + Math.sqrt(u * width * (p.likely - p.minimum));
      return p.maximum - Math.sqrt((1.0 - u) * width * (p.maximum - p.likely));
    }
    case "lognormal": {
      const logMedian = (Math.log(p.p10) + Math.log(p.p90)) / 2.0;
      const logSpread = (Math.log(p.p90) - Math.log(p.p10)) / (2.0 * Z90());
      return Math.exp(logMedian + logSpread * normalPpf(u));
    }
    default:
      return p.mean + p.sd * normalPpf(u);
  }
}

/* sizing/normal.py: Acklam's rational approximation, with the book's constants. */
const CENTRAL_NUM = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const CENTRAL_DEN = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const TAIL_NUM = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const TAIL_DEN = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const TAIL = 0.02425;
const poly = (cs, x) => cs.reduce((out, c) => out * x + c, 0);

/* mc.Z90: normal_ppf(0.9), Acklam's approximation as the book computes it. */
let z90;
export const Z90 = () => (z90 ??= normalPpf(0.9));

export function normalPpf(u) {
  if (!(u > 0 && u < 1)) throw new PyError("ValueError", "normal_ppf needs percentiles strictly between 0 and 1");
  if (u < TAIL || u > 1 - TAIL) {
    const lower = u < TAIL;
    const q = Math.sqrt(-2.0 * Math.log(lower ? u : 1.0 - u));
    const v = poly(TAIL_NUM, q) / (poly(TAIL_DEN, q) * q + 1.0);
    return lower ? v : -v;
  }
  const q = u - 0.5;
  const r = q * q;
  return (poly(CENTRAL_NUM, r) * q) / (poly(CENTRAL_DEN, r) * r + 1.0);
}

/* evaluate.point_value_of_input: an override, else the value, else the median of the shape. */
export function pointValueOfInput(node, scenario) {
  if (scenario && scenario.overrides.has(node.name)) return scenario.overrides.get(node.name);
  if (node.value !== null) return node.value;
  if (node.distribution !== null) {
    const [shape, p] = oneShape(node.distribution);
    return ppf(shape, p, 0.5);
  }
  return null;
}

// -- pass one: units -----------------------------------------------------------------------------

/* evaluate.plausible_magnitudes: a realistic number per node to do the unit pass with. */
export function plausibleMagnitudes(model) {
  const magnitudes = new Map();
  for (const name of model.order) {
    const node = model.nodes.get(name);
    try {
      if (node.kind === "input") {
        const resolved = pointValueOfInput(node, null);
        magnitudes.set(name, resolved === null ? 1.0 : resolved);
      } else if (node.kind === "measured") {
        magnitudes.set(name, node.measurement === null ? 1.0 : measuredValue(node));
      } else {
        magnitudes.set(name, real(walk(node.kind === "derived" ? node.formula : node.of, magnitudes)));
      }
    } catch (error) {
      if (!(error instanceof PyError || error instanceof EvaluationError)) throw error;
      magnitudes.set(name, 0.37);
    }
  }
  return magnitudes;
}

function unitWalk(tree, lookup, q) {
  switch (tree.op) {
    case "const":
      return plain(tree.value);
    case "ref":
      if (!lookup.has(tree.name)) throw new EvaluationError(`'${tree.name}' has no value`);
      return lookup.get(tree.name);
    case "neg":
      return q.negate(unitWalk(tree.args[0], lookup, q));
    case "call":
      return q.call(tree.fn, tree.args.map((arg) => unitWalk(arg, lookup, q)));
    default: {
      const a = unitWalk(tree.args[0], lookup, q);
      const b = unitWalk(tree.args[1], lookup, q);
      switch (tree.op) {
        case "+":
          return q.add(a, b);
        case "-":
          return q.add(a, b, true);
        case "*":
          return q.multiply(a, b);
        case "/":
          return q.divide(a, b);
        default:
          return q.power(a, b);
      }
    }
  }
}

/*
 * evaluate.check_units: every unit problem, and the factor each formula needs.
 *
 * Problems come back as { code, node, part } in the book's order, so verify.js reports them as
 * verify-models.py does.
 */
export function checkUnits(model, registry) {
  const q = new Quantities(registry);
  const problems = [];
  const factors = new Map();
  const magnitudes = plausibleMagnitudes(model);
  const quantities = new Map();

  for (const name of model.order) {
    const node = model.nodes.get(name);
    const declared = registry.parse(node.unit);
    quantities.set(name, quantity(magnitudes.get(name), declared));
    if (node.kind !== "derived" && node.kind !== "ceiling") continue;

    const parts = [["", node.kind === "derived" ? node.formula : node.of, node.unit]];
    if (node.kind === "ceiling") {
      parts.push(["limit", node.limit, node.unit]);
      parts.push(["headroom", node.headroom, "dimensionless"]);
    }
    for (const [part, tree, wanted] of parts) {
      const at = { node: name, part: part || null };
      const wantedUnits = registry.parse(wanted);
      let produced;
      try {
        produced = unitWalk(tree, quantities, q);
      } catch (error) {
        if (!(error instanceof PyError || error instanceof EvaluationError)) throw error;
        problems.push({ code: "units.does-not-typecheck", ...at, detail: error.message });
        continue;
      }
      const producedUnits = produced.units ?? {};
      if (!q.sameDimensions(producedUnits, wantedUnits)) {
        problems.push({ code: "units.declared-vs-produced", ...at, produced: producedUnits });
        continue;
      }
      factors.set(part ? `${name}.${part}` : name, q.factor(producedUnits, wantedUnits));
      for (const issue of mixedOperands(tree, quantities, q)) problems.push({ code: "units.mixed-operands", ...at, detail: issue });
      if (roundsInTheWrongUnit(tree, quantities, q, wantedUnits)) problems.push({ code: "units.rounds-in-wrong-unit", ...at });
    }
  }
  return { problems, factors, magnitudes };
}

/* evaluate._mixed_operands: a sum, difference, min or max whose operands are in different units. */
function mixedOperands(tree, quantities, q) {
  if (tree.op === "const" || tree.op === "ref") return [];
  const args = tree.args ?? [];
  const problems = args.flatMap((arg) => mixedOperands(arg, quantities, q));
  const produced = args.map((arg) => unitKey(unitWalk(arg, quantities, q)));
  const meets = tree.op === "+" || tree.op === "-" || (tree.op === "call" && (tree.fn === "min" || tree.fn === "max"));
  if (meets && new Set(produced).size > 1) problems.push([...new Set(produced)].join(" and "));
  return problems;
}

/* evaluate._rounds_in_the_wrong_unit: a ceil or floor at the top, over a number in another unit. */
function roundsInTheWrongUnit(tree, quantities, q, wanted) {
  if (tree.op !== "call" || (tree.fn !== "ceil" && tree.fn !== "floor")) return false;
  const inside = unitWalk(tree.args[0], quantities, q).units ?? {};
  if (!q.sameDimensions(inside, wanted)) return false;
  return Math.abs(q.factor(inside, wanted) - 1.0) >= 1e-12;
}

// -- pass two: a point ----------------------------------------------------------------------------

/* evaluate.point: one value per node, skipping what an unmeasured constant blocks. */
export function point(model, scenario, factors, blockedBy = blocked(model)) {
  const values = new Map();
  for (const name of model.order) {
    if (blockedBy.has(name)) continue;
    const node = model.nodes.get(name);
    if (node.kind === "input") {
      const resolved = pointValueOfInput(node, scenario);
      if (resolved === null) throw new EvaluationError(`${model.name}: input '${name}' has neither a value nor a distribution`);
      values.set(name, resolved);
    } else if (node.kind === "measured") {
      values.set(name, scenario && scenario.overrides.has(name) ? scenario.overrides.get(name) : measuredValue(node));
    } else {
      const tree = node.kind === "derived" ? node.formula : node.of;
      values.set(name, real(walk(tree, values)) * factors.get(name));
    }
  }
  return values;
}

/* evaluate.ceiling_report, at the point: where each ceiling sits, and the verdict. */
export function ceilingReport(model, values, factors) {
  const report = {};
  for (const node of model.nodes.values()) {
    if (node.kind !== "ceiling" || !values.has(node.name)) continue;
    const value = values.get(node.name);
    const limit = real(walk(node.limit, values)) * (factors.get(`${node.name}.limit`) ?? 1.0);
    const headroom = real(walk(node.headroom, values)) * (factors.get(`${node.name}.headroom`) ?? 1.0);
    const allowed = limit * (1.0 - headroom);
    report[node.name] = {
      value,
      limit,
      limit_text: node.limitText,
      headroom,
      headroom_text: node.headroomText,
      allowed,
      because: node.because,
      verdict: value > limit ? "over" : value > allowed ? "inside headroom" : "ok",
    };
  }
  return report;
}

// -- a scenario, as far as it can be checked without drawing --------------------------------------

/* Inputs with a shape, and measured constants with a standard error: where randomness enters. */
export function sampledInputs(model) {
  return sorted(
    [...model.nodes.values()]
      .filter(
        (node) =>
          (node.kind === "input" && node.distribution !== null) ||
          (node.kind === "measured" && node.measurement !== null && measuredSd(node) > 0),
      )
      .map((node) => node.name),
  );
}

/*
 * What evaluate() refuses for a scenario, short of drawing: the point, the shape of every input
 * it would draw, and the correlations between them. Throws with a `cause` the conformance suite
 * compares: typecheck, no-value, no-measured-value, distribution, correlation or arithmetic.
 */
export function checkScenario(model, scenario, units) {
  if (units.problems.length) throw withCause(new EvaluationError(`${model.name} does not typecheck`), "typecheck");
  const blockedBy = blocked(model);
  let values;
  try {
    values = point(model, scenario, units.factors, blockedBy);
  } catch (error) {
    throw withCause(error, causeOf(error));
  }
  const uncertain = sampledInputs(model).filter((name) => !blockedBy.has(name) && !scenario.overrides.has(name));
  for (const name of uncertain) {
    const node = model.nodes.get(name);
    if (node.kind !== "input") continue;
    try {
      const [shape, p] = oneShape(node.distribution);
      checkShape(shape, p);
    } catch (error) {
      throw withCause(error, "distribution");
    }
  }
  if (uncertain.length) {
    const drawn = new Set(uncertain);
    const live = model.correlations.filter((pair) => drawn.has(get(pair, "a")) && drawn.has(get(pair, "b")));
    if (live.length) {
      try {
        checkCorrelations(uncertain, live);
      } catch (error) {
        throw withCause(error, "correlation");
      }
    }
  }
  try {
    ceilingReport(model, values, units.factors);
  } catch (error) {
    throw withCause(error, causeOf(error));
  }
  // The book's evaluate() then samples every input with a shape and refuses a scenario in which
  // any node's draws are not all finite (its histogram cannot bin them). The builder's own stream
  // differs from the book's, so a failure that only rare draws produce may land differently;
  // anything structural (a square root of a range that crosses zero) lands the same.
  if (uncertain.length && sampleFn) {
    const drawn = sampleFn(model, scenario, units.factors, { summarise: [], samples: Math.min(scenario.samples, limit ?? Infinity) });
    if (drawn.nonFinite.length) {
      throw withCause(new EvaluationError(`some draws of ${drawn.nonFinite.join(", ")} are not finite`), "sampling");
    }
  }
  return values;
}

/* The sampler, handed in by sample.js when it loads, so the two modules do not import each other. */
let sampleFn = null;
let limit = null;
export function useSampler(fn) {
  sampleFn = fn;
}

/* At most this many draws per scenario when the verdict is checked, or every draw when null. */
export function limitDraws(n) {
  limit = n;
}

function withCause(error, cause) {
  error.cause = cause;
  return error;
}

function causeOf(error) {
  if (error instanceof EvaluationError) return /neither a value nor a distribution/.test(error.message) ? "no-value" : "typecheck";
  if (error instanceof PyError) {
    if (error.type === "KeyError" && error.message === "'value'") return "no-measured-value";
    if (/triangular needs|lognormal needs|normal needs|exactly one shape|parameters|takes |is not a number|not iterable/.test(error.message)) return "distribution";
    return "arithmetic";
  }
  return "arithmetic";
}

/* mc.correlation_matrix and the Cholesky step in mc.correlate, which is where a set of
 * correlations no inputs can have at once is refused. */
export function checkCorrelations(names, pairs) {
  const index = new Map(names.map((n, i) => [n, i]));
  const k = names.length;
  const target = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  for (const pair of pairs) {
    const a = get(pair, "a");
    const b = get(pair, "b");
    if (!pair.has("rho")) throw new PyError("KeyError", "'rho'");
    const rho = float(pair.get("rho"));
    if (!(rho >= -1 && rho <= 1)) throw new PyError("ValueError", `correlation between ${a} and ${b} is ${rho}, outside [-1, 1]`);
    target[index.get(a)][index.get(b)] = rho;
    target[index.get(b)][index.get(a)] = rho;
  }
  // np.allclose(target, eye): nothing to do.
  const identity = target.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) <= 1e-8 + 1e-5 * (i === j ? 1 : 0)));
  if (identity) return;
  const scores = target.map((row, i) => row.map((rho, j) => (i === j ? 1.0 : 2.0 * Math.sin((Math.PI * rho) / 6.0))));
  cholesky(scores);
}

/* LAPACK's test: a pivot that is not positive means the matrix is not positive definite. */
export function cholesky(a) {
  const n = a.length;
  const l = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j += 1) {
    let d = a[j][j];
    for (let k = 0; k < j; k += 1) d -= l[j][k] * l[j][k];
    if (!(d > 0)) {
      throw new PyError("ValueError", "the declared correlations are not mutually consistent — no set of inputs can have all of them at once.");
    }
    l[j][j] = Math.sqrt(d);
    for (let i = j + 1; i < n; i += 1) {
      let s = a[i][j];
      for (let k = 0; k < j; k += 1) s -= l[i][k] * l[j][k];
      l[i][j] = s / l[j][j];
    }
  }
  return l;
}
