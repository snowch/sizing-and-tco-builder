/*
 * The Explore view's charts work out what the book's charts show.
 *
 * ch23 draws four charts of the seller's model (bench/run_seller.py), and the book stamps the
 * numbers behind them (conformance/fixtures/charts/seller.json). Each is the model at its point
 * values with some inputs changed on top of ch22's customer. The engine's sweep, crossing,
 * boundary and breakdown must give the same numbers from the model file alone:
 *
 *   - the saving against the transfer factor, one line per guess at the share that scales;
 *   - where each line crosses nought, which the model also states as break_even_transfer;
 *   - the plane's boundary: the transfer factor at which the saving is nought, for each share;
 *   - payback by year: each option's spend added up year by year, and where saving crosses nought;
 *   - each proposal's five-year spend in three parts: what stays, the proposed hosts, the move.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkUnits } from "../engine/evaluate.js";
import { at, boundary, breakdown, crossings, spaced, sweep, terms } from "../engine/explore.js";
import { parse } from "../engine/formula.js";
import { registryFor } from "../engine/index.js";
import { loadModel, loadScenario } from "../engine/model.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const registry = registryFor(read("units.json").registry);
const results = read("results.json");
const book = read("charts/seller.json").summary;
const files = read("cases/reference/sellers_tco.json").files;

const model = loadModel(files["model.yaml"], { registry, results });
const { factors } = checkUnits(model, registry);
const customer = loadScenario(files["scenarios/ch22_customer.yaml"]).overrides;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

// The three settings of the two hidden assumptions ch23 draws, as the book states them.
const bottomUp = book.ch22.incumbent.share_without_people;
const settings = {
  brochure: new Map([["transfer_factor", 1], ["scaling_share", 1]]),
  bottom_up_assumptions: new Map([["transfer_factor", 1], ["scaling_share", bottomUp]]),
  sellers_guesses: new Map(),
};

test("the saving against the transfer factor, for each guess at the share that scales", () => {
  const cases = book.curves.map((c) => ({ key: c.key, label: c.key, overrides: new Map([["scaling_share", c.scaling_share]]) }));
  const drawn = sweep(model, factors, { base: customer, x: "transfer_factor", xs: book.transfers, outputs: ["saving"], cases });
  const problems = [];
  drawn.series.forEach((s, i) => s.ys.forEach((y, j) => {
    if (!close(y, book.curves[i].saving[j])) problems.push(`${s.key} at ${book.transfers[j]}: ${y}, book ${book.curves[i].saving[j]}`);
  }));
  assert.deepEqual(problems, []);
});

test("where each line crosses nought is the model's own break-even", () => {
  for (const c of book.curves) {
    const found = crossings(model, factors, { base: new Map([...customer, ["scaling_share", c.scaling_share]]), x: "transfer_factor", output: "saving", low: 0.05, high: 10 });
    assert.equal(found.length, 1, `${c.key}: ${found}`);
    assert.ok(close(found[0], c.break_even_transfer), `${c.key}: ${found[0]}, book ${c.break_even_transfer}`);
  }
});

test("the plane's boundary: for each share, the transfer factor at which the saving is nought", () => {
  const ys = book.plane.boundary.map((b) => b.scaling_share);
  const traced = boundary(model, factors, { base: customer, x: "transfer_factor", y: "scaling_share", output: "saving", xLow: 0.05, xHigh: 20, ys });
  const problems = [];
  traced.forEach((row, i) => {
    const want = book.plane.boundary[i].break_even_transfer;
    if (row.xs.length !== 1 || !close(row.xs[0], want)) problems.push(`share ${row.y}: ${row.xs}, book ${want}`);
  });
  assert.deepEqual(problems, []);
});

test("payback by year: each option's spend added up, and where its saving crosses nought", () => {
  const years = book.by_year.years;
  for (const option of book.by_year.options) {
    const drawn = sweep(model, factors, { base: customer, x: "horizon", xs: years, outputs: ["proposed_total", "current_total"], cases: [{ key: option.key, overrides: settings[option.key] }] });
    const [proposed, current] = drawn.series;
    proposed.ys.forEach((y, i) => assert.ok(close(y, option.cumulative[i]), `${option.key} year ${years[i]}: ${y}, book ${option.cumulative[i]}`));
    current.ys.forEach((y, i) => assert.ok(close(y, book.by_year.current[i]), `current year ${years[i]}: ${y}, book ${book.by_year.current[i]}`));
    const found = crossings(model, factors, { base: new Map([...customer, ...settings[option.key]]), x: "horizon", output: "saving", low: 0.01, high: 100 });
    if (option.payback > 0) {
      assert.equal(found.length, 1, `${option.key}: ${found}`);
      assert.ok(close(found[0], option.payback), `${option.key}: ${found[0]}, book ${option.payback}`);
    } else {
      assert.deepEqual(found, [], `${option.key} never pays back, and no crossing may say it does`);
    }
  }
});

test("each proposal's five-year spend in its three parts, against the customer's own", () => {
  const cases = book.breakdown.options.map((o) => ({ key: o.key, overrides: settings[o.key] }));
  const split = breakdown(model, factors, { base: customer, output: "proposed_total", cases });
  assert.equal(split.parts.length, 3);
  split.cases.forEach((c, i) => {
    const want = book.breakdown.options[i];
    [want.stays, want.proposed_hosts, want.move].forEach((w, j) => assert.ok(close(c.values[j], w), `${c.key} part ${j}: ${c.values[j]}, book ${w}`));
    assert.ok(close(c.values.reduce((a, b) => a + b, 0), c.total));
  });
  assert.ok(close(at(model, factors, customer).get("current_total"), book.breakdown.current));
});

test("a sum splits into its terms, with signs; anything else is one term", () => {
  const signs = (text) => terms(parse(text)).map((t) => t.sign);
  assert.deepEqual(signs("a + b - c"), [1, 1, -1]);
  assert.deepEqual(signs("a - (b - c)"), [1, -1, 1]);
  assert.deepEqual(signs("a * (b + c)"), [1]);
  assert.deepEqual(spaced(0, 1, 5), [0, 0.25, 0.5, 0.75, 1]);
});
