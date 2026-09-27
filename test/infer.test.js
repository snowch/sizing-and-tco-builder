/*
 * Unit inference for names a formula introduces, and the words for a unit.
 *
 * Each rule in the design gets a case, and every inferred unit is checked against the book's own
 * unit pass: once the new names are given the inferred units, the engine must agree the formula
 * produces the node's unit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { describe } from "../engine/describe.js";
import { parse, refs } from "../engine/formula.js";
import { formatUnits, inferUnits, producedUnits } from "../engine/infer.js";
import { Registry } from "../engine/units.js";

const registry = new Registry(JSON.parse(readFileSync(new URL("../data/units.json", import.meta.url), "utf8")));
const u = (text) => registry.parse(text);
const sortedDims = (x) => JSON.stringify(Object.entries(registry.describe(x).dimensionality).sort());
const same = (a, b) => sortedDims(a) === sortedDims(b);

function infer(formula, known, target) {
  const tree = parse(formula);
  const knownUnits = new Map(Object.entries(known).map(([k, v]) => [k, { units: u(v), text: v }]));
  const fresh = new Set([...refs(tree)].filter((n) => !knownUnits.has(n)));
  const inferred = inferUnits(tree, { known: knownUnits, fresh, target: target ? u(target) : null, targetText: target });
  return { tree, inferred, knownUnits };
}

const cases = [
  ["a sum takes the unit of its known side", "stored_t0 + growth_in_data", { stored_t0: "TB" }, "TB", { growth_in_data: "TB" }],
  ["min and max take it too", "max(hosts_for_requests, hosts_for_storage)", { hosts_for_requests: "host" }, "host", { hosts_for_storage: "host" }],
  ["an exponent is a pure number", "x_t0 * annual_growth ** horizon_periods", { x_t0: "TB" }, "TB", { annual_growth: "dimensionless", horizon_periods: "dimensionless" }],
  ["inside log or exp is a pure number", "log(ratio_a) * size_b", { size_b: "host" }, "host", { ratio_a: "dimensionless" }],
  ["the one unknown in a product is solved", "peak_request_rate * service_demand", { peak_request_rate: "request/second" }, "core", { service_demand: "core*second/request" }],
  ["and in a quotient", "busy_cores / cores_per_host", { busy_cores: "core" }, "host", { cores_per_host: "core/host" }],
  ["a whole power is solved through", "side ** 2", {}, "TB**2", { side: "TB" }],
  ["the ceil of a need", "ceil(busy_cores / (cores_per_host * (1 - queueing_margin)))", { busy_cores: "core", cores_per_host: "core/host" }, "host", { queueing_margin: "dimensionless" }],
  ["two unknowns in a product stay unknown", "a_rate * b_cost", {}, "USD", {}],
  ["up front plus running, over the horizon", "hosts * host_price + hosts * running_cost_per_host_year * horizon", { hosts: "host", horizon: "year" }, "USD", { host_price: "USD/host", running_cost_per_host_year: "USD/host/year" }],
];

for (const [title, formula, known, target, want] of cases) {
  test(`inference: ${title}`, () => {
    const { tree, inferred, knownUnits } = infer(formula, known, target);
    assert.deepEqual([...inferred.keys()].sort(), Object.keys(want).sort());
    for (const [name, text] of Object.entries(want)) assert.ok(same(inferred.get(name).units, u(text)), `${name}: ${formatUnits(inferred.get(name).units)} vs ${text}`);
    // The engine's unit pass agrees the formula now produces the target.
    if (Object.keys(want).length === [...refs(tree)].filter((n) => !knownUnits.has(n)).length) {
      const units = new Map([...knownUnits].map(([k, v]) => [k, v.units]));
      for (const [k, v] of inferred) units.set(k, v.units);
      const produced = producedUnits(tree, { registry, units });
      assert.ok(!produced.error && same(produced.units, u(target)), JSON.stringify(produced));
    }
  });
}

test("a formatted unit reads back as itself", () => {
  for (const text of ["core*second/request", "USD/host/year", "TB**2", "dimensionless", "1/second", "request**0.5"]) {
    assert.deepEqual(u(formatUnits(u(text))), u(text), text);
  }
});

test("the words for a unit", () => {
  const words = (text) => describe(registry.describe(u(text)).dimensionality, u(text)).kind;
  assert.equal(words("request/second"), "rate");
  assert.equal(words("USD/year"), "rate");
  assert.equal(words("year"), "duration");
  assert.equal(words("host"), "level");
  assert.equal(words("TB"), "level");
  assert.equal(words("dimensionless"), "ratio");
  assert.equal(words("USD/TB/month"), "rate");
  assert.equal(words("USD/host"), "ratio");
  assert.equal(words("core/host"), "ratio");
  assert.match(describe(registry.describe(u("TB")).dimensionality, u("TB")).words, /pure number/);
});

test("a formatted unit uses the shortest spelling that reads back as itself", () => {
  assert.equal(formatUnits(u("terabyte/host"), registry), "TB/host");
  assert.equal(formatUnits(u("core*second/request"), registry), "core*s/req");
  assert.equal(formatUnits(u("terabit"), registry), "Tbit");
});
