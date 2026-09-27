/*
 * The book's verdict on the files, and the answers' ranges: the slow part, done off the page's
 * thread where the browser allows (app/worker.js), here otherwise.
 *
 * The verdict is the engine's report on the written files: every check verify-models.py makes,
 * including sampling every scenario as the book's does. The ranges are the reference scenario
 * sampled at its own count and seed, summarised for the answers and the ceilings.
 */

import { checkUnits } from "../engine/evaluate.js";
import { registryFor, report } from "../engine/index.js";
import { loadModel, loadScenario } from "../engine/model.js";
import { sample } from "../engine/sample.js";

export function judge(files, { results, units }) {
  const registry = registryFor(units);
  const verdict = report(files, { results, registry: units });
  let ranges = null;
  if (verdict.load.ok && !verdict.verify.problems.some((p) => p.code.startsWith("units.")) && files["scenarios/reference.yaml"]) {
    try {
      const model = loadModel(files["model.yaml"], { registry, results });
      const scenario = loadScenario(files["scenarios/reference.yaml"]);
      const { factors } = checkUnits(model, registry);
      const wanted = [...model.outputs, ...[...model.nodes.values()].filter((n) => n.kind === "ceiling").map((n) => n.name)];
      const drawn = sample(model, scenario, factors, { summarise: wanted });
      const outputs = {};
      for (const name of model.outputs) {
        const s = drawn.summaries.get(name);
        if (s) outputs[name] = { p5: s.p5, p50: s.p50, p95: s.p95, mean: s.mean };
      }
      ranges = { samples: scenario.samples, seed: scenario.seed, outputs, ceilings: drawn.ceilings, nonFinite: drawn.nonFinite };
    } catch {
      ranges = null;
    }
  }
  return { report: verdict, ranges };
}
