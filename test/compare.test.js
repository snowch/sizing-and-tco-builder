/*
 * The comparison is not vacuous: it accepts the book's own answer and rejects a changed one.
 *
 * A harness that passes everything is worse than none, because it is believed. So each fixture is
 * compared with itself (no differences) and with copies altered in the ways an engine could be
 * wrong (a difference found every time).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compareCase, compareFormula, compareUnit } from "../conformance/compare.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const manifest = read("manifest.json");
const copy = (x) => structuredClone(x);

test("every case agrees with itself", () => {
  for (const id of manifest.cases) {
    const want = read(`cases/${id}.json`);
    assert.deepEqual(compareCase(want, copy(want)), [], id);
  }
});

test("a changed answer is always a difference", () => {
  const web = read("cases/reference/web_service.json");
  const refused = read("cases/invalid/unknown-unit.json");
  const problem = read("cases/invalid/ceiling-no-reason.json");
  const alterations = [
    [web, (g) => { g.load = { ok: false, code: "load.yaml" }; }],
    [web, (g) => { g.model.classification = "definitional"; }],
    [web, (g) => { g.model.order.reverse(); }],
    [web, (g) => { g.nodes.tco.factor *= 1.001; }],
    [web, (g) => { g.nodes.cost_per_stored_tb_month.factor *= 1.001; }],
    [web, (g) => { g.nodes.cost_per_stored_tb_month.factor = 0; }],
    [web, (g) => { g.nodes.tco.dimensionality = { "[currency]": 2 }; }],
    [web, (g) => { g.scenarios.reference.point.tco *= 1 + 1e-6; }],
    [web, (g) => { delete g.scenarios.reference.point.tco; }],
    [web, (g) => { g.scenarios.reference.ceilings.disk_fill.verdict = "over"; }],
    [web, (g) => { g.verify.problems.push({ code: "ceiling.no-reason", node: "disk_fill" }); }],
    [web, (g) => { g.verify.crashed = { exception: "Error" }; }],
    [refused, (g) => { g.load.code = "load.unknown-kind"; }],
    [refused, (g) => { g.load.node = "cores"; }],
    [problem, (g) => { g.verify.problems = []; }],
    [problem, (g) => { g.verify.problems[0].node = "somewhere_else"; }],
  ];
  for (const [want, alter] of alterations) {
    const got = copy(want);
    alter(got);
    assert.notDeepEqual(compareCase(want, got), [], `${want.id}: ${alter}`);
  }
});

test("units and formulas: self agrees, a change differs", () => {
  for (const probe of read("units.json").probes) {
    assert.deepEqual(compareUnit(probe, copy(probe)), [], probe.unit);
    if (probe.ok && probe.multiplicative) {
      assert.notDeepEqual(compareUnit(probe, { ...probe, factor: probe.factor * 2 }), [], probe.unit);
    }
  }
  for (const probe of read("formulas.json").probes) {
    assert.deepEqual(compareFormula(probe, copy(probe)), [], probe.formula);
    assert.notDeepEqual(compareFormula(probe, { ...probe, ok: !probe.ok }), [], probe.formula);
  }
});
