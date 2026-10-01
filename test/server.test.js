/*
 * The MCP server: the builder's engine with no page, driven as an assistant drives it. A
 * suggestion needs an origin and evidence or it is refused; nothing a tool does writes a
 * figure into the model until someone confirms it; a what-if leaves the solution unchanged;
 * the files the server writes pass the engine's checks; and the protocol answers as a client
 * expects over a pipe.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { Workspace, loadContext } from "../server/workspace.js";
import { TOOLS, runTool } from "../server/tools.js";
import { createMcp, serveStdio } from "../server/mcp.js";

const ctx = loadContext();
const fresh = () => new Workspace(mkdtempSync(join(tmpdir(), "builder-ws-")), ctx);
const call = (ws, name, args) => { const out = runTool(ws, name, args); assert.ok(out.ok, `${name}: ${out.error}`); return out.result; };
const refused = (ws, name, args) => { const out = runTool(ws, name, args); assert.ok(!out.ok, `${name} should have been refused`); return out.error; };

/* Figures for the test only, by the input's name; any positive number that keeps the model finite. */
const FIGURES = { data_today: 500, growth: 0.3, horizon: 5, cores: 500, memory: 4000, fill_limit: 0.7, sites: 2, power_price: 0.25, pue: 1.4, admin_cost: 60000,
  unit_cores: 64, unit_memory: 512, unit_tb: 100, protection: 1.5, price: 20000, discount: 0.1, rent: 0, licence: 0, support_rate: 0.15, watts: 800, hosting: 1200, site_cost: 0, admins: 2, migration: 0 };
function fillEverything(ws, name, { who = "the engineer" } = {}) {
  const m = call(ws, "missing_inputs", { name });
  const suggestions = [...m.required, ...m.optional].map((x) => ({ scope: x.scope, input: x.input, value: FIGURES[x.input] ?? 3, origin: x.scope === "shared" ? "customer" : "quote", evidence: `a figure for this test: ${x.input}` }));
  const s = call(ws, "suggest_inputs", { name, suggestions });
  assert.equal(s.refused.length, 0, JSON.stringify(s.refused));
  return call(ws, "confirm_suggestions", { name, confirmed_by: who });
}

test("every tool has a name, a description and an object schema, and names are unique", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.ok(t.name && t.description && t.inputSchema.type === "object", t.name);
    assert.ok(!names.has(t.name)); names.add(t.name);
  }
  assert.ok(TOOLS.length >= 15);
});

test("a solution starts from the question with its options and nothing filled in", () => {
  const ws = fresh();
  const s = call(ws, "start_solution", { name: "acme", question: "competitive", notes: "Customer has 500 TB." });
  assert.deepEqual(s.options.map((o) => o.role), ["current", "ours", "rival"]);
  assert.deepEqual(s.parts.map((p) => p.id), ["infra"]);
  assert.match(s.blocker, /needed values still missing/);
  assert.equal(s.suggestions_unconfirmed, 0);
  const inputs = call(ws, "describe_inputs", { name: "acme" });
  assert.ok(inputs.scopes.every((sc) => sc.inputs.every((i) => i.value === null)), "no figure is filled in");
  assert.deepEqual(call(ws, "list_solutions", {}).solutions.map((x) => x.name), ["acme"]);
  assert.match(refused(ws, "start_solution", { name: "acme", question: "tco" }), /already a solution/);
  assert.match(refused(ws, "start_solution", { name: "Bad Name", question: "tco" }), /lower-case/);
  assert.match(refused(ws, "start_solution", { name: "x", question: "nonsense" }), /no question called/);
});

test("a suggestion needs an origin the page knows, evidence, a number, and the right scope; and it does not enter the model", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "competitive" });
  const r = call(ws, "suggest_inputs", { name: "acme", suggestions: [
    { scope: "shared", input: "data_today", value: 500, origin: "customer", evidence: "Customer has 500 TB of usable data today." },
    { scope: "shared", input: "growth", value: "30%", origin: "customer", evidence: "growing by about 30% per year" },
    { scope: "shared", input: "horizon", value: 5, origin: "guess", evidence: "they want to compare over 5 years" },
    { scope: "shared", input: "cores", value: 500, origin: "customer", evidence: "" },
    { scope: "shared", input: "price", value: 20000, origin: "quote", evidence: "our quote Q-1234 line 2" },
    { scope: "Our solution", input: "price", value: 20000, origin: "quote", evidence: "our quote Q-1234 line 2" },
    { scope: "Competitor A", input: "price", value: 25000, origin: "published", evidence: "their price list, page 4" },
    { scope: "shared", input: "total_cost", value: 1, origin: "customer", evidence: "the answer typed in" },
    { scope: "shared", input: "one_year", value: 2, origin: "customer", evidence: "a definition changed" },
  ] });
  assert.deepEqual(r.accepted.map((x) => `${x.scope}|${x.input}`), ["shared|data_today", "o1|price", "o2|price"]);
  const why = Object.fromEntries(r.refused.map((x) => [x.input, x.reason]));
  assert.match(why.growth, /must be a number/);
  assert.match(why.horizon, /origin must be one of/);
  assert.match(why.cores, /evidence is required/);
  assert.match(why.price, /name the option/);
  assert.match(why.total_cost, /calculated, not entered/);
  assert.match(why.one_year, /definition/);
  // Nothing reached the model: every value is still blank, the suggestion sits beside it.
  const d = call(ws, "describe_inputs", { name: "acme" });
  const shared = d.scopes.find((s) => s.scope === "shared").inputs.find((i) => i.input === "data_today");
  assert.equal(shared.value, null);
  assert.equal(shared.suggestion.value, 500);
  assert.equal(shared.suggestion.origin, "customer");
  const m = call(ws, "missing_inputs", { name: "acme" });
  assert.ok(m.required.some((x) => x.input === "data_today" && x.suggested?.value === 500), "a suggested figure still counts as missing");
  const raw = JSON.parse(readFileSync(join(ws.dir, "acme", "state.json"), "utf8"));
  assert.equal(raw.state.doc.nodes.find((n) => n.name === "data_today").value, null);
  assert.deepEqual(raw.state.options[2].overrides, {});
  // Withdrawn, it is gone.
  assert.equal(call(ws, "withdraw_suggestions", { name: "acme", inputs: [{ scope: "o2", input: "price" }] }).removed, 1);
  assert.equal(call(ws, "describe_solution", { name: "acme" }).suggestions_unconfirmed, 2);
});

test("a provisional answer applies the suggestions to a copy and says which; confirming writes them in with their provenance", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "competitive" });
  const m = call(ws, "missing_inputs", { name: "acme" });
  const suggestions = [...m.required, ...m.optional].map((x) => ({ scope: x.scope, input: x.input, value: FIGURES[x.input] ?? 3, origin: x.scope === "shared" ? "customer" : "quote", evidence: `the figure for ${x.input}` }));
  call(ws, "suggest_inputs", { name: "acme", suggestions });
  const blocked = call(ws, "evaluate", { name: "acme" });
  assert.match(blocked.blocker, /missing/);
  const prov = call(ws, "evaluate", { name: "acme", provisional: true });
  assert.equal(prov.provisional, true);
  assert.equal(prov.suggestions_applied.length, suggestions.length);
  assert.ok(Number.isFinite(prov.options.find((o) => o.ours).value) && prov.options.find((o) => o.ours).value > 0);
  // Still nothing in the model.
  assert.match(call(ws, "evaluate", { name: "acme" }).blocker, /missing/);
  const c = call(ws, "confirm_suggestions", { name: "acme", confirmed_by: "Sam, on the call" });
  assert.equal(c.confirmed.length, suggestions.length);
  assert.equal(c.blocker, null);
  const d = call(ws, "describe_inputs", { name: "acme" });
  const dt = d.scopes[0].inputs.find((i) => i.input === "data_today");
  assert.equal(dt.value, 500);
  assert.equal(dt.origin, "customer");
  assert.match(dt.evidence, /confirmed by Sam, on the call through the assistant/);
  assert.equal(dt.suggestion, undefined);
  const final = call(ws, "evaluate", { name: "acme" });
  assert.equal(final.provisional, false);
  assert.equal(final.options.find((o) => o.ours).value, prov.options.find((o) => o.ours).value, "the provisional answer was the answer");
  assert.ok(Object.keys(final.options[0].by_category).includes("Hardware"));
});

test("explain gives a number's formula in words and with the numbers in, down to the inputs and their origins", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "competitive" });
  fillEverything(ws, "acme");
  const x = call(ws, "explain", { name: "acme" });
  assert.equal(x.tree.node, "total_cost");
  assert.ok(Number.isFinite(x.tree.value));
  assert.ok(x.tree.made_of.length > 3);
  const hw = call(ws, "explain", { name: "acme", option: "Competitor A", node: "hardware", depth: 5 });
  assert.equal(hw.option.name, "Competitor A");
  assert.match(hw.in_words ?? hw.tree.in_words, /price/);
  const leaves = [];
  const walk = (t) => { if (t.input) leaves.push(t); else for (const k of t.made_of ?? []) walk(k); };
  walk(hw.tree);
  const price = leaves.find((l) => l.input === "price");
  assert.equal(price.value, FIGURES.price);
  assert.equal(price.origin, "quote");
  assert.equal(price.whose, "Competitor A");
  assert.ok(leaves.some((l) => l.whose === "customer"));
  assert.match(refused(ws, "explain", { name: "acme", node: "nothing_here" }), /no node called/);
});

test("a what-if answers from a copy: the solution afterwards is as it was", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "competitive" });
  fillEverything(ws, "acme");
  const before = call(ws, "evaluate", { name: "acme" });
  const w = call(ws, "what_if", { name: "acme", changes: [{ scope: "shared", input: "growth", value: 0.5 }, { scope: "Competitor A", input: "price", value: 10000 }] });
  assert.equal(w.changes[0].was, 0.3);
  for (const o of w.options) { assert.equal(o.as_it_stands, before.options.find((x) => x.id === o.id).value); assert.ok(Number.isFinite(o.what_if)); }
  assert.ok(w.options.every((o) => o.what_if !== o.as_it_stands), "growth moves every option");
  const after = call(ws, "evaluate", { name: "acme" });
  assert.deepEqual(after.options, before.options);
  assert.equal(after.version, before.version, "nothing was written");
});

test("options: same as ours, a part not covered, add and remove, rename", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "comparison", parts: ["infra", "software"] });
  const d = call(ws, "describe_solution", { name: "acme" });
  assert.deepEqual(d.parts.map((p) => p.id), ["infra", "software"]);
  assert.deepEqual(d.options.map((o) => o.role), ["ours", "alt"]);
  const added = call(ws, "add_option", { name: "acme", role: "rival", option_name: "Competitor B" });
  assert.equal(added.option.name, "Competitor B");
  call(ws, "set_option", { name: "acme", option: "Alternative solution", rename: "Their bundle", covers: ["software"] });
  const o = call(ws, "set_option", { name: "acme", option: "Their bundle", same_as_ours: ["software_licence", "software_per_user_year"] }).option;
  assert.deepEqual(o.same_as_ours, ["software_licence", "software_per_user_year"]);
  assert.deepEqual(o.covers, ["software"]);
  assert.match(refused(ws, "set_option", { name: "acme", option: "Our solution", same_as_ours: ["software_licence"] }), /cannot be the same as itself/);
  assert.match(refused(ws, "set_option", { name: "acme", option: "Their bundle", covers: ["services"] }), /not one of this solution's parts/);
  const inputs = call(ws, "describe_inputs", { name: "acme", scope: "Their bundle" });
  assert.equal(inputs.scopes.length, 1);
  assert.ok(inputs.scopes[0].inputs.every((i) => i.input.startsWith("software_")), "an option covering one part has only that part's figures");
  assert.ok(inputs.scopes[0].inputs.find((i) => i.input === "software_licence").same_as_ours);
  call(ws, "remove_option", { name: "acme", option: "Competitor B" });
  assert.match(refused(ws, "remove_option", { name: "acme", option: "Our solution" }), /not ours/);
  assert.deepEqual(call(ws, "describe_solution", { name: "acme" }).options.map((x) => x.name), ["Our solution", "Their bundle"]);
  // Choosing parts later keeps what was entered.
  call(ws, "suggest_inputs", { name: "acme", suggestions: [{ scope: "shared", input: "horizon", value: 3, origin: "customer", evidence: "three years, they said" }] });
  call(ws, "confirm_suggestions", { name: "acme", confirmed_by: "the engineer" });
  call(ws, "set_parts", { name: "acme", parts: ["software"] });
  assert.equal(call(ws, "describe_inputs", { name: "acme", scope: "shared" }).scopes[0].inputs.find((i) => i.input === "horizon").value, 3);
});

test("the files are written from confirmed figures only, and the engine's checks pass on them", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "competitive", notes: "Customer has 500 TB." });
  assert.match(call(ws, "write_files", { name: "acme" }).blocker, /missing/);
  fillEverything(ws, "acme");
  call(ws, "set_requirement_note", { name: "acme", category: "Availability", text: "Mirrored across two sites." });
  const w = call(ws, "write_files", { name: "acme" });
  assert.equal(w.verdict.ok, true, JSON.stringify(w.verdict.problems));
  assert.equal(w.ranges?.samples, 10000, "the reference scenario was sampled as the book samples it");
  assert.ok(existsSync(join(ws.dir, "acme", "model.yaml")));
  assert.ok(existsSync(join(ws.dir, "acme", "scenarios", "o2.yaml")));
  const model = readFileSync(join(ws.dir, "acme", "model.yaml"), "utf8").replace(/\s+/g, " ");
  assert.match(model, /suggested by the assistant, confirmed by the engineer through the assistant/);
  assert.doesNotMatch(model, /suggested, unconfirmed/);
  assert.equal(call(ws, "describe_solution", { name: "acme" }).requirement_notes.Availability, "Mirrored across two sites.");
});

test("a solution is read and written with a version, so two writers cannot write over each other", () => {
  const ws = fresh();
  call(ws, "start_solution", { name: "acme", question: "tco" });
  const r = ws.read("acme");
  assert.equal(r.version, 1);
  ws.write("acme", r.state, { version: 1 });
  assert.throws(() => ws.write("acme", r.state, { version: 1 }), /changed meanwhile/);
  assert.equal(ws.read("acme").version, 2);
});

test("JSON-RPC: initialize, tools/list and tools/call answer as a client expects; a refusal is a tool error, not a protocol error", () => {
  const ws = fresh();
  const mcp = createMcp(ws);
  const init = mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.equal(init.result.serverInfo.name, "sizing-and-tco-builder");
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /suggest_inputs/);
  assert.equal(mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual(mcp.handle({ jsonrpc: "2.0", id: 2, method: "ping" }).result, {});
  const list = mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.ok(list.result.tools.some((t) => t.name === "suggest_inputs"));
  assert.ok(list.result.tools.every((t) => !("run" in t)));
  const started = mcp.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_solution", arguments: { name: "acme", question: "sizing" } } });
  assert.equal(started.result.isError, undefined);
  assert.equal(started.result.structuredContent.question.id, "sizing");
  assert.equal(JSON.parse(started.result.content[0].text).question.id, "sizing");
  const bad = mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "suggest_inputs", arguments: { name: "acme", suggestions: [{ scope: "shared", input: "cores", value: 500, origin: "customer", evidence: "" }] } } });
  assert.equal(bad.result.isError, undefined, "a refused suggestion is reported inside the result");
  assert.equal(bad.result.structuredContent.refused.length, 1);
  const missing = mcp.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "evaluate", arguments: { name: "nowhere" } } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /no solution called/);
  assert.equal(mcp.handle({ jsonrpc: "2.0", id: 7, method: "resources/list" }).error.code, -32601);
  assert.equal(mcp.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }).error.code, -32602);
  assert.equal(mcp.handleText("{not json").error.code, -32700);
});

test("over stdio, one message a line in, one a line out", async () => {
  const ws = fresh();
  const input = new PassThrough(), output = new PassThrough();
  let got = "";
  output.on("data", (d) => { got += d; });
  const done = serveStdio(createMcp(ws), { input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_questions", arguments: {} } })}\n`);
  input.end();
  await done;
  const lines = got.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [1, 2]);
  assert.ok(lines[1].result.structuredContent.questions.length >= 7);
});
