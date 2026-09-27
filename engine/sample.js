/*
 * Sampling a model: this repository's own implementation of the book's method.
 *
 * The book (sizing/mc.py, sizing/evaluate.py) samples every input with a shape by inverse
 * transform (draw a percentile uniformly, ask the shape what value sits there), makes the inputs
 * that move together do so by Iman and Conover's method, and pushes the draws through the same
 * formulas as the point. This does the same, with the same percentile functions and the same
 * reordering, and its own random stream:
 *
 *   - xoshiro128** (Blackman and Vigna, "Scrambled linear pseudorandom number generators", ACM
 *     Transactions on Mathematical Software 47(4), 2021), seeded through splitmix32, giving
 *     53-bit uniforms. The book uses numpy's PCG64. The two streams differ, so the builder is
 *     held to the book by distribution, not by draw (conformance/fixtures/sampling/).
 *   - Iman and Conover's method (R. L. Iman and W. J. Conover, "A distribution-free approach to
 *     inducing rank correlation among input variables", Communications in Statistics:
 *     Simulation and Computation 11(3), 1982), which the book cites as @imanconover1982: a
 *     reference set of normal scores, shaped by Cholesky factors to the rank correlation wanted,
 *     and each input's draws reordered to follow it. Only the order changes, so every input keeps
 *     exactly the shape it was given.
 *
 * The arithmetic after drawing follows numpy's rules, as the book's does: a division by zero or
 * a logarithm of a negative gives inf or nan rather than stopping, and a node whose draws are not
 * all finite is what the book's sampler then refuses (evaluate.checkScenario, cause "sampling").
 */

import { checkShape, normalPpf, oneShape, point, ppf, sampledInputs, useSampler } from "./evaluate.js";
import { blocked, measuredSd, measuredValue } from "./model.js";
import { PyError, float, get } from "./python.js";

// -- the random stream ---------------------------------------------------------------------------

function splitmix32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/* A seeded generator of uniforms strictly inside (0, 1), with 53 bits each. */
export function generator(seed) {
  const mix = splitmix32(Number(BigInt.asUintN(32, BigInt(seed))) ^ Number(BigInt.asUintN(32, BigInt(seed) >> 32n)));
  const s = new Uint32Array([mix(), mix(), mix(), mix()]);
  if (!(s[0] | s[1] | s[2] | s[3])) s[0] = 1;
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const next = () => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  };
  return {
    uniform() {
      const high = next() >>> 5; // 27 bits
      const low = next() >>> 6; // 26 bits
      return (high * 67108864 + low + 0.5) / 9007199254740992;
    },
    /* A whole number in [0, n), without the bias of a plain modulus. */
    below(n) {
      const limit = Math.floor(4294967296 / n) * n;
      let x;
      do x = next(); while (x >= limit);
      return x % n;
    },
  };
}

// -- drawing ---------------------------------------------------------------------------------------

function drawShape(spec, n, rng) {
  const [shape, p] = oneShape(spec);
  checkShape(shape, p);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = ppfUnchecked(shape, p, rng.uniform());
  return out;
}

/* ppf without re-checking the shape on every draw; triangular with both branches as numpy has them. */
function ppfUnchecked(shape, p, u) {
  if (shape === "triangular") {
    if (p.maximum === p.minimum) return p.minimum;
    const width = p.maximum - p.minimum;
    const atMode = (p.likely - p.minimum) / width;
    return u < atMode ? p.minimum + Math.sqrt(u * width * (p.likely - p.minimum)) : p.maximum - Math.sqrt((1.0 - u) * width * (p.maximum - p.likely));
  }
  return ppf(shape, p, u);
}

/*
 * The order that sorts x, by a least-significant-digit radix sort on each value's single-precision
 * bits: linear in n, where a comparison sort of 100,000 indices is most of a second. Two scores
 * closer than single precision can tell apart keep their original order. That changes which of
 * two nearly equal draws goes where, and nothing about the distribution, which is all the builder
 * is held to (the book's own order between them is numpy's, and different again).
 */
export function argsort(x) {
  const n = x.length;
  const bits = new Uint32Array(new Float32Array(x).buffer);
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    const b = bits[i];
    keys[i] = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
  }
  let order = new Uint32Array(n);
  let spare = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  const counts = new Uint32Array(257);
  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < n; i += 1) counts[((keys[order[i]] >>> shift) & 255) + 1] += 1;
    for (let d = 1; d < 257; d += 1) counts[d] += counts[d - 1];
    for (let i = 0; i < n; i += 1) spare[counts[(keys[order[i]] >>> shift) & 255]++] = order[i];
    [order, spare] = [spare, order];
  }
  return order;
}

// -- inputs that move together: Iman and Conover ---------------------------------------------------

function cholesky(a) {
  const n = a.length;
  const l = Array.from({ length: n }, () => new Float64Array(n));
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

/* mc.correlation_matrix: the pairs a model declared, zero everywhere else. */
export function correlationMatrix(names, pairs) {
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
  return target;
}

/*
 * mc.correlate: reorder each column so the ranks follow the correlation wanted. The rank
 * correlation a model declares is converted into the score correlation that produces it
 * (2 sin(pi rho / 6)), as the book does, so a declared 0.8 comes out 0.8 and not 0.785.
 */
export function correlate(columns, target, rng) {
  const k = columns.length;
  if (!k) return columns;
  const n = columns[0].length;
  const identity = target.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) <= 1e-8 + 1e-5 * (i === j ? 1 : 0)));
  if (identity) return columns;

  const scores = new Float64Array(n);
  for (let i = 0; i < n; i += 1) scores[i] = normalPpf((i + 1) / (n + 1));
  const reference = columns.map(() => {
    const c = Float64Array.from(scores);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = rng.below(i + 1);
      const t = c[i];
      c[i] = c[j];
      c[j] = t;
    }
    return c;
  });

  const wantedScores = target.map((row, i) => row.map((rho, j) => (i === j ? 1 : 2 * Math.sin((Math.PI * rho) / 6))));
  const wanted = cholesky(wantedScores);
  // The reference set's own correlation, which is near but not exactly the identity.
  const centred = reference.map((c) => {
    let mean = 0;
    for (let r = 0; r < n; r += 1) mean += c[r];
    mean /= n;
    const out = new Float64Array(n);
    for (let r = 0; r < n; r += 1) out[r] = c[r] - mean;
    return out;
  });
  const cov = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i += 1) {
    const x = centred[i];
    for (let j = i; j < k; j += 1) {
      const y = centred[j];
      let s = 0;
      for (let r = 0; r < n; r += 1) s += x[r] * y[r];
      cov[i][j] = s;
      cov[j][i] = s;
    }
  }
  const corr = cov.map((row, i) => Array.from(row, (v, j) => v / Math.sqrt(cov[i][i] * cov[j][j])));
  const have = cholesky(corr);
  // M = have⁻¹ · wanted, by forward substitution; shaped = reference · Mᵀ.
  const m = Array.from({ length: k }, () => new Float64Array(k));
  for (let col = 0; col < k; col += 1) {
    for (let i = 0; i < k; i += 1) {
      let s = wanted[i][col];
      for (let j = 0; j < i; j += 1) s -= have[i][j] * m[j][col];
      m[i][col] = s / have[i][i];
    }
  }
  const out = [];
  for (let j = 0; j < k; j += 1) {
    const shaped = new Float64Array(n);
    for (let c = 0; c < k; c += 1) {
      const w = m[j][c];
      if (w === 0) continue;
      const col = reference[c];
      for (let r = 0; r < n; r += 1) shaped[r] += col[r] * w;
    }
    // The row with the k-th smallest shaped score gets the k-th smallest value.
    const order = argsort(shaped);
    const values = Float64Array.from(columns[j]).sort();
    const reordered = new Float64Array(n);
    for (let rank = 0; rank < n; rank += 1) reordered[order[rank]] = values[rank];
    out.push(reordered);
  }
  return out;
}

// -- pushing the draws through the formulas, by numpy's rules -----------------------------------------

/* A scalar function applied element by element, as numpy broadcasts it over scalars and arrays. */
function lift(fn) {
  return (...args) => {
    const n = args.find((a) => a instanceof Float64Array)?.length;
    if (n === undefined) return fn(...args);
    const out = new Float64Array(n);
    const row = new Array(args.length);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < args.length; j += 1) row[j] = args[j] instanceof Float64Array ? args[j][i] : args[j];
      out[i] = fn(...row);
    }
    return out;
  };
}

function unary(fn) {
  return (a) => {
    if (!(a instanceof Float64Array)) return fn(a);
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i += 1) out[i] = fn(a[i]);
    return out;
  };
}

/* One loop per mix of array and scalar, so each stays a tight loop the engine can inline. */
function binary(fn) {
  return (a, b) => {
    const aa = a instanceof Float64Array;
    const bb = b instanceof Float64Array;
    if (!aa && !bb) return fn(a, b);
    const n = aa ? a.length : b.length;
    const out = new Float64Array(n);
    if (aa && bb) for (let i = 0; i < n; i += 1) out[i] = fn(a[i], b[i]);
    else if (aa) for (let i = 0; i < n; i += 1) out[i] = fn(a[i], b);
    else for (let i = 0; i < n; i += 1) out[i] = fn(a, b[i]);
    return out;
  };
}

const npMin = (...xs) => xs.reduce((a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b)));
const npMax = (...xs) => xs.reduce((a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b)));
const pairMin = binary((a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b)));
const pairMax = binary((a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b)));
const ARRAY = {
  // functools.reduce(np.minimum, args), as the book's ARRAY_FUNCTIONS does it.
  min: (...xs) => (xs.length ? xs.reduce((a, b) => pairMin(a, b)) : lift(npMin)()),
  max: (...xs) => (xs.length ? xs.reduce((a, b) => pairMax(a, b)) : lift(npMax)()),
  ceil: unary(Math.ceil),
  floor: unary(Math.floor),
  sqrt: unary(Math.sqrt),
  log: unary(Math.log),
  exp: unary(Math.exp),
};
const OPS = {
  "+": binary((a, b) => a + b),
  "-": binary((a, b) => a - b),
  "*": binary((a, b) => a * b),
  "/": binary((a, b) => a / b),
  "**": binary((a, b) => a ** b),
  neg: unary((a) => -a),
};

function arrayWalk(tree, values) {
  switch (tree.op) {
    case "const":
      return tree.value;
    case "ref":
      return values.get(tree.name);
    case "neg":
      return OPS.neg(arrayWalk(tree.args[0], values));
    case "call":
      return ARRAY[tree.fn](...tree.args.map((a) => arrayWalk(a, values)));
    default:
      return OPS[tree.op](arrayWalk(tree.args[0], values), arrayWalk(tree.args[1], values));
  }
}

function scale(x, factor) {
  if (!(x instanceof Float64Array)) return x * factor;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i += 1) out[i] = x[i] * factor;
  return out;
}

// -- reading the answer ---------------------------------------------------------------------------

/* numpy.percentile's default: linear interpolation between the two nearest ranks. */
function percentile(sortedValues, p) {
  const n = sortedValues.length;
  const at = (p / 100) * (n - 1);
  const lo = Math.floor(at);
  const hi = Math.min(n - 1, lo + 1);
  const frac = at - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

export function summarise(x) {
  const s = Float64Array.from(x).sort();
  let mean = 0;
  for (let i = 0; i < x.length; i += 1) mean += x[i];
  mean /= x.length;
  let ss = 0;
  for (let i = 0; i < x.length; i += 1) ss += (x[i] - mean) ** 2;
  return {
    min: s[0],
    p5: percentile(s, 5),
    p25: percentile(s, 25),
    p50: percentile(s, 50),
    p75: percentile(s, 75),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    mean,
    sd: x.length > 1 ? Math.sqrt(ss / (x.length - 1)) : 0,
  };
}

/*
 * evaluate.evaluate, without the histograms: the point, then every input with a shape drawn,
 * the pairs that move together reordered, and the draws pushed through every formula.
 *
 * Returns { point, samples: Map name -> Float64Array for every node that varies, summaries,
 * ceilings: name -> { value, allowed, p_over_allowed, p_over_limit }, nonFinite: [names] }.
 */
export function sample(model, scenario, factors, { samples = scenario.samples, seed = scenario.seed, summarise: wanted = null } = {}) {
  const stuck = blocked(model);
  const values = point(model, scenario, factors, stuck);
  const rng = generator(seed);
  const n = samples;
  const uncertain = sampledInputs(model).filter((name) => !stuck.has(name) && !scenario.overrides.has(name));
  let columns = uncertain.map((name) => {
    const node = model.nodes.get(name);
    if (node.kind === "input") return drawShape(node.distribution, n, rng);
    const mean = measuredValue(node);
    const sd = measuredSd(node);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) out[i] = mean + sd * normalPpf(rng.uniform());
    return out;
  });
  if (columns.length) {
    const drawn = new Set(uncertain);
    const live = model.correlations.filter((c) => drawn.has(get(c, "a")) && drawn.has(get(c, "b")));
    if (live.length) columns = correlate(columns, correlationMatrix(uncertain, live), rng);
  }
  const drawnBy = new Map(uncertain.map((name, i) => [name, columns[i]]));

  const current = new Map();
  for (const name of model.order) {
    if (stuck.has(name)) continue;
    const node = model.nodes.get(name);
    if (drawnBy.has(name)) current.set(name, drawnBy.get(name));
    else if (node.kind === "derived") current.set(name, scale(arrayWalk(node.formula, current), factors.get(name)));
    else if (node.kind === "ceiling") current.set(name, scale(arrayWalk(node.of, current), factors.get(name)));
    else current.set(name, values.get(name));
  }

  const varying = new Map([...current].filter(([, v]) => v instanceof Float64Array));
  const nonFinite = [...varying].filter(([, v]) => v.some((x) => !Number.isFinite(x))).map(([name]) => name);
  const summaries = new Map();
  // Every varying node's summary unless only some are wanted: sorting each is most of the cost.
  for (const [name, v] of varying) if (!wanted || wanted.includes(name)) summaries.set(name, summarise(v));

  const ceilings = {};
  for (const node of model.nodes.values()) {
    if (node.kind !== "ceiling" || !varying.has(node.name)) continue;
    const limit = Number(arrayWalk(node.limit, values)) * (factors.get(`${node.name}.limit`) ?? 1);
    const headroom = Number(arrayWalk(node.headroom, values)) * (factors.get(`${node.name}.headroom`) ?? 1);
    const allowed = limit * (1 - headroom);
    const drawn = varying.get(node.name);
    let over = 0;
    let overLimit = 0;
    for (let i = 0; i < n; i += 1) {
      if (drawn[i] > allowed) over += 1;
      if (drawn[i] > limit) overLimit += 1;
    }
    ceilings[node.name] = { value: values.get(node.name), allowed, p_over_allowed: over / n, p_over_limit: overLimit / n };
  }
  return { point: values, samples: varying, summaries, ceilings, nonFinite };
}

useSampler(sample);
