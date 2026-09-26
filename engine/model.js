/*
 * A model file, loaded as sizing/dsl.py loads it.
 *
 * The loader refuses a file for structural reasons (an unknown kind, a formula that does not
 * parse, a name nothing defines, a loop) and loads everything else, however unfinished: a blank
 * source or a ceiling with no margin is for the build checks (verify.js) to report, all at once.
 * The refusals come in the book's order, because the first one is what the reader is told.
 */

import { FormulaError, parse as parseFormula, refs } from "./formula.js";
import {
  PyError,
  codePointCompare,
  contains,
  float,
  get,
  int,
  isDict,
  iterate,
  pyInt,
  sorted,
  str,
  strip,
  truthy,
  typeName,
} from "./python.js";
import { UnitError } from "./units.js";
import { YamlError, safeLoad } from "./yaml.js";

export const KINDS = ["input", "derived", "measured", "ceiling"];
export const PROVENANCE_KINDS = ["fact", "vendor_claim", "assumption"];
export const DECIDED_BY = ["you", "outside", "definition"];

/* A refusal: the code the conformance suite knows it by, and what it names. */
export class LoadError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

function require(mapping, key, where, node = undefined) {
  if (!mapping.has(key)) {
    const detail = node === undefined ? { field: key } : { field: key, node };
    throw new LoadError("load.missing-field", `${where}: missing required field '${key}'`, detail);
  }
  return mapping.get(key);
}

function formula(text, where, node) {
  try {
    return parseFormula(text, where);
  } catch (error) {
    if (error instanceof FormulaError) {
      const code = error.code;
      throw new LoadError(code, error.message, code === "load.malformed" ? {} : { node });
    }
    throw error;
  }
}

function nodeFrom(name, spec, where, registry, results) {
  const at = `${where}: node '${name}'`;
  if (!isDict(spec)) throw new LoadError("load.node-not-a-mapping", `${where}: node '${name}' is not a mapping`, { node: name });
  const kind = require(spec, "kind", at, name);
  if (Array.isArray(kind) || isDict(kind)) throw new PyError("TypeError", "unhashable type");
  if (!KINDS.includes(kind)) {
    throw new LoadError("load.unknown-kind", `${at} has kind ${str(kind)}; expected one of ${KINDS.join(", ")}`, { node: name });
  }
  const unit = str(require(spec, "unit", at, name));
  try {
    registry.parse(unit);
  } catch (error) {
    if (error instanceof UnitError) {
      throw new LoadError("load.unknown-unit", `${at} declares an unknown unit — ${error.message}`, { node: name });
    }
    throw error;
  }
  const common = { name, unit, label: get(spec, "label", null), note: get(spec, "note", null), kind };

  if (kind === "input") {
    const provenance = truthy(get(spec, "provenance", null)) ? spec.get("provenance") : new Map();
    const value = get(spec, "value", null);
    const range = get(spec, "range", null);
    return {
      ...common,
      value: value === null ? null : float(value),
      distribution: get(spec, "distribution", null),
      provenance: {
        kind: str(get(provenance, "kind", "")),
        source: str(get(provenance, "source", "")),
      },
      slider: truthy(range) ? iterate(range).map(float) : null,
      decided: str(get(spec, "decided", "")),
      depends: new Set(),
    };
  }

  if (kind === "derived") {
    const text = str(require(spec, "formula", at, name));
    const tree = formula(text, at, name);
    return { ...common, formula: tree, formulaText: text, depends: refs(tree) };
  }

  if (kind === "measured") {
    const result = str(require(spec, "result", at, name));
    const measurement = Object.hasOwn(results, result) ? results[result] : null;
    return { ...common, result, measurement, depends: new Set() };
  }

  const ofText = str(require(spec, "of", at, name));
  const limitText = str(require(spec, "limit", at, name));
  const headroom = get(spec, "headroom", null);
  const headroomText = headroom === null ? "" : str(headroom);
  const of = formula(ofText, at, name);
  const limit = formula(limitText, `${at} limit`, name);
  const margin = formula(headroomText || "0", `${at} headroom`, name);
  return {
    ...common,
    of,
    ofText,
    limit,
    limitText,
    headroom: margin,
    headroomText,
    because: str(get(spec, "because", "")),
    depends: new Set([...refs(of), ...refs(limit), ...refs(margin)]),
  };
}

/*
 * Load a model from its file text. `results` maps a result name to its stamped payload: the
 * book's measured constants, plus any a case brings. Throws LoadError (or YamlError, or a PyError
 * where the book falls over without a worded refusal).
 */
export function loadModel(text, { registry, results = {}, where = "model.yaml" } = {}) {
  const raw = safeLoad(text);
  if (!isDict(raw)) throw new LoadError("load.not-a-mapping", `${where}: is not a mapping`);

  const nodesSpec = require(raw, "nodes", where);
  if (!isDict(nodesSpec)) throw new PyError("AttributeError", `'${typeof nodesSpec}' object has no attribute 'items'`);
  const nodes = new Map();
  for (const [name, spec] of nodesSpec) {
    // Python would keep a non-string key; the book's formulas can only name strings.
    nodes.set(str(name), nodeFrom(str(name), spec, where, registry, results));
  }

  for (const node of nodes.values()) {
    for (const needed of sorted(node.depends)) {
      if (!nodes.has(needed)) {
        throw new LoadError(
          "load.unknown-reference",
          `${where}: node '${node.name}' refers to '${needed}', which this model does not define. Every quantity in a formula is a node, so that it has a unit and a provenance of its own.`,
          { node: node.name, ref: needed },
        );
      }
    }
  }

  const outputs = iterate(get(raw, "outputs", [])).map(str);
  for (const name of outputs) {
    if (!nodes.has(name)) {
      throw new LoadError("load.unknown-output", `${where}: declares an output '${name}' that is not a node`, { node: name });
    }
  }

  const modelName = str(require(raw, "model", where));
  const model = {
    name: modelName,
    title: str(get(raw, "title", raw.get("model"))),
    currency: str(get(raw, "currency", "USD")),
    nodes,
    outputs,
    correlations: iterate(get(raw, "correlations", [])),
    description: strip(str(get(raw, "description", ""))),
    raw,
  };
  model.order = order(model, where);
  return model;
}

/*
 * Every node, parents before children: Kahn's algorithm with the ready list kept sorted, exactly
 * as Model.order does it, so the two give the same order and not merely a valid one.
 */
export function order(model, where = model.name) {
  const pending = new Map([...model.nodes].map(([name, node]) => [name, new Set(node.depends)]));
  let ready = sorted([...pending].filter(([, needs]) => !needs.size).map(([name]) => name));
  const out = [];
  const placed = new Set();
  while (ready.length) {
    const name = ready.shift();
    out.push(name);
    placed.add(name);
    const newly = [];
    for (const [other, needs] of pending) {
      if (needs.has(name)) {
        needs.delete(name);
        if (!needs.size && !placed.has(other) && !ready.includes(other)) newly.push(other);
      }
    }
    ready = sorted([...ready, ...newly]);
  }
  if (out.length !== model.nodes.size) {
    const stuck = sorted([...model.nodes.keys()].filter((n) => !placed.has(n)));
    throw new LoadError(
      "load.cycle",
      `${where}: these nodes depend on each other in a loop, so none of them can be evaluated: ${stuck.join(", ")}`,
      { nodes: stuck },
    );
  }
  return out;
}

/* Everything that feeds a node, however far back. */
export function ancestors(model, name) {
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    for (const parent of model.nodes.get(stack.pop()).depends) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}

export const ofKind = (model, kind) => [...model.nodes.values()].filter((node) => node.kind === kind);

/* ch01's distinction, worked out from the node kinds and never set by hand. */
export function isConditional(model) {
  return ofKind(model, "measured").length > 0 || ofKind(model, "ceiling").length > 0;
}

export const classification = (model) => (isConditional(model) ? "conditional" : "definitional");

/* Measured nodes whose stamped result does not exist yet. */
export function unmeasured(model) {
  return sorted(ofKind(model, "measured").filter((node) => node.measurement === null).map((node) => node.name));
}

/* Every node that cannot be evaluated, and which unmeasured constants are why. */
export function blocked(model) {
  const missing = new Set(unmeasured(model));
  const out = new Map();
  if (!missing.size) return out;
  for (const name of model.order) {
    const causes = new Set();
    if (missing.has(name)) causes.add(name);
    for (const parent of model.nodes.get(name).depends) for (const cause of out.get(parent) ?? []) causes.add(cause);
    if (causes.size) out.set(name, sorted(causes));
  }
  return out;
}

/* A measured node's value and standard error, read as dsl.Measured reads them. */
export function measuredValue(node) {
  const summary = node.measurement?.summary;
  if (!summary || !Object.hasOwn(summary, "value")) throw new PyError("KeyError", "'value'");
  return float(summary.value);
}

export function measuredSd(node) {
  const summary = node.measurement?.summary ?? {};
  return float(Object.hasOwn(summary, "sd") ? summary.sd : 0);
}

/* A scenario file, as dsl.load_scenario reads it. */
export function loadScenario(text, where = "scenario.yaml") {
  const raw = safeLoad(text);
  if (raw === null) throw new PyError("TypeError", "argument of type 'NoneType' is not iterable");
  if (!contains(raw, "scenario")) {
    throw new LoadError("load.missing-field", `${where}: missing required field 'scenario'`, { field: "scenario" });
  }
  if (!isDict(raw)) throw new PyError("TypeError", "indices must be integers");
  const given = get(raw, "overrides", null);
  const overrides = new Map();
  if (truthy(given)) {
    if (!isDict(given)) throw new PyError("AttributeError", `'${typeName(given)}' object has no attribute 'items'`);
    for (const [k, v] of given) overrides.set(str(k), float(v));
  }
  return {
    name: str(raw.get("scenario")),
    title: str(get(raw, "title", raw.get("scenario"))),
    overrides,
    because: strip(str(get(raw, "because", ""))),
    samples: int(get(raw, "samples", pyInt(100000n))),
    seed: int(get(raw, "seed", pyInt(20260916n))),
  };
}

export { YamlError, codePointCompare };
