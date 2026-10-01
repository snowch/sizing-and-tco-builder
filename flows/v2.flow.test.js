/*
 * The v2 page, driven in a real browser the way a presales engineer drives it: the question,
 * the notes, the candidates confirmed one by one, the requirements, the options, each option's
 * numbers typed, the origins set, the answer, the explanation, and the files handed to the
 * book's own toolkit.
 *
 * The interpreter is a stand-in that returns one fixed reply, so no model is downloaded: what
 * the flow checks is that each suggestion arrives as a candidate, marked as the interpreter's,
 * and reaches the model only when confirmed. Nothing on the page reads the notes by matching
 * words; the candidates are the stand-in's and nobody else's. Before any number field is filled, the flow checks it
 * is empty, so a screen that filled a number in would fail here.
 *
 *     npm run flows            (needs Chromium; Python 3.11 for the book's side)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".yaml": "text/yaml" };

let server;
let browser;
let base;

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const local = "/opt/pw-browsers";
  if (!existsSync(local)) return undefined;
  const dir = readdirSync(local).find((d) => /^chromium-\d+$/.test(d));
  const path = dir && join(local, dir, "chrome-linux", "chrome");
  return path && existsSync(path) ? path : undefined;
}

before(async () => {
  server = createServer((req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
    if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/v2/`;
  browser = await chromium.launch({ executablePath: chromiumPath() });
});
after(async () => { await browser?.close(); server?.close(); });

/* The stand-in interpreter's one reply: every customer figure in the notes, two of the current environment's, and one it is not sure of. */
const REPLY = { candidates: [
  { input: "shared|data_today", value: 500, quote: "Customer has 500 TB of usable data today", sure: true },
  { input: "shared|growth", value: 0.3, quote: "growing by about 30% per year", sure: true },
  { input: "shared|horizon", value: 5, quote: "over 5 years", sure: true },
  { input: "shared|cores", value: 500, quote: "Peak load is about 500 cores", sure: true },
  { input: "shared|memory", value: 4000, quote: "4,000 GB of memory", sure: true },
  { input: "shared|fill_limit", value: 0.7, quote: "kept below 70% full", sure: true },
  { input: "shared|sites", value: 2, quote: "mirrored across two sites", sure: true },
  { input: "shared|power_price", value: 0.25, quote: "Power costs them £0.25 per kWh", sure: true },
  { input: "shared|pue", value: 1.4, quote: "the data centre runs at a PUE of 1.4", sure: true },
  { input: "shared|admin_cost", value: 60000, quote: "An admin costs them about £60k a year", sure: true },
  { input: "o0|unit_tb", value: 100, quote: "12 servers with 100 TB raw storage each", sure: true },
  { input: "o0|support_rate", value: 0.2, quote: "Support runs at a fifth of the hardware price each year", sure: true },
  { input: "o0|protection", value: 12, quote: "They currently run 12 servers", sure: false },
] };

/* A presales engineer at the keyboard. */
class Engineer {
  constructor(page) {
    this.page = page;
    this.errors = [];
    page.on("pageerror", (e) => this.errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") this.errors.push(m.text()); });
  }
  static async start() {
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    await context.addInitScript((reply) => {
      globalThis.__v2Interpreter = { backend: { status: async () => ({ available: true, reason: "", size: "a stand-in" }), complete: async (prompt) => {
        // The interview's one-question prompt: read "half a petabyte" and plain numbers; anything else is no figure.
        const m = /Answer: \"\"\"([\s\S]*?)\"\"\"/.exec(prompt);
        if (m) {
          const text = m[1];
          if (/half a petabyte/i.test(text)) return JSON.stringify({ value: 500, unknown: false, sure: true });
          const num = /(\d[\d,]*(?:\.\d+)?)/.exec(text);
          return JSON.stringify(num ? { value: Number(num[1].replace(/,/g, "")), unknown: false, sure: true } : { value: null, unknown: true, sure: false });
        }
        return JSON.stringify(reply);
      } } };
    }, REPLY);
    const page = await context.newPage();
    const e = new Engineer(page);
    e.context = context;
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector("#types button");
    return e;
  }
  /* The page never fills a number in: the field is empty until the engineer types one. */
  async number(selector, value) {
    const now = await this.page.inputValue(selector);
    assert.equal(now, "", `${selector} held ${now} before anyone typed`);
    await this.page.fill(selector, String(value));
  }
  async origin(key, via, evidence) {
    await this.page.click(`button.chip[data-org="${key}"]:not([data-ro])`);
    await this.page.selectOption("#pop-origin", via);
    await this.page.fill("#pop-source", evidence);
    await this.page.click("#pop-close");
  }
  async bulkOrigin(option, via, evidence) {
    await this.page.selectOption(`[data-bulk-origin="${option}"]`, via);
    await this.page.fill(`[data-bulk-evidence="${option}"]`, evidence);
    await this.page.click(`[data-bulk-apply="${option}"]`);
  }
  text(sel) { return this.page.$eval(sel, (el) => el.innerText.replace(/\s+/g, " ").trim()); }
  async summary(step) { return this.page.$eval(`[data-sum="${step}"]`, (el) => el.textContent); }
  async next(step) { await this.page.click(`[data-next="${step}"]`); await this.page.waitForSelector(`#body-${step}`); }
  async files() { return this.page.evaluate(() => globalThis.__v2.files()); }
  async settled() { await this.page.waitForFunction(() => globalThis.__v2.verdict.report !== null, null, { timeout: 30000 }); }
}

/* The book's verdict on files the page wrote, or null where Python is not available. */
function book(files) {
  if (process.env.SKIP_BOOK) return null;
  const dir = mkdtempSync(join(tmpdir(), "builder-v2-"));
  mkdirSync(join(dir, "scenarios"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  let out;
  try { out = execFileSync("python3", [join(ROOT, "conformance/check-files.py"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }); } catch (error) { out = error.stdout; }
  return JSON.parse(out.trim().split("\n").at(-1));
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const NOTES = "Customer has 500 TB of usable data today, growing by about 30% per year. They currently run 12 servers with 100 TB raw storage each, mirrored across two sites (active/passive). Peak load is about 500 cores and 4,000 GB of memory, and they want every resource kept below 70% full. They want to compare their current environment with our solution over 5 years. Power costs them £0.25 per kWh and the data centre runs at a PUE of 1.4. An admin costs them about £60k a year. Support runs at a fifth of the hardware price each year.";

/* Our figures, the current environment's, and the competitor's, as the engineer types them. */
const OURS = { unit_cores: 96, unit_memory: 1024, unit_tb: 200, protection: 1.4, price: 55000, discount: 0.25, rent: 0, licence: 10, support_rate: 0.18, watts: 1200, hosting: 1500, site_cost: 15000, admins: 1, migration: 80000 };
const CURRENT = { unit_cores: 64, unit_memory: 512, protection: 2, price: 30000, discount: 0.15, rent: 0, licence: 0, watts: 900, hosting: 1500, site_cost: 20000, admins: 2, migration: 0 };
const RIVAL = { unit_cores: 32, unit_memory: 256, unit_tb: 20, protection: 1, price: 0, discount: 0, rent: 900, licence: 0, support_rate: 0, watts: 0, hosting: 0, site_cost: 5000, admins: 1, migration: 120000 };

test("a competitive TCO from notes: candidates confirmed, numbers typed, origins set, files the book accepts", async () => {
  const e = await Engineer.start();
  const { page } = e;

  // The header says what the on-device model is doing; with the stand-in loaded, it is ready.
  await page.waitForFunction(() => /ready|available|not available/.test(document.getElementById("engine-chip").textContent));
  assert.match(await e.text("#engine-chip"), /On-device model: ready/);
  await page.click("#engine-chip");
  assert.match(await e.text("#engine-note"), /reads pasted notes and interview answers/);
  await page.click("#engine-note .close");

  // The question, then the customer's notes.
  await page.click('[data-type="competitive"]');
  await page.fill("#notes", NOTES);
  await page.click("#go-find");
  await page.waitForSelector(".cands");
  assert.match(await e.summary("customer"), /to check/);
  // Nothing has reached the model yet: every requirement is still blank.
  assert.match(await e.summary("requirements"), /^0 of/);

  // With the model loaded, starting with notes asked it: every candidate is the model's, marked as such.
  await page.waitForSelector('.cand .conf:has-text("interpreter")');
  assert.equal((await page.$$(".cand:not(.head)")).length, REPLY.candidates.length, "the candidates are the model's and nobody else's");
  await page.click("#confirm-all");
  assert.match(await e.summary("requirements"), /^10 of 10 known/);
  const ai = page.locator(".cand", { hasText: "Support runs at a fifth" });
  assert.match(await ai.locator("select").evaluate((s) => s.selectedOptions[0].textContent), /Current environment: support/);
  assert.match(await ai.innerText(), /Confirmed/, "the model's confident suggestion was among those confirmed, marked as the model's");
  // The one it was not sure of (12 servers as a protection factor) is ambiguous: rejected, it stays out of the model.
  assert.equal((await page.$$("[data-reject]")).length, 1);
  for (const b of await page.$$("[data-reject]")) await b.click();
  assert.match(await e.summary("customer"), /confirmed$/);

  // Requirements: every one came from the notes, each with its sentence as evidence; the origin popover can still change one.
  await e.next("requirements");
  assert.equal(await page.inputValue('[data-shared="data_today"]'), "500");
  assert.equal(await page.inputValue('[data-shared="fill_limit"]'), "0.7");
  assert.equal(await page.inputValue('[data-shared="sites"]'), "2");
  assert.equal(await page.inputValue('[data-shared="admin_cost"]'), "60000");
  await e.origin("shared|admin_cost", "customer", "discovery call, 12 Sept: about £60k a year");
  assert.equal(await e.summary("requirements"), "10 of 10 known · infrastructure");

  // Options: the three the question starts with, and the competitor is the cloud.
  await e.next("options");
  await page.fill('[data-optname="o2"]', "Competitor A (cloud)");

  // Each option's numbers, typed; the competitor's raw capacity per unit is the interpreter's confirmed figure for the current environment, and not ours.
  await e.next("inputs");
  for (const [k, v] of Object.entries(OURS)) await e.number(`[data-opt="o1"][data-in="${k}"]`, v);
  for (const [k, v] of Object.entries(CURRENT)) await e.number(`[data-opt="o0"][data-in="${k}"]`, v);
  assert.equal(await page.inputValue('[data-opt="o0"][data-in="unit_tb"]'), "100", "from the notes, read by the model, confirmed");
  assert.equal(await page.inputValue('[data-opt="o0"][data-in="support_rate"]'), "0.2", "from the interpreter, confirmed");
  for (const [k, v] of Object.entries(RIVAL)) await e.number(`[data-opt="o2"][data-in="${k}"]`, v);
  // Origins: two set one at a time, the rest of each column in one go, and one left as the customer's own figure.
  await e.origin("o1|migration", "quote", "our quote Q-1042, fixed price");
  await e.origin("o2|migration", "assumption", "nobody has priced it");
  await e.bulkOrigin("o1", "quote", "our quote Q-1042");
  await e.bulkOrigin("o0", "customer", "their current supplier's refresh quote, forwarded 15 Sept");
  await e.bulkOrigin("o2", "published", "their public price list, three-year commitment");
  assert.equal(await e.summary("inputs"), "Every needed number is in");

  // Nothing required is missing, and the answer appears.
  await e.next("missing");
  assert.match(await e.text("#body-missing"), /Required 0/);
  await e.next("answer");
  const answers = await e.text("#body-answer");
  assert.match(answers, /5-year TCO/);
  await page.click("#answer-go");
  await page.waitForSelector(".answer");

  // Results: the headline is our total; the comparisons are signed and read plainly.
  const headline = await e.text(".answer .big");
  assert.match(headline, /^£[\d.]+m$/);
  const vs = await e.text(".vs");
  assert.match(vs, /Compared with Current environment .*(lower|higher)/);
  assert.match(vs, /Compared with Competitor A \(cloud\)/);
  // A what-if copies the model: the original column stays.
  await page.click('[data-q="0"]');
  const scen = await e.text("#scen-table");
  assert.match(scen, /Original answer/);
  assert.match(scen, /What if growth is 40% instead of 30%/);

  // Why?: the tree, a line's story, and the toolkit's verdict on the files.
  await page.click("#answer [data-why]");
  await page.waitForSelector("#explain-tree details");
  await page.locator('#explain-tree summary[data-node$="|infra_hardware"], #explain-tree summary[data-node$="|hardware"]').first().click();
  const detail = await e.text("#detail");
  assert.match(detail, /Calculation/);
  assert.match(detail, /units needed by the end × price per unit, bought × \(1 − discount, as a fraction\)/);
  await page.click("#expert-more summary");
  await e.settled();
  const checks = await e.text("#checks");
  assert.match(checks, /pass every check/);
  assert.match(checks, /Competitor A \(cloud\): migration, once is an assumption, while ours is from a quote/);

  // The files the page wrote, held to the book's own toolkit at the pinned commit.
  const files = await e.files();
  assert.deepEqual(Object.keys(files).sort(), ["model.yaml", "scenarios/o0.yaml", "scenarios/o2.yaml", "scenarios/reference.yaml"]);
  assert.match(files["model.yaml"].replace(/\s+/g, " "), /Customer: “Customer has 500 TB of usable data today[^”]*” \(suggested by the on-device interpreter\)/);
  assert.match(files["model.yaml"], /Quote: our quote Q-1042\b/);
  assert.match(files["model.yaml"], /Quote: our quote Q-1042, fixed price/, "a figure said one at a time keeps its own evidence");
  assert.match(files["scenarios/o2.yaml"], /migration: Assumption: nobody has priced it/);
  assert.match(files["scenarios/o0.yaml"], /support_rate: 0.2/);
  const shown = await page.evaluate(() => { const a = globalThis.__v2; const o = a.state.options.find((x) => x.ours); return a.evaluate(o).values.get("total_cost").value; });
  const verdict = book(files);
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict));
    assert.equal(verdict.classification, "conditional");
    assert.ok(close(verdict.points.reference.total_cost, shown), `${verdict.points.reference.total_cost} vs ${shown}`);
    assert.ok(verdict.points.o2.total_cost > 0);
  }
  assert.deepEqual(e.errors, []);
  await e.context.close();
});

test("a sizing question needs no prices, and the answer says which resource sets it", async () => {
  const e = await Engineer.start();
  const { page } = e;
  await page.click('[data-type="sizing"]');
  await page.fill("#notes", NOTES);
  await page.click("#go-find");
  await page.waitForSelector(".cands");
  await page.click("#confirm-all");
  for (const b of await page.$$("[data-reject]")) await b.click();
  await e.next("requirements");
  assert.equal(await page.$eval('[data-rq="power_price"] .badge', (el) => el.textContent), "Optional", "a sizing question does not need the electricity price");
  await e.next("options");
  await e.next("inputs");
  for (const k of ["unit_cores", "unit_memory", "unit_tb", "protection"]) await e.number(`[data-opt="o1"][data-in="${k}"]`, OURS[k]);
  for (const k of ["unit_cores", "unit_memory", "protection"]) await e.number(`[data-opt="o0"][data-in="${k}"]`, CURRENT[k]);
  assert.equal(await e.summary("inputs"), "Every needed number is in", "no price was asked for");
  await e.next("missing");
  assert.match(await e.text("#body-missing"), /Required 0/);
  await page.click("#go-results");
  await page.waitForSelector(".answer");
  assert.match(await e.text(".answer"), /units needed by the end/);
  assert.match(await e.text("#cost-table"), /Set by (processor|memory|data)/);
  assert.deepEqual(e.errors, []);
  await e.context.close();
});

test("v2 works with no network once it has loaded", async () => {
  const e = await Engineer.start();
  await e.page.evaluate(() => navigator.serviceWorker.ready);
  await e.page.reload();
  await e.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await e.context.setOffline(true);
  await e.page.reload();
  await e.page.waitForSelector("#types button");
  await e.page.click("#go-skip");
  await e.page.waitForSelector("#body-requirements");
  assert.match(await e.summary("requirements"), /of 10 known/);
  assert.deepEqual(e.errors.filter((x) => !/Failed to load resource/.test(x)), []);
  await e.context.close();
});

test("the interview asks for what is missing, one question at a time, and each answer is confirmed before it goes in", async () => {
  const e = await Engineer.start();
  const { page } = e;
  await page.click('[data-type="sizing"]');
  await page.click("#go-skip");
  await page.waitForSelector("#body-requirements");
  await e.next("options");
  await e.next("inputs");
  await e.next("missing");
  const before = await e.text("#body-missing");
  assert.match(before, /Required \d+/);
  await page.click("#iv-start");
  await page.waitForSelector(".iv-q");
  // The first question is a customer requirement, in fixed words from the model.
  assert.match(await e.text(".iv-q"), /^What is the customer's/);
  // An answer in the engineer's words is read by the stand-in model into a figure, shown, and confirmed.
  await page.fill("#iv-answer", "half a petabyte, maybe a bit more");
  await page.click("#iv-go");
  await page.waitForSelector("#iv-confirm");
  assert.match(await e.text(".iv-cand"), /500 TB.*read from “half a petabyte, maybe a bit more” by the on-device model/);
  await page.click("#iv-confirm");
  await page.waitForSelector(".iv-q");
  // The requirement now holds the figure, from the customer, with the answer as evidence.
  assert.equal(await page.evaluate(() => globalThis.__v2.state.doc.nodes.find((n) => n.name === "data_today").value), 500);
  assert.match(await page.evaluate(() => globalThis.__v2.state.doc.nodes.find((n) => n.name === "data_today").provenance.source), /^Customer: “half a petabyte/);
  // "Don't know" leaves the blank and moves on; nothing is filled in.
  const asked = await e.text(".iv-q");
  await page.click("#iv-unknown");
  await page.waitForSelector(".iv-q");
  assert.notEqual(await e.text(".iv-q"), asked);
  // An answer with no figure is not a figure.
  await page.fill("#iv-answer", "they couldn't say");
  await page.click("#iv-go");
  await page.waitForSelector("#iv-blank");
  assert.match(await e.text(".iv-cand"), /No figure in that answer/);
  await page.click("#iv-blank");
  await page.waitForSelector(".iv-q");
  // Enter answers too; a plain number is read and confirmed with the Enter key path.
  await page.fill("#iv-answer", "30%");
  await page.press("#iv-answer", "Enter");
  await page.waitForSelector("#iv-confirm");
  await page.click("#iv-confirm");
  await page.waitForSelector(".iv-q");
  // An option's figure can be marked the same as ours instead of answered.
  for (let k = 0; k < 40; k += 1) {
    const q = await e.text(".iv-q");
    if (/^For /.test(q) && (await page.$("#iv-same"))) break;
    await page.fill("#iv-answer", "12");
    await page.click("#iv-go");
    await page.waitForSelector("#iv-confirm");
    await page.click("#iv-confirm");
    await page.waitForSelector(".iv");
    if (!(await page.$(".iv-q"))) break;
  }
  if (await page.$("#iv-same")) { await page.click("#iv-same"); await page.waitForSelector(".iv"); }
  assert.deepEqual(e.errors, []);
  await e.context.close();
});

test("with WebGPU but no model loaded, starting with notes offers the download once; declined, nothing reads the notes", async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await context.addInitScript(() => { Object.defineProperty(navigator, "gpu", { value: {}, configurable: true }); });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (x) => errors.push(x.message));
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => /available/.test(document.getElementById("engine-chip").textContent));
  await page.fill("#notes", NOTES);
  await page.click("#go-find");
  await page.waitForSelector("#ai-go");
  assert.match(await page.$eval("#ai-notice", (x) => x.textContent), /Read the notes with a model on this device\?/);
  await page.click("#ai-later");
  assert.equal(await page.$eval("#ai-notice", (x) => x.hidden), true);
  // Declined: no candidate appears from anywhere, the notes are kept, and the optional button is still there to change one's mind.
  assert.equal(await page.$(".cands"), null, "nothing read the notes by matching words");
  assert.match(await page.$eval('[data-sum="customer"]', (x) => x.textContent), /Notes kept; no candidates yet/);
  assert.equal(await page.inputValue("#notes2"), NOTES);
  assert.ok(await page.$("#use-ai"), "the optional button is still there to change one's mind");
  await page.reload();
  await page.waitForSelector("#body-customer");
  assert.equal(await page.$eval("#ai-notice", (x) => x.hidden), true, "declined once, not asked again");
  assert.deepEqual(errors, []);
  await context.close();
});
