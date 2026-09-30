/*
 * A shape to start from is a worked example with its numbers taken out, and nothing else lost.
 *
 * Blank: no input has a value, a range, a shape or a source; nothing is measured; no ceiling,
 * correlation or note comes along; every node feeds one of the shape's answers.
 * Whole: given each blank the example's own number, the shape passes every check and gives
 * exactly the example's answers, so taking the numbers out took nothing else with them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkUnits, pointValueOfInput } from "../engine/evaluate.js";
import { at } from "../engine/explore.js";
import { registryFor, report } from "../engine/index.js";
import { loadModel, measuredValue } from "../engine/model.js";
import { SHAPES, shapeFrom } from "../engine/template.js";
import { writeModel, writeScenario } from "../engine/write.js";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const table = read("data/units.json");
const registry = registryFor(table);
const results = read("data/results.json");
const examples = read("data/examples.json");
const REFERENCE = { scenario: "reference", title: "Reference", because: "The model as declared.", samples: 1000, seed: 20260916, overrides: {} };

for (const shape of SHAPES) {
  test(`${shape.id}: blank, and every node feeds an answer`, () => {
    const doc = shapeFrom(shape, examples, { registry, results });
    assert.ok(doc.nodes.length > shape.outputs.length);
    for (const n of doc.nodes) {
      assert.ok(n.kind === "input" || n.kind === "derived", `${n.name} is ${n.kind}`);
      if (n.kind === "input") {
        assert.deepEqual([n.value, n.distribution, n.range, n.provenance.source, n.note], [null, null, null, "", null], n.name);
      }
    }
    for (const o of shape.outputs) assert.ok(doc.nodes.some((n) => n.name === o), `${o} is missing`);
    assert.deepEqual(doc.correlations, []);
  });

  test(`${shape.id}: given the example's numbers, it passes every check and gives the example's answers`, () => {
    const example = loadModel(examples.find((e) => e.id === shape.example).files["model.yaml"], { registry, results });
    const doc = shapeFrom(shape, examples, { registry, results });
    for (const n of doc.nodes) {
      if (n.kind !== "input") continue;
      const original = example.nodes.get(n.name);
      n.value = original.kind === "measured" ? measuredValue(original) : pointValueOfInput(original, null);
      n.provenance = { kind: "assumption", source: "the example's own figure, for this test" };
    }
    const files = { "model.yaml": writeModel(doc), "scenarios/reference.yaml": writeScenario(REFERENCE) };
    const verdict = report(files, { results, registry: table });
    assert.ok(verdict.load.ok, JSON.stringify(verdict.load));
    assert.deepEqual(verdict.verify.problems.map((p) => `${p.code} ${p.node ?? ""}`), []);
    const wanted = at(example, checkUnits(example, registry).factors, new Map(), shape.outputs);
    for (const o of shape.outputs) {
      const got = verdict.scenarios.reference.point[o];
      assert.ok(Math.abs(got - wanted.get(o)) <= 1e-9 * Math.max(1, Math.abs(wanted.get(o))), `${o}: ${got}, example ${wanted.get(o)}`);
    }
  });
}
