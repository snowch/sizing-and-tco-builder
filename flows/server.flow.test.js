/*
 * The page linked to a solution on the server, with an assistant on the other side: the
 * assistant (the tools, called directly) starts a solution and suggests figures; the page shows
 * each as suggested and unconfirmed; the engineer confirms one, rejects one, types another;
 * everything meets in the server's record; and a suggestion made while the page is open
 * appears without a reload. The files the server writes at the end go to the book's toolkit.
 *
 *     npm run flows            (needs Chromium; Python 3.11 for the book's side)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright";

import { createHandler } from "../server/serve.js";
import { Workspace, loadContext } from "../server/workspace.js";
import { runTool } from "../server/tools.js";

const ROOT = new URL("..", import.meta.url).pathname;

let server, browser, base, ws;

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const local = "/opt/pw-browsers";
  if (!existsSync(local)) return undefined;
  const dir = readdirSync(local).find((d) => /^chromium-\d+$/.test(d));
  const path = dir && join(local, dir, "chrome-linux", "chrome");
  return path && existsSync(path) ? path : undefined;
}

before(async () => {
  ws = new Workspace(mkdtempSync(join(tmpdir(), "builder-solutions-")), loadContext());
  server = createServer(createHandler(ws));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  ws.pageUrl = base;
  browser = await chromium.launch({ executablePath: chromiumPath() });
});
after(async () => { await browser?.close(); server?.close(); });

/* The assistant's side: a tool call that must succeed. */
const tool = (name, args) => { const out = runTool(ws, name, args); assert.ok(out.ok, `${name}: ${out.error}`); return out.result; };

/* The book's verdict on the files the server wrote, or null where Python is not available. */
function book(files) {
  if (process.env.SKIP_BOOK) return null;
  const dir = mkdtempSync(join(tmpdir(), "builder-server-"));
  mkdirSync(join(dir, "scenarios"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  let out;
  try { out = execFileSync("python3", [join(ROOT, "conformance/check-files.py"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }); } catch (error) { out = error.stdout; }
  return JSON.parse(out.trim().split("\n").at(-1));
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const FIGURES = { data_today: 500, growth: 0.3, horizon: 5, cores: 500, memory: 4000, fill_limit: 0.7, sites: 2, power_price: 0.25, pue: 1.4, admin_cost: 60000,
  unit_cores: 64, unit_memory: 512, unit_tb: 100, protection: 1.5, price: 20000, discount: 0.1, rent: 0, licence: 0, support_rate: 0.15, watts: 800, hosting: 1200, site_cost: 0, admins: 2, migration: 0 };

test("the page shows the assistant's suggestions as unconfirmed, the engineer decides each, and the server's record is the one both see", async () => {
  const errors = [];
  // The assistant starts the solution and suggests three customer figures from the notes.
  tool("start_solution", { name: "acme", question: "tco", notes: "Customer has 500 TB of usable data today, growing by about 30% per year, over 5 years." });
  tool("suggest_inputs", { name: "acme", suggestions: [
    { scope: "shared", input: "data_today", value: 500, origin: "customer", evidence: "Customer has 500 TB of usable data today" },
    { scope: "shared", input: "growth", value: 0.3, origin: "customer", evidence: "growing by about 30% per year" },
    { scope: "shared", input: "horizon", value: 5, origin: "customer", evidence: "over 5 years" },
  ] });
  const url = tool("open_in_page", { name: "acme" }).url;
  assert.equal(url, `${base}v2/?solution=acme`);

  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector("#steps .step");
  assert.match(await page.$eval("#remote-chip", (el) => el.textContent), /Linked to acme · 3 suggested/);
  assert.match(await page.$eval("#sugg-banner", (el) => el.textContent), /3 figures suggested by the assistant wait/);

  // Requirements: each suggested figure sits under its empty field, with origin and evidence.
  await page.click('#sugg-banner [data-open="requirements"]');
  await page.waitForSelector('[data-sugg="shared|data_today"]');
  assert.equal(await page.inputValue('[data-shared="data_today"]'), "", "the field is empty: a suggestion is not a value");
  const card = await page.$eval('[data-sugg="shared|data_today"]', (el) => el.innerText.replace(/\s+/g, " "));
  assert.match(card, /Suggested by the assistant, unconfirmed/i);
  assert.match(card, /500 TB/);
  assert.match(card, /Customer/);
  assert.match(card, /Customer has 500 TB of usable data today/);

  // Confirm one, reject one.
  await page.click('[data-sugg-confirm="shared|data_today"]');
  await page.waitForFunction(() => document.querySelector('[data-shared="data_today"]')?.value === "500");
  await page.click('[data-sugg-reject="shared|growth"]');
  await page.waitForFunction(() => !document.querySelector('[data-sugg="shared|growth"]'));
  assert.equal(await page.inputValue('[data-shared="growth"]'), "", "rejected: still blank");
  assert.equal(await page.$eval('button.chip[data-org="shared|data_today"]', (el) => el.textContent), "Customer");
  // The engineer types the third one themselves, over the suggestion, and the suggestion is still theirs to decide.
  await page.fill('[data-shared="growth"]', "0.25");
  await page.waitForFunction(() => /Linked to acme · 1 suggested/.test(document.querySelector("#remote-chip").textContent), null, { timeout: 10000 });
  // While the engineer is in a field, the page holds any change from the server until they leave it.
  await page.$eval('[data-shared="growth"]', (el) => el.blur());
  // A typed figure says where it came from, as any figure must.
  await page.click('button.chip[data-org="shared|growth"]:not([data-ro])');
  await page.selectOption("#pop-origin", "customer");
  await page.fill("#pop-source", "they said a quarter on the call");
  await page.click("#pop-close");

  // The server has what the page did: the confirmed value with the assistant's evidence, the typed one, no growth suggestion.
  await page.waitForFunction(() => !/saving/.test(document.querySelector("#remote-chip").textContent));
  const seen = tool("describe_inputs", { name: "acme", scope: "shared" }).scopes[0].inputs;
  const by = Object.fromEntries(seen.map((i) => [i.input, i]));
  assert.equal(by.data_today.value, 500);
  assert.equal(by.data_today.origin, "customer");
  assert.match(by.data_today.evidence, /Customer has 500 TB of usable data today \(suggested by the assistant, confirmed in the page\)/);
  assert.equal(by.growth.value, 0.25);
  assert.equal(by.growth.suggestion, undefined);
  assert.equal(by.horizon.value, null);
  assert.equal(by.horizon.suggestion.value, 5);

  // A suggestion made while the page is open arrives without a reload.
  tool("suggest_inputs", { name: "acme", suggestions: [{ scope: "Our solution", input: "price", value: 20000, origin: "quote", evidence: "our quote Q-1042, line 3" }] });
  await page.waitForFunction(() => /2 suggested/.test(document.querySelector("#remote-chip").textContent), null, { timeout: 10000 });
  await page.click('#sugg-banner [data-open="inputs"]');
  await page.waitForSelector('[data-sugg="o0|price"]');
  assert.match(await page.$eval('[data-sugg="o0|price"]', (el) => el.innerText), /our quote Q-1042, line 3/);
  assert.equal(await page.inputValue('[data-opt="o0"][data-in="price"]'), "");
  await page.click('[data-sugg-confirm="o0|price"]');
  await page.waitForFunction(() => document.querySelector('[data-opt="o0"][data-in="price"]')?.value === "20000");

  // The rest, confirmed by the engineer through the assistant, and the answer agreed by both sides.
  await page.click('[data-sugg-confirm="shared|horizon"]');
  await page.waitForFunction(() => !/suggested/.test(document.querySelector("#remote-chip").textContent));
  await page.waitForFunction(() => !/saving/.test(document.querySelector("#remote-chip").textContent));
  const m = tool("missing_inputs", { name: "acme" });
  tool("suggest_inputs", { name: "acme", suggestions: [...m.required, ...m.optional].map((x) => ({ scope: x.scope, input: x.input, value: FIGURES[x.input] ?? 3, origin: x.scope === "shared" ? "customer" : "quote", evidence: `a figure for this flow: ${x.input}` })) });
  tool("confirm_suggestions", { name: "acme", confirmed_by: "the engineer, on the call" });
  const ev = tool("evaluate", { name: "acme" });
  assert.equal(ev.blocker, undefined);
  const ours = ev.options.find((o) => o.ours).value;
  assert.ok(ours > 0);
  // The page took the server's record and shows the same answer.
  await page.waitForFunction(() => /Ready/.test(document.querySelector("#need")?.textContent ?? ""), null, { timeout: 10000 });
  await page.click("#go-results");
  await page.waitForSelector("#answer .big");
  const shown = await page.evaluate(() => { const a = globalThis.__v2; const o = a.state.options.find((x) => x.ours); return a.evaluate(o).values.get("total_cost").value; });
  assert.ok(close(shown, ours), `${shown} on the page, ${ours} on the server`);

  // The files, from the server, through the book.
  const w = tool("write_files", { name: "acme" });
  assert.equal(w.verdict.ok, true, JSON.stringify(w.verdict.problems));
  const verdict = book(w.files);
  if (verdict) {
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.ok(close(verdict.points.reference.total_cost, ours), "the book's total is the server's");
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test("a page with no server link keeps its state in the browser, and a link to a solution that does not exist says so", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}v2/`);
  await page.waitForSelector("#types button");
  assert.equal(await page.$eval("#remote-chip", (el) => el.hidden), true);
  await page.goto(`${base}v2/?solution=nowhere`);
  await page.waitForSelector(".callout.warn");
  assert.match(await page.$eval(".callout.warn", (el) => el.textContent), /no solution called "nowhere"/);
  await context.close();
});
