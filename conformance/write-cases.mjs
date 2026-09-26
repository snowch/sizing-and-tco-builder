/*
 * Every writable conformance case, loaded and written back out by the engine, as JSON on stdout:
 * { case id: { path: text } }. conformance/roundtrip.py hands the result to the book's toolkit.
 */

import { readFileSync } from "node:fs";

import * as engine from "../engine/index.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const registry = read("units.json").registry;
const results = read("results.json");

const out = {};
for (const id of read("manifest.json").cases) {
  const want = read(`cases/${id}.json`);
  if (!want.load.ok || want.verify.crashed) continue;
  if (Object.keys(want.scenarios).some((name) => name.startsWith("file:"))) continue;
  try {
    out[id] = { files: engine.roundTrip(want.files, { results: { ...results, ...want.results }, registry }), results: want.results };
  } catch (error) {
    if (!(error instanceof engine.Unwritable)) throw error;
  }
}
process.stdout.write(JSON.stringify(out));
