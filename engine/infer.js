/*
 * What a formula says about the units of names that do not exist yet, and what it produces.
 *
 * The builder lets a formula name nodes nobody has defined. Each becomes a node *to define*, and
 * where the formula fixes its unit the builder says so, following the design's rules:
 *
 *   - added to, subtracted from, or compared in min/max with something of known unit: that unit;
 *   - an exponent, or inside log or exp: a pure number;
 *   - the base of a power that is not a whole number: a pure number (growth, not terabytes);
 *   - the one unknown left in a product or quotient: solved against the unit the node declares.
 *
 * A name the formula does not pin down gets no unit here, and the builder asks for one when the
 * node is defined. Nothing here is a verdict on the file: that is the engine's unit pass, which
 * runs once every name is defined. This is the feedback while a formula is being typed.
 */

import { refs } from "./formula.js";
import { PyError } from "./python.js";
import { Quantities, plain, quantity } from "./quantity.js";
import { EvaluationError } from "./evaluate.js";

const NONE = {};

/* A units container as a unit string the registry reads back as the same container. */
export function formatUnits(units) {
  const entries = Object.entries(units).filter(([, e]) => e !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return "dimensionless";
  const part = ([name, e]) => (Math.abs(e) === 1 ? name : `${name}**${Math.abs(e)}`);
  const top = entries.filter(([, e]) => e > 0).map(part);
  const bottom = entries.filter(([, e]) => e < 0).map(part);
  return `${top.length ? top.join("*") : "1"}${bottom.map((b) => `/${b}`).join("")}`;
}

function scale(units, factor) {
  const out = {};
  for (const [k, e] of Object.entries(units)) out[k] = e * factor;
  return out;
}

function merge(a, b, sign) {
  const out = { ...a };
  for (const [k, e] of Object.entries(b)) {
    const next = (out[k] ?? 0) + sign * e;
    if (next === 0) delete out[k];
    else out[k] = next;
  }
  return out;
}

/* A product or quotient as its factors, each with the power it enters with. */
function factors(tree, power = 1, out = []) {
  if (tree.op === "*") {
    factors(tree.args[0], power, out);
    factors(tree.args[1], power, out);
  } else if (tree.op === "/") {
    factors(tree.args[0], power, out);
    factors(tree.args[1], -power, out);
  } else out.push([tree, power]);
  return out;
}

/*
 * Infer units for the names in `fresh`.
 *
 *   known   Map name -> units container, for names that exist
 *   target  the container the whole formula must produce, or null
 *
 * Returns Map name -> { units, text } for each fresh name the formula pins down. `text` is a unit
 * string: the one a known node or the target was written in when the unit was copied from it.
 */
export function inferUnits(tree, { known, fresh, target = null, targetText = null }) {
  const inferred = new Map();
  const unitOf = (node) => {
    switch (node.op) {
      case "const":
        return { units: NONE, text: "dimensionless" };
      case "ref":
        if (known.has(node.name)) return known.get(node.name);
        return inferred.get(node.name) ?? null;
      case "neg":
        return unitOf(node.args[0]);
      case "+":
      case "-":
        return unitOf(node.args[0]) ?? unitOf(node.args[1]);
      case "call": {
        if (node.fn === "log" || node.fn === "exp") return { units: NONE, text: "dimensionless" };
        if (node.fn === "min" || node.fn === "max") {
          for (const arg of node.args) {
            const u = unitOf(arg);
            if (u) return u;
          }
          return null;
        }
        const inner = node.args[0] ? unitOf(node.args[0]) : null;
        if (!inner) return null;
        if (node.fn === "sqrt") return { units: scale(inner.units, 0.5), text: null };
        return inner;
      }
      case "**": {
        const base = unitOf(node.args[0]);
        if (!base) return null;
        if (!Object.keys(base.units).length) return { units: NONE, text: "dimensionless" };
        const exponent = node.args[1];
        if (exponent.op === "const") return { units: scale(base.units, exponent.value), text: null };
        return null;
      }
      default: {
        let units = NONE;
        for (const [term, power] of factors(node)) {
          const u = unitOf(term);
          if (!u) return null;
          units = merge(units, u.units, power);
        }
        return { units, text: null };
      }
    }
  };

  const pin = (name, want) => {
    if (!fresh.has(name) || inferred.has(name) || !want) return false;
    inferred.set(name, { units: want.units, text: want.text ?? formatUnits(want.units) });
    return true;
  };

  const solve = (node, want) => {
    switch (node.op) {
      case "const":
        return false;
      case "ref":
        return pin(node.name, want);
      case "neg":
        return solve(node.args[0], want);
      case "+":
      case "-": {
        const w = unitOf(node.args[0]) ?? unitOf(node.args[1]) ?? want;
        return solve(node.args[0], w) | solve(node.args[1], w);
      }
      case "call": {
        if (node.fn === "min" || node.fn === "max") {
          const w = node.args.map(unitOf).find(Boolean) ?? want;
          return node.args.reduce((changed, arg) => solve(arg, w) | changed, false);
        }
        const dimensionless = { units: NONE, text: "dimensionless" };
        if (node.fn === "log" || node.fn === "exp") return node.args.reduce((c, arg) => solve(arg, dimensionless) | c, false);
        if (!node.args[0]) return false;
        if (node.fn === "sqrt") return solve(node.args[0], want ? { units: scale(want.units, 2), text: null } : null);
        return solve(node.args[0], want);
      }
      case "**": {
        const dimensionless = { units: NONE, text: "dimensionless" };
        let changed = solve(node.args[1], dimensionless);
        const exponent = node.args[1];
        if (exponent.op === "const" && Number.isInteger(exponent.value) && exponent.value !== 0) {
          changed = solve(node.args[0], want ? { units: scale(want.units, 1 / exponent.value), text: null } : null) | changed;
        } else if (!(exponent.op === "const" && exponent.value === 0)) {
          changed = solve(node.args[0], dimensionless) | changed;
        }
        return changed;
      }
      default: {
        const terms = factors(node);
        let changed = false;
        for (const [term] of terms) if (term.op !== "ref" && term.op !== "const") changed = solve(term, null) | changed;
        const unknown = terms.filter(([term]) => !unitOf(term));
        if (unknown.length === 1 && want) {
          const [term, power] = unknown[0];
          let rest = NONE;
          for (const [other, p] of terms) if (other !== term) rest = merge(rest, unitOf(other).units, p);
          const needed = scale(merge(want.units, rest, -1), 1 / power);
          changed = solve(term, { units: needed, text: null }) | changed;
        }
        return changed;
      }
    }
  };

  const want = target ? { units: target, text: targetText } : null;
  // A few passes: a unit found in one place can pin another name elsewhere in the formula.
  for (let pass = 0; pass < 8 && solve(tree, want); pass += 1);
  return inferred;
}

/*
 * The unit a formula produces, given units (and, where known, magnitudes) for every name in it,
 * by the engine's own quantity rules. Returns { units } or { error }.
 */
export function producedUnits(tree, { registry, units, magnitudes = new Map() }) {
  const q = new Quantities(registry);
  const lookup = new Map();
  for (const [name, container] of units) lookup.set(name, quantity(magnitudes.get(name) ?? 0.37, container));
  const walkUnits = (node) => {
    switch (node.op) {
      case "const":
        return plain(node.value);
      case "ref":
        if (!lookup.has(node.name)) throw new EvaluationError(`'${node.name}' has no unit yet`);
        return lookup.get(node.name);
      case "neg":
        return q.negate(walkUnits(node.args[0]));
      case "call":
        return q.call(node.fn, node.args.map(walkUnits));
      default: {
        const a = walkUnits(node.args[0]);
        const b = walkUnits(node.args[1]);
        if (node.op === "+") return q.add(a, b);
        if (node.op === "-") return q.add(a, b, true);
        if (node.op === "*") return q.multiply(a, b);
        if (node.op === "/") return q.divide(a, b);
        return q.power(a, b);
      }
    }
  };
  try {
    return { units: walkUnits(tree).units ?? {} };
  } catch (error) {
    if (error instanceof PyError || error instanceof EvaluationError) return { error: error.message };
    throw error;
  }
}

export { refs };
