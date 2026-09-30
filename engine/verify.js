/*
 * The build checks: scripts/verify-models.py's rules for a model file, in its order.
 *
 * Rule 0 (the dsl version and the currency), eight rules, and the scenario checks. The last thing
 * the script does, check_stamps, is about the book's own stamped results being current and says
 * nothing about a model file, so it is not here (PLAN.md).
 *
 * Where the book's verifier still falls over rather than reporting (a correlation that is not a
 * mapping), this stops at the same point and says so, keeping what was found before it, as the
 * book's run does.
 */

import { checkScenario, checkUnits, SHAPES } from "./evaluate.js";
import { ancestors, classification, DECIDED_BY, isConditional, loadScenario, ofKind, PROVENANCE_KINDS } from "./model.js";
import { PyError, get, isDict, isInt, repr, sorted, str, strip, truthy } from "./python.js";

/* A `fact` has to point at something. Any of these in the source counts as pointing. */
export const CITATION_MARKERS = ["bench/results/", ".json", ".yaml", "definition", "invoice", "@", "http"];

export class VerifierCrash extends Error {}

const RULES = {
  "dsl.not-declared": "0",
  "currency.unknown": "0",
  "currency.another": "0",
  "units.does-not-typecheck": "1",
  "units.declared-vs-produced": "1",
  "units.mixed-operands": "1",
  "units.rounds-in-wrong-unit": "1",
  "input.decided": "2",
  "input.provenance-kind": "2",
  "input.empty-source": "2",
  "input.shape-not-named": "2",
  "input.no-one-shape": "2",
  "input.fact-cites-nothing": "3",
  "measured.no-result": "4",
  "measured.no-summary-value": "4",
  "measured.unit-differs": "4",
  "measured.no-uncertainty": "5",
  "ceiling.no-headroom": "6",
  "ceiling.no-reason": "6",
  "correlation.not-varying": "2",
  "correlation.rho": "2",
  "correlation.no-reason": "2",
  "shape.feeds-no-output": "7",
  "shape.no-outputs": "7",
  "classification.measured-without-ceiling": "8",
  "scenario.does-not-load": "scenarios",
  "scenario.unknown-node": "scenarios",
  "scenario.overrides-derived": "scenarios",
  "scenario.does-not-evaluate": "scenarios",
};

const problem = (code, fields = {}) => ({ code, rule: RULES[code], node: null, part: null, ...fields });

/* check_model */
export function checkModel(model, registry, problems, units = checkUnits(model, registry)) {
  // 0 -- which rules the file is written against, and which money it counts in
  if (model.dsl === null) problems.push(problem("dsl.not-declared"));
  if (!registry.currencies.includes(model.currency)) problems.push(problem("currency.unknown"));
  const own = `[currency_${model.currency.toLowerCase()}]`;
  // What the model answers in is its own currency; a price quoted in another is converted by a rate.
  for (const name of model.outputs) {
    if (!model.nodes.has(name)) continue;
    const { dimensionality } = registry.describe(registry.parse(model.nodes.get(name).unit));
    if (Object.keys(dimensionality).some((d) => d.startsWith("[currency_") && d !== own)) {
      problems.push(problem("currency.another", { node: name }));
    }
  }

  // 1 -- units
  for (const p of units.problems) problems.push(problem(p.code, { node: p.node, part: p.part, detail: p.detail }));

  for (const name of sorted(model.nodes.keys())) {
    const node = model.nodes.get(name);

    // 2, 3 -- provenance
    if (node.kind === "input") {
      if (!DECIDED_BY.includes(node.decided)) problems.push(problem("input.decided", { node: name }));
      const { kind, source } = node.provenance;
      if (!PROVENANCE_KINDS.includes(kind)) problems.push(problem("input.provenance-kind", { node: name }));
      else if (!strip(source)) problems.push(problem("input.empty-source", { node: name }));
      else if (node.distribution !== null && namesNot(node, name, source, problems)) {
        problems.push(problem("input.shape-not-named", { node: name }));
      } else if (kind === "fact" && !CITATION_MARKERS.some((marker) => source.includes(marker))) {
        problems.push(problem("input.fact-cites-nothing", { node: name }));
      }
    }

    // 4, 5 -- measured constants
    if (node.kind === "measured") {
      if (!strip(node.result)) problems.push(problem("measured.no-result", { node: name }));
      else if (node.measurement !== null) {
        const payload = node.measurement;
        const summary = payload.summary ?? {};
        if (!Object.hasOwn(summary, "value")) problems.push(problem("measured.no-summary-value", { node: name }));
        else if (!(Number(summary.sd ?? 0) > 0)) problems.push(problem("measured.no-uncertainty", { node: name }));
        const unit = payload.units?.value;
        if (unit && !sameUnit(registry, unit, node.unit)) problems.push(problem("measured.unit-differs", { node: name }));
      }
    }

    // 6 -- ceilings
    if (node.kind === "ceiling") {
      if (!strip(node.headroomText)) problems.push(problem("ceiling.no-headroom", { node: name }));
      if (!strip(node.because)) problems.push(problem("ceiling.no-reason", { node: name }));
    }
  }

  // 2 (continued) -- a pair said to move together names two quantities that vary, says how
  // strongly, and gives its reason
  for (const pair of model.correlations) {
    if (!isDict(pair)) throw new VerifierCrash(`verify-models.py falls over on a correlation that is not a mapping: ${repr(pair)}`);
    for (const side of ["a", "b"]) {
      const named = get(pair, side, null);
      const node = model.nodes.get(str(named));
      if (!(node?.kind === "measured" || (node?.kind === "input" && node.distribution !== null))) {
        // The book's message quotes the name; the conformance suite reads a quoted name as the node.
        const quoted = typeof named === "string" && !named.includes("'");
        problems.push(problem("correlation.not-varying", quoted ? { node: named } : {}));
      }
    }
    const rho = get(pair, "rho", null);
    const numeric = typeof rho === "number" ? rho : isInt(rho) ? Number(rho.value) : null;
    if (numeric === null || !(numeric >= -1 && numeric <= 1)) problems.push(problem("correlation.rho"));
    const because = get(pair, "because", null);
    if (!strip(str(truthy(because) ? because : ""))) problems.push(problem("correlation.no-reason"));
  }

  // 7 -- shape
  const reachable = new Set();
  for (const output of model.outputs) {
    reachable.add(output);
    for (const a of ancestors(model, output)) reachable.add(a);
  }
  for (const orphan of sorted([...model.nodes.keys()].filter((n) => !reachable.has(n)))) {
    problems.push(problem("shape.feeds-no-output", { node: orphan }));
  }
  if (!model.outputs.length) problems.push(problem("shape.no-outputs"));

  // 8 -- the distinction
  if (isConditional(model) && !ofKind(model, "ceiling").length) problems.push(problem("classification.measured-without-ceiling"));
}

/*
 * Whether an uncertain input's source fails to name its own shape, as a word: "lognormal" does
 * not name "normal". An input without exactly one shape is reported instead (_one_shape), and then
 * the fact check still runs, as the book's elif chain does.
 */
function namesNot(node, name, source, problems) {
  const shape = declaredShape(node.distribution);
  if (shape === null) {
    problems.push(problem("input.no-one-shape", { node: name }));
    return false;
  }
  return !new RegExp(`(?<![\\p{L}\\p{N}_])${shape}(?![\\p{L}\\p{N}_])`, "u").test(source.toLowerCase());
}

/*
 * mc.one_shape as the verifier calls it: the one shape a declaration names, or null where it
 * raises. Only what one_shape itself checks; a shape with the wrong parameters still has a shape.
 */
function declaredShape(spec) {
  if (spec === null || typeof spec === "number" || typeof spec === "boolean" || isInt(spec)) return null;
  let keys;
  if (isDict(spec)) keys = [...spec.keys()];
  else if (Array.isArray(spec)) {
    if (spec.some((k) => Array.isArray(k) || isDict(k))) return null; // unhashable: `in SHAPES` raises
    keys = spec;
  } else if (typeof spec === "string") keys = [...spec];
  else return null;
  const declared = keys.filter((k) => typeof k === "string" && SHAPES.includes(k));
  if (declared.length !== 1 || !isDict(spec)) return null; // a list or a string cannot be indexed by name
  const parameters = spec.get(declared[0]);
  if (isDict(parameters) || parameters === "") return declared[0];
  if (Array.isArray(parameters)) {
    const pairs = parameters.every((item) => (Array.isArray(item) || typeof item === "string" ? item.length === 2 : isDict(item) && item.size === 2));
    const hashable = parameters.every((item) => !Array.isArray(item?.[0]) && !isDict(item?.[0]));
    return pairs && hashable ? declared[0] : null;
  }
  return null;
}

/* Two spellings of one unit (terabyte and TB) are the same unit; one that does not parse is compared as text. */
function sameUnit(registry, a, b) {
  try {
    const x = registry.parse(String(a));
    const y = registry.parse(String(b));
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].every((k) => x[k] === y[k]);
  } catch {
    return a === b;
  }
}

/* check_scenarios: every scenario file, sorted by name; each override names a real input. */
export function checkScenarios(model, scenarioFiles, units, problems) {
  const scenarios = [];
  for (const [path, text] of scenarioFiles) {
    try {
      scenarios.push(loadScenario(text, path));
    } catch (error) {
      // The book reports a ModelError and stops checking scenarios; anything else, it falls over on.
      if (error?.code) {
        problems.push(problem("scenario.does-not-load", { detail: error.message }));
        return;
      }
      throw new VerifierCrash(`verify-models.py falls over reading ${path}: ${error.message}`);
    }
  }
  for (const scenario of scenarios) {
    for (const name of sorted(scenario.overrides.keys())) {
      if (!model.nodes.has(name)) problems.push(problem("scenario.unknown-node", { node: name, scenario: scenario.name }));
      else if (model.nodes.get(name).kind === "derived") {
        problems.push(problem("scenario.overrides-derived", { node: name, scenario: scenario.name }));
      }
    }
    try {
      checkScenario(model, scenario, units);
    } catch (error) {
      if (error instanceof VerifierCrash) throw error;
      if (!(error instanceof PyError) && !error.cause) throw error;
      problems.push(problem("scenario.does-not-evaluate", { scenario: scenario.name, cause: error.cause ?? "arithmetic", detail: error.message }));
    }
  }
}

/* Both, as the book's run does them, with a crash recorded rather than thrown. */
export function verify(model, registry, scenarioFiles) {
  const problems = [];
  const units = checkUnits(model, registry);
  let crashed = null;
  try {
    checkModel(model, registry, problems, units);
    checkScenarios(model, scenarioFiles, units, problems);
  } catch (error) {
    if (!(error instanceof VerifierCrash)) throw error;
    crashed = { message: error.message };
  }
  return { ok: !problems.length && !crashed, problems, crashed, units, classification: classification(model) };
}
