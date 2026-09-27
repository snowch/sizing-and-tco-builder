/*
 * The builder's ranges land where the book's do, for the same file and seed.
 *
 * The builder samples with its own random stream (engine/sample.js), so it cannot match the
 * book's draws one for one. It is held to the book by distribution instead: for every scenario
 * of both reference models and two edge cases, every node that varies, and each of its 5th,
 * 25th, 50th, 75th and 95th percentiles and its mean, and every ceiling's share of draws over
 * its allowed level.
 *
 * The tolerance, stated. conformance/generate.py runs each scenario at its own seed and at 16
 * others, and records how far each figure moves between seeds: its standard deviation (sd) and
 * the least and greatest it took. The builder's figure and the book's are two independent draws
 * of the same quantity, so their difference has a standard deviation of about sd × √2. A figure
 * passes when
 *
 *     |builder − book| ≤ 6 × √2 × sd + (greatest − least) + step
 *
 * where step is 1 for a quantity that only takes whole values (a host count after ceil, whose
 * percentile can sit exactly on a boundary and did not move in 17 runs) and 0 otherwise. Six
 * standard deviations make a chance failure about one in five hundred million per figure; the
 * range term covers a spread the 16 reseeds underestimate. A wrong shape, a wrong correlation
 * step or a wrong formula moves figures by far more than this, and the correlated-sum case is
 * there to show it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { checkUnits } from "../engine/evaluate.js";
import { registryFor } from "../engine/index.js";
import { loadModel, loadScenario } from "../engine/model.js";
import { sample } from "../engine/sample.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const registry = registryFor(read("units.json").registry);
const results = read("results.json");

export const SIGMAS = 6;
const STATISTICS = ["p5", "p25", "p50", "p75", "p95", "mean"];

export function tolerance(entry, whole) {
  return SIGMAS * Math.SQRT2 * entry.sd + (entry.high - entry.low) + (whole ? 1 : 0);
}

const files = readdirSync(new URL("sampling/", FIXTURES), { recursive: true }).filter((f) => f.endsWith(".json"));

for (const file of files) {
  const want = read(`sampling/${file}`);
  const c = read(`cases/${want.case}.json`);
  const model = loadModel(c.files["model.yaml"], { registry, results: { ...results, ...c.results } });
  const { factors } = checkUnits(model, registry);
  const scenarios = Object.entries(c.files).filter(([p]) => p.startsWith("scenarios/")).map(([p, t]) => loadScenario(t, p));

  for (const [name, expected] of Object.entries(want.scenarios)) {
    test(`ranges ${want.case} ${name}`, () => {
      const scenario = scenarios.find((s) => s.name === name);
      const got = sample(model, scenario, factors);
      assert.deepEqual([...got.summaries.keys()].sort(), Object.keys(expected.nodes).sort(), "the same nodes vary");
      const problems = [];
      for (const [node, stats] of Object.entries(expected.nodes)) {
        const whole = ["p5", "p25", "p50", "p75", "p95"].every((s) => Number.isInteger(stats[s].value));
        for (const stat of STATISTICS) {
          const book = stats[stat];
          const mine = got.summaries.get(node)[stat];
          const allowed = tolerance(book, whole);
          if (!(Math.abs(mine - book.value) <= allowed)) {
            problems.push(`${node}.${stat}: book ${book.value}, builder ${mine}, allowed ±${allowed} (sd ${book.sd})`);
          }
        }
      }
      for (const [ceiling, book] of Object.entries(expected.ceilings)) {
        const mine = got.ceilings[ceiling]?.p_over_allowed;
        const allowed = tolerance(book, false) + 1 / expected.samples;
        if (!(Math.abs(mine - book.value) <= allowed)) problems.push(`${ceiling} over allowed: book ${book.value}, builder ${mine}, allowed ±${allowed}`);
      }
      assert.deepEqual(problems, []);
    });
  }
}

test("a wrong correlation step would be caught", () => {
  // The same correlated sum with its correlations dropped: the builder's figures must fail the
  // tolerance, or the tolerance is too loose to mean anything.
  const want = read("sampling/edge/strong-correlation.json").scenarios.reference;
  const c = read("cases/edge/strong-correlation.json");
  const model = loadModel(c.files["model.yaml"], { registry, results });
  const loose = { ...model, correlations: [] };
  const { factors } = checkUnits(model, registry);
  const got = sample(loose, loadScenario(c.files["scenarios/reference.yaml"]), factors);
  const book = want.nodes.total_cost.p95;
  assert.ok(Math.abs(got.summaries.get("total_cost").p95 - book.value) > tolerance(book, false), "dropping the correlations went unnoticed");
});
