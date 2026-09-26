/*
 * The rules engine: the book's loader, unit checks, evaluator and build checks, in JavaScript.
 *
 * Held to the book's own toolkit by the conformance suite (conformance/, test/conformance.test.js):
 * for every case the book's Python was asked about, this must say the same thing, and CI fails if
 * it does not. The shapes returned here are the fixtures' own, described in conformance/README.md.
 *
 *   yaml.js      the file, read as PyYAML reads it
 *   units.js     unit strings, read as the book's Pint registry reads them
 *   formula.js   formulas, parsed and refused as sizing/expr.py does
 *   model.js     loading and its refusals, evaluation order, blocked chains, the classification
 *   quantity.js  Pint's quantity arithmetic, for the unit pass
 *   evaluate.js  the unit pass, the point, the ceiling report
 *   verify.js    scripts/verify-models.py's rules
 *   python.js    the Python behaviours the verdicts depend on
 */

import { FormulaError, parse as parseFormulaText } from "./formula.js";
import { ceilingReport, point } from "./evaluate.js";
import { blocked, classification, loadModel, loadScenario, LoadError, unmeasured } from "./model.js";
import { PyError, floatRepr, isDict, isInt } from "./python.js";
import { Registry, UnitError } from "./units.js";
import { verify } from "./verify.js";
import { documentFrom, scenarioDocumentFrom, writeModel, writeScenario } from "./write.js";
import { safeLoad, YamlError } from "./yaml.js";

/*
 * Everything the book's toolkit says about one model file and its scenarios.
 *
 *   files    { "model.yaml": text, "scenarios/<name>.yaml": text, ... }
 *   results  { <result name>: stamped payload }: the book's measured constants, plus any a case brings
 *   registry the unit table the book's Pint registry was reduced to (fixtures/units.json)
 *
 * Returns { load, verify, model, nodes, scenarios } in the conformance fixtures' shape.
 */
export function report(files, { results = {}, registry: table }) {
  const registry = registryFor(table);
  const scenarioFiles = Object.keys(files)
    .filter((path) => path.startsWith("scenarios/") && path.endsWith(".yaml"))
    .sort()
    .map((path) => [path, files[path]]);

  let model;
  try {
    model = loadModel(files["model.yaml"], { registry, results });
  } catch (error) {
    return { load: refusal(error) };
  }

  const checked = verify(model, registry, scenarioFiles);
  const units = checked.units;
  const blockedBy = blocked(model);
  const nodes = {};
  for (const name of model.order) {
    const node = model.nodes.get(name);
    const entry = {
      kind: node.kind,
      unit: node.unit,
      dimensionality: registry.describe(registry.parse(node.unit)).dimensionality,
      magnitude: units.magnitudes.get(name),
    };
    for (const [key, field] of [[name, "factor"], [`${name}.limit`, "factor_limit"], [`${name}.headroom`, "factor_headroom"]]) {
      if (units.factors.has(key)) entry[field] = units.factors.get(key);
    }
    if (blockedBy.has(name)) entry.blocked_by = blockedBy.get(name);
    nodes[name] = entry;
  }

  const scenarios = {};
  for (const [path, text] of scenarioFiles) {
    let scenario;
    try {
      scenario = loadScenario(text, path);
    } catch (error) {
      scenarios[`file:${path.slice("scenarios/".length)}`] = { load_error: { message: error.message } };
      continue;
    }
    const entry = { title: scenario.title, overrides: Object.fromEntries(scenario.overrides), samples: scenario.samples, seed: scenario.seed };
    try {
      if (units.problems.length) throw new Error(`${model.name} does not typecheck, so it cannot be evaluated`);
      const values = point(model, scenario, units.factors, blockedBy);
      entry.point = Object.fromEntries(values);
      entry.ceilings = ceilingReport(model, values, units.factors);
    } catch (error) {
      entry.point_error = { message: error.message };
    }
    scenarios[scenario.name] = entry;
  }

  return {
    load: { ok: true },
    verify: { ok: checked.ok, problems: checked.problems, crashed: checked.crashed },
    model: {
      name: model.name,
      title: model.title,
      classification: classification(model),
      order: model.order,
      unmeasured: unmeasured(model),
      outputs: model.outputs,
    },
    nodes,
    scenarios,
  };
}

/* A refused file, in the fixtures' terms: the code, and what it names. */
function refusal(error) {
  if (error instanceof LoadError) {
    const out = { ok: false, code: error.code, message: error.message };
    for (const key of ["node", "field", "ref", "nodes"]) if (error[key] !== undefined) out[key] = error[key];
    return out;
  }
  if (error instanceof YamlError) return { ok: false, code: "load.yaml", message: error.message };
  if (error instanceof PyError || error instanceof UnitError) return { ok: false, code: "load.malformed", message: error.message };
  throw error;
}

/* What the book's registry makes of one unit string: { ok, dimensionality, factor, multiplicative }. */
export function parseUnit(text, table) {
  const registry = registryFor(table);
  try {
    const canonical = registry.parse(text);
    return { ok: true, unit: text, canonical, ...registry.describe(canonical) };
  } catch (error) {
    return { ok: false, unit: text, error: error.message };
  }
}

const registries = new WeakMap();

/* One Registry per table, so its parse cache is shared across calls. */
export function registryFor(table) {
  if (!registries.has(table)) registries.set(table, new Registry(table));
  return registries.get(table);
}

/* One formula as the book's parser reads it: { ok: true, tree } or { ok: false, code }. */
export function parseFormula(text) {
  try {
    return { ok: true, formula: text, tree: parseFormulaText(text) };
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    return { ok: false, formula: text, code: error.code, message: error.message };
  }
}

/* A YAML document as the book's PyYAML reads it, each value with its Python type. */
export function readYaml(text) {
  try {
    return { ok: true, yaml: text, value: typed(safeLoad(text)) };
  } catch (error) {
    return { ok: false, yaml: text, message: error.message };
  }
}

function typed(value) {
  if (value === null || value === undefined) return { py: "none" };
  if (typeof value === "boolean") return { py: "bool", value };
  if (isInt(value)) return { py: "int", value: String(value.value) };
  if (typeof value === "number") return { py: "float", value: floatRepr(value) };
  if (typeof value === "string") return { py: "str", value };
  if (value.py === "date") return { py: "date", value: value.text };
  if (Array.isArray(value)) return { py: "list", items: value.map(typed) };
  if (isDict(value)) return { py: "dict", items: [...value].map(([k, v]) => [typed(k), typed(v)]) };
  return { py: typeof value, value: String(value) };
}

export { documentFrom, scenarioDocumentFrom, Unwritable, writeModel, writeScenario } from "./write.js";
export { loadModel, loadScenario } from "./model.js";

/*
 * A model's files, loaded and written back out as the builder writes them. What the book's loader
 * keeps survives; comments and fields the loader does not read do not, because they are not part
 * of the model.
 */
export function roundTrip(files, { results = {}, registry: table }) {
  const registry = registryFor(table);
  const model = loadModel(files["model.yaml"], { registry, results });
  const out = { "model.yaml": writeModel(documentFrom(model)) };
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("scenarios/")) continue;
    out[path] = writeScenario(scenarioDocumentFrom(loadScenario(text, path)));
  }
  return out;
}
