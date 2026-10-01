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

// -- the interview: one question, one answer ------------------------------------------------------
import { answerFromReply, promptForOne, readAnswer } from "../v2/app/interpret.js";

test("the typed reader takes a number in the unit's sense, and knows when there is none", () => {
  const tb = { name: "usable data held today", unit: "TB" };
  assert.deepEqual(readAnswer("about 500, they said 480 last quarter", tb), { value: 500, unknown: false, sure: false, by: "typed" });
  assert.deepEqual(readAnswer("500 TB", tb), { value: 500, unknown: false, sure: true, by: "typed" });
  assert.equal(readAnswer("£60k a year", { name: "admin", unit: "GBP/count/year" }).value, 60000);
  assert.equal(readAnswer("30%", { name: "growth", unit: "dimensionless" }).value, 0.3, "a percentage of a share");
  assert.equal(readAnswer("30%", { name: "support", unit: "1/year" }).value, 0.3);
  assert.equal(readAnswer("70%", { name: "cores", unit: "core" }).value, 70, "not a share: the number stays");
  for (const text of ["don't know", "no idea", "not sure yet", "", "what do you mean?"]) assert.equal(readAnswer(text, tb).unknown, true, text);
});

test("the per-question prompt names the input, its unit and the answer, and forbids guessing", () => {
  const p = promptForOne("What is the customer's usable data held today?", { name: "usable data held today", unit: "TB" }, "half a petabyte");
  assert.ok(p.includes("Input: usable data held today (unit: TB)"));
  assert.ok(p.includes('Answer: """half a petabyte"""'));
  assert.ok(p.includes("Never estimate"));
});

test("a reply is a value or nothing, never prose", () => {
  assert.deepEqual(answerFromReply('{"value": 500, "unknown": false, "sure": true}'), { value: 500, unknown: false, sure: true, by: "ai" });
  assert.deepEqual(answerFromReply('{"value": null, "unknown": true, "sure": false}'), { value: null, unknown: true, sure: false, by: "ai" });
  assert.equal(answerFromReply('{"value": "lots", "sure": true}').unknown, true);
  assert.equal(answerFromReply("I think it is about 500").unknown, true);
});

test("without a model, interpretAnswer is the typed reader; with one, the reply is read", async () => {
  const none = createInterpreter({});
  assert.equal((await none.interpretAnswer("q", { name: "x", unit: "TB" }, "500 TB")).value, 500);
  const backend = { status: async () => ({ available: true }), complete: async (prompt) => (prompt.includes('Answer: """half a petabyte"""') ? '{"value": 500, "unknown": false, "sure": true}' : "{}") };
  const it = createInterpreter({ backend });
  const r = await it.interpretAnswer("q", { name: "x", unit: "TB" }, "half a petabyte");
  assert.deepEqual(r, { value: 500, unknown: false, sure: true, by: "ai" });
});
