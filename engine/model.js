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
  float,
  get,
  int,
  isDict,
  isInt,
  iterate,
  pyInt,
  repr,
  sorted,
  str,
  strip,
  truthy,
  typeName,
} from "./python.js";
import { UnitError } from "./units.js";
import { DuplicateKey, YamlError, readYaml } from "./yaml.js";

export const KINDS = ["input", "derived", "measured", "ceiling"];

/* The rules this engine reads, as sizing.dsl.DSL_VERSION; a model file says it on its first line. */
export const DSL_VERSION = 2;

/* The keys each place in a file may hold, as sizing/dsl.py lists them. Any other is refused. */
export const MODEL_KEYS = ["dsl", "model", "title", "description", "currency", "nodes", "outputs", "correlations"];
export const NODE_KEYS = {
  input: ["decided", "provenance", "value", "distribution", "range"],
  derived: ["formula"],
  measured: ["result"],
  ceiling: ["of", "limit", "headroom", "because"],
};
export const COMMON_NODE_KEYS = ["kind", "unit", "label", "note"];
export const PROVENANCE_KEYS = ["kind", "source"];
export const CORRELATION_KEYS = ["a", "b", "rho", "because"];
export const SCENARIO_KEYS = ["scenario", "title", "because", "overrides", "samples", "seed"];

/* How alike two words are, as difflib's ratio measures it: twice the matching characters over both lengths. */
function likeness(a, b) {
  const matching = (x, y) => {
    if (!x.length || !y.length) return 0;
    let best = { i: 0, j: 0, n: 0 };
    for (let i = 0; i < x.length; i += 1) {
      for (let j = 0; j < y.length; j += 1) {
        let n = 0;
        while (i + n < x.length && j + n < y.length && x[i + n] === y[j + n]) n += 1;
        if (n > best.n) best = { i, j, n };
      }
    }
    if (!best.n) return 0;
    return best.n + matching(x.slice(0, best.i), y.slice(0, best.j)) + matching(x.slice(best.i + best.n), y.slice(best.j + best.n));
  };
  return (2 * matching(a, b)) / (a.length + b.length);
}

/* dsl._known: refuse a key the loader does not read, naming the nearest one it does. */
function known(mapping, allowed, where, node = undefined) {
  for (const key of mapping.keys()) {
    if (typeof key === "string" && allowed.includes(key)) continue;
    const near = [...allowed].map((k) => [likeness(str(key), k), k]).filter(([r]) => r >= 0.6).sort((x, y) => y[0] - x[0])[0];
    throw new LoadError(
      "load.unknown-key",
      `${where}: ${repr(key)} is not a key this file may hold${near ? `; did you mean '${near[1]}'?` : "."} Expected one of ${allowed.join(", ")}.`,
      node === undefined ? {} : { node },
    );
  }
}
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

/* dsl.read_yaml: a model or scenario file's text as data, refusing a key written twice. */
export function readModelYaml(text, where) {
  try {
    return readYaml(text);
  } catch (error) {
    if (error instanceof DuplicateKey) throw new LoadError("load.duplicate-key", `${where}: ${error.message}`);
    throw error;
  }
}

/* dsl._text: a field as text, where one left empty (YAML's None) is the default. */
function textOf(mapping, key, fallback = "") {
  const value = get(mapping, key, null);
  return value === null ? fallback : str(value);
}

/* dsl._number: a number from the file, refusing a YAML boolean and anything that is not a number. */
function number(value, what, field, node = undefined) {
  if (typeof value === "boolean" || !(typeof value === "number" || isInt(value))) {
    throw new LoadError("load.not-a-number", `${what} is ${repr(value)}, which is not a number`, node === undefined ? { field } : { field, node });
  }
  return float(value);
}

/* Python's `value == 1`, for the version: 1, 1.0 and True all equal one. */
const isVersion = (value) => value === true || value === DSL_VERSION || (isInt(value) && value.value === BigInt(DSL_VERSION));

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
  known(spec, [...COMMON_NODE_KEYS, ...NODE_KEYS[kind]], at, name);
  const unit = strip(textOf(spec, "unit"));
  if (!unit) {
    throw new LoadError(
      "load.no-unit",
      `${at} declares no unit. A pure ratio is written \`dimensionless\`. A blank is refused because it could mean a pure ratio, or it could mean the unit was never decided (ch02).`,
      { node: name },
    );
  }
  try {
    registry.parse(unit);
  } catch (error) {
    if (error instanceof UnitError) {
      throw new LoadError(error.ratio ? "load.not-ratio-scale" : "load.unknown-unit", `${at} declares an unknown unit — ${error.message}`, { node: name });
    }
    throw error;
  }
  const common = { name, unit, label: get(spec, "label", null), note: get(spec, "note", null), kind };

  if (kind === "input") {
    const provenance = truthy(get(spec, "provenance", null)) ? spec.get("provenance") : new Map();
    if (isDict(provenance)) known(provenance, PROVENANCE_KEYS, `${at} provenance`, name);
    const distribution = get(spec, "distribution", null);
    if (isDict(distribution)) {
      for (const [shape, parameters] of distribution) {
        const given = truthy(parameters) ? parameters : new Map();
        if (!isDict(given)) throw new PyError("AttributeError", `'${typeName(given)}' object has no attribute 'items'`);
        for (const [parameter, value] of given) number(value, `${at}: ${str(shape)} ${str(parameter)}`, `${str(shape)} ${str(parameter)}`, name);
      }
    }
    const value = get(spec, "value", null);
    const numeric = value === null ? null : number(value, `${at}: value`, "value", name);
    const kindText = textOf(provenance, "kind");
    const source = textOf(provenance, "source");
    const range = get(spec, "range", null);
    return {
      ...common,
      value: numeric,
      distribution,
      provenance: { kind: kindText, source },
      slider: truthy(range) ? iterate(range).map((v) => number(v, `${at}: range`, "range", name)) : null,
      decided: textOf(spec, "decided"),
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
    because: textOf(spec, "because"),
    depends: new Set([...refs(of), ...refs(limit), ...refs(margin)]),
  };
}

/*
 * Load a model from its file text. `results` maps a result name to its stamped payload: the
 * book's measured constants, plus any a case brings. Throws LoadError (or YamlError, or a PyError
 * where the book falls over without a worded refusal).
 */
export function loadModel(text, { registry, results = {}, where = "model.yaml" } = {}) {
  const raw = readModelYaml(text, where);
  if (!isDict(raw)) throw new LoadError("load.not-a-mapping", `${where}: is not a mapping`);
  known(raw, MODEL_KEYS, where);
  const pairs = get(raw, "correlations", null);
  for (const pair of iterate(truthy(pairs) ? pairs : [])) if (isDict(pair)) known(pair, CORRELATION_KEYS, `${where}: a correlation`);
  if (raw.has("dsl") && !isVersion(raw.get("dsl"))) {
    throw new LoadError("load.dsl-version", `${where}: is written for dsl ${repr(raw.get("dsl"))}, and this toolkit reads dsl ${DSL_VERSION}`);
  }

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
    currency: textOf(raw, "currency", "USD"),
    dsl: get(raw, "dsl", null),
    nodes,
    outputs,
    correlations: iterate(get(raw, "correlations", [])),
    description: strip(textOf(raw, "description")),
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
export function loadScenario(source, where = "scenario.yaml") {
  const raw = readModelYaml(source, where);
  if (!isDict(raw)) throw new LoadError("load.not-a-mapping", `${where}: is not a mapping`);
  known(raw, SCENARIO_KEYS, where);
  const name = str(require(raw, "scenario", where));
  const given = get(raw, "overrides", null);
  const overrides = new Map();
  if (truthy(given)) {
    if (!isDict(given)) throw new PyError("AttributeError", `'${typeName(given)}' object has no attribute 'items'`);
    for (const [k, v] of given) overrides.set(str(k), number(v, `${where}: override ${repr(k)}`, `override ${repr(k)}`));
  }
  return {
    name,
    title: textOf(raw, "title", name),
    overrides,
    because: strip(textOf(raw, "because")),
    samples: int(number(get(raw, "samples", pyInt(100000n)), `${where}: samples`, "samples")),
    seed: int(number(get(raw, "seed", pyInt(20260916n)), `${where}: seed`, "seed")),
  };
}

export { YamlError, codePointCompare };
