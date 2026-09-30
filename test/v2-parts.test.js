/*
 * The v2 part templates: each loads with every customer and option figure blank, and the
 * merge of any set of them is a model the checker accepts and the engine evaluates once the
 * blanks are given numbers. Taking the numbers out took nothing else with them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { registryFor, report } from "../engine/index.js";
import { inputsBehind, loadPart, merge } from "../v2/app/parts.js";
import { writeModel, writeScenario } from "../engine/write.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const table = JSON.parse(read("data/units.json"));
const registry = registryFor(table);
const index = JSON.parse(read("v2/templates/index.json"));
const parts = index.parts.map((meta) => loadPart(meta, read(`v2/templates/${meta.file}`), { registry }));
const REFERENCE = { scenario: "reference", title: "Reference", because: "The model as declared.", samples: 1000, seed: 1, overrides: {} };

/* Numbers for this test only: any positive figure that keeps every formula finite. */
const FIGURES = { fill_margin: 0.3, growth: 0.2, discount: 0.1, protection: 1.5, pue: 1.4, support_rate: 0.2, horizon: 5 };
function filled(doc) {
  const out = structuredClone(doc);
  for (const n of out.nodes) {
    if (n.kind !== "input" || typeof n.value === "number" || n.distribution) continue;
    const local = n.name.replace(/^(infra|software|services)_/, "");
    n.value = FIGURES[local] ?? 3;
    n.provenance = { kind: "assumption", source: "a figure for this test" };
  }
  return out;
}
const check = (doc) => report({ "model.yaml": writeModel(doc), "scenarios/reference.yaml": writeScenario(REFERENCE) }, { results: {}, registry: table });

for (const part of parts) {
  test(`${part.id}: every customer and option figure is blank, and its metadata names real nodes`, () => {
    const inputs = part.doc.nodes.filter((n) => n.kind === "input");
    const blanks = inputs.filter((n) => n.value == null && !n.distribution);
    const decided = (n) => part.doc.nodes.find((x) => x.name === n).decided;
    for (const n of blanks) assert.ok(["outside", "you"].includes(decided(n.name)), `${n.name} is blank but decided by ${decided(n.name)}`);
    for (const n of inputs.filter((x) => !blanks.includes(x))) assert.ok(n.decided === "definition" || n.name === "included", `${n.name} carries a number`);
    const names = new Set(part.doc.nodes.map((n) => n.name));
    for (const name of [...Object.keys(part.requirements), ...Object.keys(part.lines), ...Object.values(part.metrics), ...Object.keys(part.keys)]) {
      assert.ok(names.has(name), `${part.id}: ${name} is not a node`);
    }
    for (const name of Object.keys(part.requirements)) assert.equal(decided(name), "outside", `${name} is a requirement but not decided outside`);
    for (const name of Object.keys(part.lines)) assert.ok(inputsBehind(part.doc, ["total_cost"]).size > 0 && part.doc.nodes.some((n) => n.name === "total_cost" && n.formula.includes(name)), `${name} is not a line of total_cost`);
  });

  test(`${part.id}: given numbers, it passes every check and evaluates`, () => {
    const verdict = check(filled(part.doc));
    assert.ok(verdict.load.ok, JSON.stringify(verdict.load));
    assert.deepEqual(verdict.verify.problems.map((p) => `${p.code} ${p.node ?? ""}`), []);
    const total = verdict.scenarios.reference.point.total_cost;
    assert.ok(Number.isFinite(total) && total > 0, `total_cost is ${total}`);
  });
}

test("the three parts merge into one model with a grand total, which the checker accepts", () => {
  const { doc, map, totals } = merge(parts, index);
  assert.deepEqual(totals, ["infra_total_cost", "software_total_cost", "services_total_cost"]);
  assert.equal(doc.nodes.filter((n) => n.name === "horizon").length, 1, "the period is shared once");
  assert.equal(doc.nodes.filter((n) => n.name === "one_year").length, 1);
  assert.ok(doc.nodes.some((n) => n.name === "infra_growth") && doc.nodes.some((n) => n.name === "software_growth"), "each part keeps its own growth");
  assert.equal(map.get("infra_units").local, "units");
  const verdict = check(filled(doc));
  assert.ok(verdict.load.ok, JSON.stringify(verdict.load));
  assert.deepEqual(verdict.verify.problems.map((p) => `${p.code} ${p.node ?? ""}`), []);
  const point = verdict.scenarios.reference.point;
  assert.ok(Math.abs(point.total_cost - (point.infra_total_cost + point.software_total_cost + point.services_total_cost)) < 1e-6);
});

test("a part an option leaves out costs nothing: its included switch is a scenario override", () => {
  const { doc } = merge(parts, index);
  const files = { "model.yaml": writeModel(filled(doc)), "scenarios/reference.yaml": writeScenario(REFERENCE), "scenarios/no_services.yaml": writeScenario({ ...REFERENCE, scenario: "no_services", overrides: { services_included: 0 } }) };
  const verdict = report(files, { results: {}, registry: table });
  assert.deepEqual(verdict.verify.problems, []);
  const a = verdict.scenarios.reference.point, b = verdict.scenarios.no_services.point;
  assert.equal(b.services_total_cost, 0);
  assert.ok(Math.abs(a.total_cost - b.total_cost - a.services_total_cost) < 1e-6);
});

test("the inputs behind an answer are found by walking its formulas", () => {
  const infra = parts.find((p) => p.id === "infra");
  const behind = inputsBehind(infra.doc, ["units"]);
  assert.ok(behind.has("cores") && behind.has("unit_tb") && behind.has("fill_limit"));
  assert.ok(!behind.has("price") && !behind.has("power_price"), "a sizing answer does not need prices");
});
