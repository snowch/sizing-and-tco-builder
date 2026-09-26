/*
 * The builder's engine agrees with the book's toolkit on every case, or CI fails.
 *
 * The fixtures are what the book's own Python said (conformance/generate.py, at the commit in
 * book.lock.json). This runs the engine over the same inputs and reports every difference, not
 * just the first, because a unit rule that is wrong shows up in a dozen cases at once and the
 * list is how you find which rule.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compareCase, compareFormula, compareUnit, compareYaml } from "../conformance/compare.js";
import * as engine from "../engine/index.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

/* The layout this runner understands. A fixture set in another layout is refused, not misread. */
const FIXTURE_FORMAT = 1;

const manifest = read("manifest.json");
const units = read("units.json");
const formulas = read("formulas.json");
const results = read("results.json");
const yamlProbes = read("yaml.json");

test("the fixtures are in a layout this runner reads", () => {
  assert.equal(manifest.fixture_format, FIXTURE_FORMAT);
});

test("the fixtures name the pinned book commit", () => {
  const lock = JSON.parse(readFileSync(new URL("../book.lock.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.book, lock, "fixtures were generated from a different book commit; regenerate them");
});

function differences(run) {
  try {
    return run();
  } catch (error) {
    return [error.message];
  }
}

test("units: the engine reads every probe as the book's registry does", () => {
  const problems = units.probes.flatMap((probe) =>
    differences(() => compareUnit(probe, engine.parseUnit(probe.unit, units.registry))),
  );
  assert.deepEqual(problems, []);
});

test("formulas: the engine parses every probe as the book's parser does", () => {
  const problems = formulas.probes.flatMap((probe) =>
    differences(() => compareFormula(probe, engine.parseFormula(probe.formula))),
  );
  assert.deepEqual(problems, []);
});

test("yaml: the engine reads every probe as the book's PyYAML does", () => {
  const problems = yamlProbes.probes.flatMap((probe) =>
    differences(() => compareYaml(probe, engine.readYaml(probe.yaml))),
  );
  assert.deepEqual(problems, []);
});

for (const id of manifest.cases) {
  test(`case ${id}`, () => {
    const want = read(`cases/${id}.json`);
    const problems = differences(() =>
      compareCase(want, engine.report(want.files, {
        results: { ...results, ...want.results },
        registry: units.registry,
      })),
    );
    assert.deepEqual(problems, []);
  });
}
