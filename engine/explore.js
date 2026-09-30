/*
 * Explore: the charts a model's reader draws from it, worked out by the model itself.
 *
 * Every chart here is the model evaluated at its point values with some inputs changed on top of
 * a scenario, the same evaluation the book's charts use (bench/run_seller.py's `at`):
 *
 *   - a sweep runs one input across a set of values and records answers, one line per case;
 *   - a crossing is where an answer meets a target (a break-even, a payback), found by
 *     bisecting on the model, not by reading it off a drawn line;
 *   - a boundary is the crossing traced across a second input, which splits a plane in two;
 *   - a breakdown splits an answer that is a sum into its terms, for each case.
 *
 * Nothing here chooses a number. The values an input is swept across come from the range its
 * file declares or from the reader; the cases come from scenario files or from values the reader
 * types; the target is the reader's (nought by default: a break-even).
 */

import { pointValueOfInput, real, walk } from "./evaluate.js";
import { ancestors, blocked, measuredValue } from "./model.js";

/*
 * The model at its point with some inputs changed, as evaluate.point works it out, but only for
 * the nodes asked for and what they rest on, and each on its own: a chart of the saving over the
 * years is not blanked at year nought because another answer divides by the horizon. A node that
 * cannot be worked out is simply absent.
 */
export function at(model, factors, overrides = new Map(), wanted = null) {
  const needed = wanted ? new Set(wanted.flatMap((n) => (model.nodes.has(n) ? [n, ...ancestors(model, n)] : []))) : null;
  const stuck = blocked(model);
  const values = new Map();
  const scenario = { overrides: new Map(overrides) };
  for (const name of model.order) {
    if ((needed && !needed.has(name)) || stuck.has(name)) continue;
    const node = model.nodes.get(name);
    try {
      let v;
      if (node.kind === "input") v = pointValueOfInput(node, scenario);
      else if (node.kind === "measured") v = scenario.overrides.has(name) ? scenario.overrides.get(name) : measuredValue(node);
      else v = real(walk(node.kind === "derived" ? node.formula : node.of, values)) * factors.get(name);
      if (typeof v === "number" && Number.isFinite(v)) values.set(name, v);
    } catch {
      // Cannot be worked out here: absent, and so is anything that needs it.
    }
  }
  return values;
}

const merged = (...maps) => new Map(maps.flatMap((m) => [...(m ?? [])]));

/* n values from low to high, evenly spaced, both ends included. */
export function spaced(low, high, n) {
  if (n < 2) return [low];
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? high : low + ((high - low) * i) / (n - 1)));
}

/*
 * Each output across the values of x, for each case.
 * cases: [{ key, label, overrides: Map }], each on top of `base` (a Map of overrides).
 */
export function sweep(model, factors, { base = new Map(), x, xs, outputs, cases = [{ key: "model", label: "", overrides: new Map() }] }) {
  const series = [];
  for (const c of cases) {
    const rows = xs.map((v) => at(model, factors, merged(base, c.overrides, new Map([[x, v]])), outputs));
    for (const output of outputs) {
      series.push({ key: c.key, label: c.label, output, ys: rows.map((r) => (r.has(output) ? r.get(output) : null)) });
    }
  }
  return { x, xs, series };
}

/*
 * Where an output meets a target as x runs from low to high: every sign change among `samples`
 * evenly spaced values, each narrowed by bisection on the model to a part in a trillion.
 */
export function crossings(model, factors, { base = new Map(), x, output, target = 0, low, high, samples = 201 }) {
  const f = (v) => {
    const y = at(model, factors, merged(base, new Map([[x, v]])), [output]).get(output);
    return Number.isFinite(y) ? y - target : null;
  };
  const xs = spaced(low, high, samples);
  const fs = xs.map(f);
  const out = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (fs[i] === 0) out.push(xs[i]);
    if (i + 1 >= xs.length || fs[i] === null || fs[i + 1] === null || fs[i] === 0 || fs[i + 1] === 0) continue;
    if (Math.sign(fs[i]) === Math.sign(fs[i + 1])) continue;
    let [a, b, fa] = [xs[i], xs[i + 1], fs[i]];
    for (let k = 0; k < 200 && Math.abs(b - a) > 1e-12 * Math.max(1, Math.abs(a)); k += 1) {
      const m = (a + b) / 2;
      const fm = f(m);
      if (fm === null) break;
      if (fm === 0) { a = b = m; break; }
      if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
    }
    out.push((a + b) / 2);
  }
  return out;
}

/*
 * The line across a plane where an output meets its target: for each value of y, the values of x
 * where it does. And which side of it each cell of a grid is on, for shading.
 */
export function boundary(model, factors, { base = new Map(), x, y, output, target = 0, xLow, xHigh, ys, samples = 201 }) {
  return ys.map((v) => ({
    y: v,
    xs: crossings(model, factors, { base: merged(base, new Map([[y, v]])), x, output, target, low: xLow, high: xHigh, samples }),
  }));
}

export function sides(model, factors, { base = new Map(), x, y, output, target = 0, xs, ys }) {
  return ys.map((vy) => xs.map((vx) => {
    const z = at(model, factors, merged(base, new Map([[x, vx], [y, vy]])), [output]).get(output);
    return Number.isFinite(z) ? Math.sign(z - target) : null;
  }));
}

/* An answer that is a sum, as its terms: a + b - c is [+a, +b, -c]. Anything else is one term. */
export function terms(tree, sign = 1) {
  if (tree.op === "+") return [...terms(tree.args[0], sign), ...terms(tree.args[1], sign)];
  if (tree.op === "-" && tree.args.length === 2) return [...terms(tree.args[0], sign), ...terms(tree.args[1], -sign)];
  return [{ sign, tree }];
}

/* Each term of a sum's value in each case, in the node's own unit, with the total. */
export function breakdown(model, factors, { base = new Map(), output, cases }) {
  const node = model.nodes.get(output);
  if (node?.kind !== "derived") return null;
  const parts = terms(node.formula);
  const factor = factors.get(output) ?? 1;
  return {
    output,
    parts,
    cases: cases.map((c) => {
      const values = at(model, factors, merged(base, c.overrides), [output]);
      if (!values.has(output)) return { key: c.key, label: c.label, values: null, total: null };
      const each = parts.map((p) => {
        try {
          return p.sign * real(walk(p.tree, values)) * factor;
        } catch {
          return null;
        }
      });
      return { key: c.key, label: c.label, values: each, total: values.get(output) ?? null };
    }),
  };
}
