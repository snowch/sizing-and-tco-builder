/*
 * Measure first agrees with the book's tornado(), bar by bar and in the same order, for every
 * output of both reference models and two edge cases, at their reference scenarios.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { close } from "../conformance/compare.js";
import { checkUnits } from "../engine/evaluate.js";
import { registryFor } from "../engine/index.js";
import { loadModel, loadScenario } from "../engine/model.js";
import { tornado } from "../engine/tornado.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const registry = registryFor(read("units.json").registry);
const results = read("results.json");

const cases = readdirSync(new URL("tornado/", FIXTURES), { recursive: true }).filter((f) => f.endsWith(".json"));

for (const file of cases) {
  const want = read(`tornado/${file}`);
  test(`tornado ${want.case}`, () => {
    const c = read(`cases/${want.case}.json`);
    const model = loadModel(c.files["model.yaml"], { registry, results: { ...results, ...c.results } });
    const scenario = loadScenario(c.files["scenarios/reference.yaml"]);
    const { factors } = checkUnits(model, registry);
    const problems = [];
    for (const [output, bars] of Object.entries(want.outputs)) {
      const got = tornado(model, scenario, output, factors);
      if (got.map((b) => b.node).join() !== bars.map((b) => b.node).join()) {
        problems.push(`${output}: order ${bars.map((b) => b.node)} vs ${got.map((b) => b.node)}`);
        continue;
      }
      bars.forEach((bar, i) => {
        for (const key of ["low_input", "high_input", "low", "high", "span", "base"]) {
          if (!close(bar[key], got[i][key])) problems.push(`${output} ${bar.node}.${key}: book ${bar[key]}, engine ${got[i][key]}`);
        }
      });
    }
    assert.deepEqual(problems, []);
  });
}
