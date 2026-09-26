/*
 * The build checks: scripts/verify-models.py's rules for a model file, in its order.
 *
 * Eight rules and the scenario checks. The ninth thing the script does, check_stamps, is about the
 * book's own stamped results being current and says nothing about a model file, so it is not
 * here (PLAN.md).
 *
 * Where the book's verifier falls over rather than reporting (conformance cases
 * invalid/scenario-missing-name and invalid/distribution-two-shapes), this stops at the same
 * point and says so, keeping what was found before it, as the book's run does. The builder
 * refuses those files too; BOOK-REQUESTS 9 asks the book to report them instead.
 */

import { checkScenario, checkUnits, oneShape, SHAPES } from "./evaluate.js";
import { ancestors, classification, DECIDED_BY, isConditional, loadScenario, ofKind, PROVENANCE_KINDS } from "./model.js";
import { PyError, sorted, strip } from "./python.js";

/* A `fact` has to point at something. Any of these in the source counts as pointing. */
export const CITATION_MARKERS = ["bench/results/", ".json", ".yaml", "definition", "invoice", "@", "http"];

export class VerifierCrash extends Error {}

const RULES = {
  "units.does-not-typecheck": "1",
  "units.declared-vs-produced": "1",
  "units.mixed-operands": "1",
  "units.rounds-in-wrong-unit": "1",
  "input.decided": "2",
  "input.provenance-kind": "2",
  "input.empty-source": "2",
  "input.shape-not-named": "2",
  "input.fact-cites-nothing": "3",
  "measured.no-result": "4",
  "measured.no-summary-value": "4",
  "measured.unit-differs": "4",
  "measured.no-uncertainty": "5",
  "ceiling.no-headroom": "6",
  "ceiling.no-reason": "6",
  "shape.feeds-no-output": "7",
  "shape.no-outputs": "7",
  "classification.measured-without-ceiling": "8",
  "scenario.unknown-node": "scenarios",
  "scenario.overrides-derived": "scenarios",
  "scenario.does-not-evaluate": "scenarios",
};

const problem = (code, fields = {}) => ({ code, rule: RULES[code], node: null, part: null, ...fields });

/* check_model */
export function checkModel(model, registry, problems, units = checkUnits(model, registry)) {
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
      else if (node.distribution !== null && !SHAPES.some((shape) => source.toLowerCase().includes(shape))) {
        // The book names the shape in its message, and falls over if there is not exactly one.
        try {
          oneShape(node.distribution);
        } catch (error) {
          throw new VerifierCrash(`verify-models.py falls over on input '${name}': ${error.message}`);
        }
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
        if (unit && unit !== node.unit) problems.push(problem("measured.unit-differs", { node: name }));
      }
    }

    // 6 -- ceilings
    if (node.kind === "ceiling") {
      if (!strip(node.headroomText)) problems.push(problem("ceiling.no-headroom", { node: name }));
      if (!strip(node.because)) problems.push(problem("ceiling.no-reason", { node: name }));
    }
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

/* check_scenarios: every scenario file, sorted by name; each override names a real input. */
export function checkScenarios(model, scenarioFiles, units, problems) {
  const scenarios = [];
  for (const [path, text] of scenarioFiles) {
    try {
      scenarios.push(loadScenario(text, path));
    } catch (error) {
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
