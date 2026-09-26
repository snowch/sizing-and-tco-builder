/*
 * A model loaded and written back out means the same thing.
 *
 * For every conformance case the book loads (both reference models, every stage, the valid edge
 * cases), the engine writes the model and its scenarios as the builder would, reads the result
 * again, and must get the same report: the same classification, order, units, factors, values at
 * every scenario's point, and the same build-check verdicts. conformance/roundtrip.py makes the
 * same check with the book's own toolkit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compareCase } from "../conformance/compare.js";
import * as engine from "../engine/index.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const manifest = read("manifest.json");
const registry = read("units.json").registry;
const results = read("results.json");

/* Files the book loads and the builder's document cannot hold, so the builder would not write. */
const UNWRITABLE = ["edge/correlation-missing-rho", "edge/value-and-shape"];

for (const id of manifest.cases) {
  const want = read(`cases/${id}.json`);
  const scenariosLoad = Object.keys(want.scenarios ?? {}).every((name) => !name.startsWith("file:"));
  if (!want.load.ok || !scenariosLoad || want.verify.crashed) continue;
  test(`round trip ${id}`, () => {
    const context = { results: { ...results, ...want.results }, registry };
    if (UNWRITABLE.includes(id)) {
      assert.throws(() => engine.roundTrip(want.files, context), engine.Unwritable);
      return;
    }
    const written = engine.roundTrip(want.files, context);
    const again = engine.report(written, context);
    assert.deepEqual(compareCase(want, again), []);
    // And writing is stable: the written file writes itself.
    assert.deepEqual(engine.roundTrip(written, context), written);
  });
}

test("the reference model is written in the book's layout", () => {
  const want = read("cases/reference/web_service.json");
  const written = engine.roundTrip(want.files, { results, registry })["model.yaml"];
  assert.match(written, /^model: web_service\ntitle: /);
  assert.match(written, /\n {2}peak_request_rate_t0:\n {4}kind: input\n {4}decided: outside\n {4}unit: request\/second\n/);
  assert.match(written, /distribution: \{triangular: \{minimum: 3000, likely: 8000, maximum: 20000\}\}/);
});
