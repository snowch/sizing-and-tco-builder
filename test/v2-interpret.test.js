/*
 * The interpreter's contract: the prompt names every input and forbids guessing, a reply is
 * turned into candidates in the finder's own shape, anything naming no known input is dropped,
 * and a candidate the model was not sure about is ambiguous. No model runs here; a stand-in
 * backend returns a fixed reply, which is exactly how the page treats a real one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { candidatesFromReply, createInterpreter, promptFor } from "../v2/app/interpret.js";

const INPUTS = [
  { key: "shared|data_today", name: "usable data held today", unit: "TB", scope: "shared" },
  { key: "shared|growth", name: "growth a year, as a fraction", unit: "dimensionless", scope: "shared" },
  { key: "o0|unit_tb", name: "raw capacity per unit", unit: "TB/host", scope: "o0" },
];
const NOTES = "They hold half a petabyte of usable data. Growth is roughly a third a year.\nEach of their boxes has 100 TB raw.";

test("the prompt lists every input by key and forbids guessing", () => {
  const p = promptFor(NOTES, INPUTS);
  for (const i of INPUTS) assert.ok(p.includes(`${i.key}: ${i.name} (${i.unit})`));
  assert.ok(p.includes("Never estimate"));
  assert.ok(p.includes(NOTES));
  assert.ok(p.includes("[a figure about the customer's current environment]"));
});

test("a reply becomes candidates with the quoted sentence, and unknown inputs are dropped", () => {
  const reply = JSON.stringify({ candidates: [
    { input: "shared|data_today", value: 500, quote: "half a petabyte of usable data", sure: true },
    { input: "shared|growth", value: 0.33, quote: "roughly a third a year", sure: false },
    { input: "shared|nothing", value: 1, quote: "x", sure: true },
    { input: "o0|unit_tb", value: "100", quote: "100 TB raw", sure: true },
  ] });
  const out = candidatesFromReply(reply, NOTES, INPUTS);
  assert.equal(out.length, 2, "a made-up input and a non-numeric value are dropped");
  assert.equal(out[0].target, "shared|data_today");
  assert.equal(out[0].value, 500);
  assert.equal(out[0].confidence, "confident");
  assert.equal(out[0].sentence, "They hold half a petabyte of usable data.");
  assert.equal(out[0].sentence.slice(out[0].at, out[0].at + out[0].length), "half a petabyte of usable data");
  assert.equal(out[0].by, "ai");
  assert.equal(out[1].confidence, "ambiguous", "not sure means the engineer chooses");
  assert.equal(out[1].target, "");
  assert.deepEqual(out[1].alternatives, ["shared|growth"]);
  assert.ok(out.every((c) => c.status === "pending"));
});

test("a reply that is not JSON yields nothing rather than an error", () => {
  assert.deepEqual(candidatesFromReply("Sorry, I cannot", NOTES, INPUTS), []);
});

test("a stand-in backend is used as a real one would be, and status never loads anything", async () => {
  const calls = [];
  const backend = { status: async () => ({ available: true, reason: "" }), complete: async (prompt, schema) => { calls.push({ prompt, schema }); return JSON.stringify({ candidates: [{ input: "o0|unit_tb", value: 100, quote: "100 TB raw", sure: true }] }); } };
  const it = createInterpreter({ backend });
  assert.deepEqual(await it.status(), { available: true, reason: "" });
  const out = await it.interpret(NOTES, INPUTS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schema.type, "object");
  assert.equal(out[0].target, "o0|unit_tb");
  const none = createInterpreter({});
  assert.equal((await none.status()).available, false);
});
