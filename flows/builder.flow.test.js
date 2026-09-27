/*
 * The builder, driven in a real browser the way a reader drives it, and the files it writes
 * handed to the book's own toolkit.
 *
 * Each flow answers the builder's questions screen by screen, typing every number itself: the
 * test is the reader. Before any number field is filled, the flow checks it is empty, so a screen
 * that filled a number in would fail here. At the end the files the builder wrote go to
 * conformance/check-files.py, which loads them with the book's toolkit at the pinned commit and
 * runs verify-models.py's checks over them; the flow fails if the book refuses them, or if its
 * values differ from what the flow expects.
 *
 *     npm run flows            (needs Chromium; Python 3.11 for the book's side)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

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
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: chromiumPath() });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/* A reader at the keyboard. */
class Reader {
  constructor(page) {
    this.page = page;
    this.errors = [];
    page.on("pageerror", (e) => this.errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") this.errors.push(m.text()); });
  }
  static async start(options = {}) {
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1400, height: 950 } });
    const page = await context.newPage();
    const reader = new Reader(page);
    reader.context = context;
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector(".goal");
    return reader;
  }
  next() {
    return this.page.click("#wnext");
  }
  async problem() {
    const text = await this.page.locator("#wmsg").textContent().catch(() => "");
    return (text ?? "").trim();
  }
  /* The builder never fills a number in: the field is empty until the reader types one. */
  async number(selector, value) {
    const now = await this.page.inputValue(selector);
    assert.equal(now, "", `${selector} held ${now} before the reader typed anything`);
    await this.page.fill(selector, String(value));
  }
  /* The builder's verdict comes from a worker: wait for the latest before reading it. */
  async settled() {
    await this.page.evaluate(() => builder.settled());
  }
  async coach() {
    await this.settled();
    return this.page.evaluate(() => builder.next);
  }
  async answer({ goal = "other", name, label, unit, decision }) {
    await this.page.click(`[data-goal="${goal}"]`);
    await this.page.fill("#w-name", name);
    await this.page.fill("#w-label", label);
    await this.page.fill("#w-unit", unit);
    await this.next();
    await this.page.fill("#w-decision", decision);
    await this.next();
  }
  async horizon(years, source) {
    await this.page.click("#coach button.primary");
    await this.page.click('[data-today="no"]');
    await this.next();
    await this.page.click('[data-prov="assumption"]');
    await this.page.fill("#w-source", source);
    await this.next();
    await this.page.click('[data-sure="one"]');
    await this.number("#w-value", years);
    await this.next();
    await this.next();
  }
  async forToday() {
    await this.page.click("#coach button.primary");
    await this.page.click('[data-today="yes"]');
    await this.next();
  }
  /* Define whatever the builder asks for next, from a table of what the reader knows. */
  async defineAll(known) {
    for (let guard = 0; guard < 40; guard += 1) {
      const next = await this.coach();
      if (next.id !== "define") return next;
      const spec = known[next.name];
      assert.ok(spec, `the builder asked for ${next.name}, which the flow does not know`);
      await this.page.click("#coach button.primary");
      await this.define(spec);
      const left = await this.page.isVisible("#wizard");
      assert.ok(!left, `the wizard is still open after defining ${next.name}: ${await this.problem()}`);
    }
    throw new Error("too many names to define");
  }
  async define(spec) {
    const p = this.page;
    await p.click(`[data-kind="${spec.kind}"]`);
    await this.next();
    if (spec.kind === "measured") {
      await p.click(`[data-result="${spec.result}"]`);
      await this.next();
      await this.next();
      await this.next();
      return;
    }
    await this.next(); // name
    if (await p.locator("[data-qkind]").count()) {
      assert.ok(spec.unit, "the builder asked for a unit the flow did not expect to give");
      await p.fill("#w-unit", spec.unit);
      await this.next();
    }
    if (spec.kind === "derived") {
      await p.fill("#w-formula", spec.formula);
      await this.next();
      await this.next();
      return;
    }
    await p.click(`[data-decided="${spec.decided}"]`);
    await this.next();
    await p.click(`[data-prov="${spec.prov}"]`);
    await p.fill("#w-source", spec.source);
    await this.next();
    if (spec.shape) {
      await p.click('[data-sure="shape"]');
      await p.click(`[data-shape="${spec.shape}"]`);
      for (const [field, value] of Object.entries(spec.parameters)) await this.number(`#w-p-${field}`, value);
    } else if (spec.value === null) {
      await p.click('[data-sure="none"]');
    } else {
      await p.click('[data-sure="one"]');
      await this.number("#w-value", spec.value);
    }
    await this.next();
    await this.next();
  }
  async files() {
    await this.settled();
    return this.page.evaluate(() => builder.files);
  }
  async checks() {
    await this.settled();
    return this.page.evaluate(() => builder.checks);
  }
}

/* The book's verdict on files the builder wrote, or null where Python is not available. */
function book(files) {
  if (process.env.SKIP_BOOK) return null;
  const dir = mkdtempSync(join(tmpdir(), "builder-"));
  mkdirSync(join(dir, "scenarios"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  let out;
  try {
    out = execFileSync("python3", [join(ROOT, "conformance/check-files.py"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    out = error.stdout;
  }
  return JSON.parse(out.trim().split("\n").at(-1));
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/* One sheet of an .xlsx as LibreOffice Calc works it out, as rows of text; null without it. */
function recalculated(file, sheet) {
  try {
    execFileSync("soffice", ["--version"], { stdio: "ignore" });
  } catch {
    if (process.env.REQUIRE_SOFFICE) throw new Error("REQUIRE_SOFFICE is set and LibreOffice (soffice) is not installed");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "builder-xlsx-"));
  const copy = join(dir, "book.xlsx");
  writeFileSync(copy, readFileSync(file));
  execFileSync("soffice", [`-env:UserInstallation=file://${join(dir, "profile")}`, "--headless", "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", "--outdir", dir, copy], { stdio: "ignore", timeout: 120000 });
  return readFileSync(join(dir, `book-${sheet}.csv`), "utf8").trim().split("\n").map((line) => line.split(","));
}

// -- the flows ------------------------------------------------------------------------------------

const DEMAND = {
  peak_request_rate_t0: { kind: "input", decided: "outside", prov: "assumption", source: "the busy hour, as the service's owners estimate it", value: 8000 },
  stored_data_t0: { kind: "input", decided: "outside", prov: "assumption", source: "what the service holds today, before copies or compression", value: 15 },
  annual_growth: { kind: "input", decided: "outside", prov: "assumption", source: "the growth the team plans for", value: 1.3 },
  horizon_periods: { kind: "derived", formula: "horizon / one_year" },
  one_year: { kind: "input", decided: "definition", prov: "fact", source: "definition", value: 1 },
};

test("the book's chapter-two demand model, rebuilt answer first, is the book's", async () => {
  const r = await Reader.start();
  await r.answer({ name: "peak_request_rate", label: "peak request rate at the horizon", unit: "request/second", decision: "Size the service's front end for the busy hour at the end of the refresh." });
  await r.horizon(5, "the refresh cycle this fleet is bought against");
  await r.page.click("#coach button.primary");
  await r.define({ kind: "derived", formula: "peak_request_rate_t0 * annual_growth ** horizon_periods" });
  await r.page.click("#add-output");
  await r.page.fill("#w-name", "stored_data");
  await r.page.fill("#w-label", "records held at the horizon");
  await r.page.fill("#w-unit", "TB");
  await r.next();
  await r.defineAll({ ...DEMAND, stored_data: { kind: "derived", formula: "stored_data_t0 * annual_growth ** horizon_periods" } });
  const checks = await r.checks();
  assert.equal(checks[0].level, "pass", JSON.stringify(checks));
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict));
    assert.equal(verdict.classification, "definitional");
    const stage = JSON.parse(readFileSync(join(ROOT, "conformance/fixtures/cases/stages/05-demand.json"), "utf8"));
    for (const output of ["peak_request_rate", "stored_data"]) {
      assert.ok(close(verdict.points.reference[output], stage.scenarios.reference.point[output]), `${output}: ${verdict.points.reference[output]}`);
    }
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("a model whose formula does not fix its names' units asks for them", async () => {
  const r = await Reader.start();
  await r.answer({ name: "utilisation", label: "processor utilisation", unit: "dimensionless", decision: "Whether the current fleet can take the busy hour." });
  await r.forToday();
  await r.page.click("#coach button.primary");
  await r.define({ kind: "derived", formula: "busy_cores / cores" });
  const next = await r.defineAll({
    busy_cores: { kind: "derived", unit: "core", formula: "request_rate * service_demand" },
    cores: { kind: "input", unit: "core", decided: "you", prov: "assumption", source: "the fleet as it stands", value: 16 },
    request_rate: { kind: "input", unit: "request/second", decided: "outside", prov: "assumption", source: "the busy hour, from the dashboard", value: 200 },
    // No unit: once request_rate is defined, it is the one unknown left in busy_cores' product.
    service_demand: { kind: "input", decided: "outside", prov: "vendor_claim", source: "the framework's published figure", value: 0.02 },
  });
  const inferred = await r.page.evaluate(() => {
    const unit = builder.state.doc.nodes.find((n) => n.name === "service_demand").unit;
    return builder.ctx.registry.parse(unit);
  });
  assert.deepEqual(inferred, { core: 1, second: 1, request: -1 });
  assert.equal(next.id, "refine");
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict));
    assert.ok(close(verdict.points.reference.utilisation, 0.25));
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("the build's refusals are the wizard's gates", async () => {
  const r = await Reader.start();
  await r.answer({ name: "total", label: "total", unit: "USD", decision: "A price for the board." });
  await r.forToday();
  await r.page.click("#coach button.primary");
  await r.page.click('[data-kind="input"]');
  await r.next();
  await r.next();
  await r.page.click('[data-decided="outside"]');
  await r.next();
  // A fact that cites nothing does not build.
  await r.page.click('[data-prov="fact"]');
  await r.page.fill("#w-source", "everybody knows this");
  await r.next();
  assert.match(await r.problem(), /cite/);
  await r.page.fill("#w-source", "invoice 2026-114");
  await r.next();
  // A shape its source does not name does not build.
  await r.page.click('[data-sure="shape"]');
  await r.page.click('[data-shape="triangular"]');
  await r.number("#w-p-minimum", 10);
  await r.number("#w-p-likely", 5);
  await r.number("#w-p-maximum", 20);
  await r.next();
  assert.match(await r.problem(), /order/);
  await r.page.fill("#w-p-likely", "12");
  await r.next();
  assert.match(await r.problem(), /[Nn]ame the shape/);
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("an input with no number yet is not yet measured, and so is everything downstream", async () => {
  const r = await Reader.start();
  await r.answer({ name: "stored", label: "stored", unit: "TB", decision: "Order disks." });
  await r.forToday();
  await r.page.click("#coach button.primary");
  await r.define({ kind: "derived", formula: "held * copies" });
  await r.defineAll({
    held: { kind: "input", unit: "TB", decided: "outside", prov: "assumption", source: "not counted yet", value: null },
    copies: { kind: "input", unit: "dimensionless", decided: "you", prov: "assumption", source: "the replication policy", value: 3 },
  });
  const states = await r.page.evaluate(() => Object.fromEntries([...builder.previewed.values].map(([k, v]) => [k, v.state])));
  assert.equal(states.held, "not-yet-measured");
  assert.equal(states.stored, "not-yet-measured");
  const checks = await r.checks();
  assert.ok(checks.some((c) => c.level === "fail" && /no number/.test(c.text)), JSON.stringify(checks));
  const verdict = book(await r.files());
  if (verdict) assert.ok(!verdict.ok, "the book refuses a scenario with an input that has no number, and so does the builder");
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("the page fits a phone's width", async () => {
  const r = await Reader.start({ viewport: { width: 390, height: 844 } });
  await r.answer({ name: "peak_request_rate", label: "peak request rate", unit: "request/second", decision: "Size the front end." });
  await r.forToday();
  const overflow = await r.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("on a phone, the question and its buttons fit the screen, and the label fits the answer", async () => {
  const r = await Reader.start({ viewport: { width: 360, height: 740 } });
  const p = r.page;
  await p.click('[data-goal="cost"]');
  assert.equal(await p.inputValue("#w-label"), "total cost");
  const fit = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll("#wizard *")].filter((e) => e.getBoundingClientRect().right > vw + 1).map((e) => e.id || e.tagName);
    return { outside, next: document.getElementById("wnext").getBoundingClientRect().right <= vw, scroll: document.documentElement.scrollWidth - vw };
  });
  assert.deepEqual(fit, { outside: [], next: true, scroll: 0 });
  await p.click("#wcancel");
  await p.click("#new");
  await p.click('[data-goal="hosts"]');
  assert.equal(await p.inputValue("#w-label"), "hosts to buy");
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("it opens the book's own models and agrees with the book about them", async () => {
  const r = await Reader.start();
  for (const id of ["demand", "web_service", "observability"]) {
    await r.page.evaluate(() => builder.startOver());
    await r.page.click(`[data-example="${id}"]`);
    const checks = await r.checks();
    assert.equal(checks[0].level, "pass", `${id}: ${JSON.stringify(checks.slice(0, 3))}`);
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("it works with no network once it has loaded", async () => {
  const r = await Reader.start();
  await r.page.evaluate(() => navigator.serviceWorker.ready);
  await r.page.reload();
  await r.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await r.context.setOffline(true);
  await r.page.reload();
  await r.page.waitForSelector(".goal");
  await r.answer({ name: "hosts", label: "hosts", unit: "host", decision: "Order machines." });
  assert.equal((await r.coach()).id, "horizon");
  assert.deepEqual(r.errors.filter((e) => !/Failed to load resource/.test(e)), []);
  await r.context.close();
});

test("a host count, refined: the hosts question, a measurement, a ceiling, ranges, a pair, a scenario, measure first", async () => {
  const r = await Reader.start();
  const p = r.page;
  await r.answer({ goal: "hosts", name: "hosts", label: "hosts to buy", unit: "host", decision: "The hardware order for the next refresh." });
  // Nothing grows in this model, and a horizon nothing uses feeds no answer, which the book refuses.
  await r.forToday();
  // The hosts question: one kind of host, two resources that could bind.
  assert.equal((await r.coach()).id, "hosts");
  await p.click("#coach button.primary");
  await p.click('[data-hosts="one"]');
  await p.check('[data-chain="requests"]');
  await p.check('[data-chain="storage"]');
  await r.next();
  assert.equal(await p.evaluate(() => builder.state.doc.nodes.find((n) => n.name === "hosts").formula), "max(hosts_for_requests, hosts_for_storage)");
  await r.defineAll({
    hosts_for_requests: { kind: "derived", formula: "ceil(busy_cores / (cores_per_host * (1 - queueing_margin)))" },
    hosts_for_storage: { kind: "derived", formula: "ceil(stored_data * replication_factor / record_compression / disk_per_host)" },
    busy_cores: { kind: "derived", unit: "core", formula: "request_rate * service_demand" },
    cores_per_host: { kind: "input", unit: "core/host", decided: "you", prov: "vendor_claim", source: "the quoted specification", value: 32 },
    queueing_margin: { kind: "input", decided: "you", prov: "assumption", source: "the margin kept below the knee", value: 0.3 },
    stored_data: { kind: "input", unit: "TB", decided: "outside", prov: "assumption", source: "what is held today", value: 40 },
    replication_factor: { kind: "input", unit: "dimensionless", decided: "you", prov: "assumption", source: "three copies", value: 3 },
    record_compression: { kind: "measured", result: "records-compression" },
    disk_per_host: { kind: "input", unit: "TB/host", decided: "you", prov: "vendor_claim", source: "the quoted specification", value: 8 },
    request_rate: { kind: "input", unit: "request/second", decided: "outside", prov: "assumption", source: "triangular: the owners' least, likely and most for the busy hour", shape: "triangular", parameters: { minimum: 3000, likely: 8000, maximum: 20000 } },
    service_demand: { kind: "input", decided: "outside", prov: "assumption", source: "lognormal: processor time per request cannot go negative", shape: "lognormal", parameters: { p10: 0.004, p90: 0.012 } },
  });
  // A measured constant and no ceiling: the book refuses it, so the builder says fix it first.
  let next = await r.coach();
  assert.equal(next.id, "fix");
  assert.equal(next.check.code, "classification.measured-without-ceiling");
  await p.click('[data-refine="ceiling"]');
  await p.fill("#w-name", "queueing_headroom");
  await p.fill("#w-label", "utilisation at the busy hour");
  await r.next();
  await p.fill("#w-of", "busy_cores / (hosts * cores_per_host)");
  await p.fill("#w-limit", "1");
  await p.fill("#w-headroom", "queueing_margin");
  await r.next();
  assert.match(await r.problem(), /why/);
  await p.fill("#w-because", "Past the knee the queue grows faster than the load, and response time goes with it.");
  await r.next();
  await r.next();
  next = await r.coach();
  assert.equal(next.id, "refine", JSON.stringify(next));
  // Sources, read.
  assert.equal(next.refine.id, "sources");
  await p.click("#coach button.primary");
  assert.match(await p.textContent("#panel"), /Vendors' claims/);
  // The ceiling is done; ranges: the stored data stays one number, and says so.
  next = await r.coach();
  assert.equal(next.refine.id, "ranges");
  await p.click("#coach button.primary");
  await p.click('[data-act="keep"]');
  // Measure first: the page's bars are the book's tornado, in the same order.
  next = await r.coach();
  assert.equal(next.refine.id, "measure");
  await p.click("#coach button.primary");
  const bars = await p.evaluate(() => [...document.querySelectorAll("[data-bar]")].map((b) => b.dataset.bar));
  assert.ok(bars.length >= 3, JSON.stringify(bars));
  // Inputs that move together, with a reason.
  await p.click('[data-tab="together"]');
  await p.selectOption("#c-a", "request_rate");
  await p.selectOption("#c-b", "service_demand");
  await p.fill("#c-r", "0.4");
  await p.click("#c-add");
  assert.match(await p.textContent("#c-msg"), /why/);
  await p.fill("#c-w", "A busier service is usually slower per request.");
  await p.click("#c-add");
  // A second case, as a scenario.
  next = await r.coach();
  assert.equal(next.refine.id, "scenario");
  await p.click("#coach button.primary");
  await p.fill("#s-name", "twice_the_disk");
  await p.selectOption("#s-input", "disk_per_host");
  await r.number("#s-value", 16);
  await p.fill("#s-why", "The denser host on the second quote.");
  await p.click("#s-add");
  assert.equal((await r.coach()).id, "done");
  // Inputs with shapes give every answer a range, drawn as the book draws them.
  const ranges = await p.evaluate(() => builder.ranges);
  assert.ok(ranges.outputs.hosts.p5 <= ranges.outputs.hosts.p95 && ranges.samples === 100000, JSON.stringify(ranges.outputs));
  assert.match(await p.textContent("#answers"), /Nine in ten draws between/);
  assert.ok(ranges.ceilings.queueing_headroom.p_over_allowed >= 0);
  if (process.env.SHOTS) {
    await p.click('[data-tab="measure"]');
    await p.screenshot({ path: `${process.env.SHOTS}/refined.png` });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: `${process.env.SHOTS}/refined-phone.png`, fullPage: false });
    await p.setViewportSize({ width: 1400, height: 950 });
  }
  assert.equal(await p.textContent("#klass"), "conditional model");
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.classification, "conditional");
    assert.deepEqual(Object.keys(verdict.points).sort(), ["reference", "twice_the_disk"]);
    assert.deepEqual(bars, verdict.tornado.hosts.map((b) => b.node));
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("the hosts question, several roles: the pools add up", async () => {
  const r = await Reader.start();
  const p = r.page;
  await r.answer({ goal: "hosts", name: "fleet", label: "machines in the fleet", unit: "host", decision: "The platform's machine count for the budget." });
  await r.forToday();
  await p.click("#coach button.primary");
  await p.click('[data-hosts="roles"]');
  await p.fill("#w-roles", "collectors, store");
  await r.next();
  assert.equal(await p.evaluate(() => builder.state.doc.nodes.find((n) => n.name === "fleet").formula), "collectors_hosts + store_hosts");
  await r.defineAll({
    collectors_hosts: { kind: "input", decided: "you", prov: "assumption", source: "the ingest tier as sized", value: 6 },
    store_hosts: { kind: "input", decided: "you", prov: "assumption", source: "the retention tier as sized", value: 12 },
  });
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.points.reference.fleet, 18);
  }
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/roles.png` });
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

/* The first pattern the formula screen offers for the next name to define, then back out. */
async function firstPattern(r) {
  const p = r.page;
  await p.click("#coach button.primary");
  await p.click('[data-kind="derived"]');
  await r.next();
  await r.next(); // name
  const first = await p.locator(".sug[data-formula]").first().getAttribute("data-formula");
  await p.click("#wcancel");
  return first;
}

test("the hosts question, several generations: new hosts to buy, given the old, spread by capacity", async () => {
  const r = await Reader.start();
  const p = r.page;
  await r.answer({ goal: "hosts", name: "new_hosts", label: "new hosts to buy", unit: "host", decision: "How many new hosts to order while last generation's stay in service." });
  await r.forToday();
  await p.click("#coach button.primary");
  await p.click('[data-hosts="generations"]');
  await p.check('[data-chain="requests"]');
  await p.check('[data-chain="storage"]');
  // The routing question arrives with the requests chain, and the builder will not go on without it.
  await r.next();
  assert.match(await r.problem(), /spread/);
  await p.click('[data-routing="capacity"]');
  await r.next();
  assert.equal(await p.evaluate(() => builder.state.doc.nodes.find((n) => n.name === "new_hosts").formula), "max(new_for_requests, new_for_storage)");
  // The book's own pattern for the chain comes first.
  assert.equal(await firstPattern(r), "ceil((max(busy_cores / (1 - queueing_margin), old_cores) - old_cores) / cores_per_new_host)");
  await r.defineAll({
    new_for_requests: { kind: "derived", formula: "ceil((max(busy_cores / (1 - queueing_margin), old_cores) - old_cores) / cores_per_new_host)" },
    new_for_storage: { kind: "derived", formula: "ceil((max(raw_data / (1 - disk_margin), old_disk) - old_disk) / disk_per_new_host)" },
    busy_cores: { kind: "derived", unit: "core", formula: "request_rate * service_demand" },
    request_rate: { kind: "input", unit: "request/second", decided: "outside", prov: "assumption", source: "the busy hour, as the owners estimate it", value: 8000 },
    service_demand: { kind: "input", unit: "core*second/request", decided: "outside", prov: "assumption", source: "processor time per request, from the owners' profiling", value: 0.01 },
    queueing_margin: { kind: "input", decided: "you", prov: "assumption", source: "the margin kept below the knee", value: 0.3 },
    old_cores: { kind: "derived", formula: "old_hosts * cores_per_old_host" },
    old_hosts: { kind: "input", decided: "outside", prov: "assumption", source: "the hosts still in service, from the asset list", value: 4 },
    cores_per_old_host: { kind: "input", unit: "core/host", decided: "outside", prov: "assumption", source: "last generation's specification", value: 16 },
    cores_per_new_host: { kind: "input", unit: "core/host", decided: "you", prov: "vendor_claim", source: "the quoted specification", value: 32 },
    raw_data: { kind: "input", unit: "TB", decided: "outside", prov: "assumption", source: "what is held with its copies", value: 100 },
    disk_margin: { kind: "input", decided: "you", prov: "assumption", source: "the margin kept below full", value: 0.2 },
    old_disk: { kind: "derived", formula: "old_hosts * disk_per_old_host" },
    disk_per_old_host: { kind: "input", unit: "TB/host", decided: "outside", prov: "assumption", source: "last generation's specification", value: 8 },
    disk_per_new_host: { kind: "input", unit: "TB/host", decided: "you", prov: "vendor_claim", source: "the quoted specification", value: 16 },
  });
  // Requests: 80 cores / 0.7, less 64 old, in 32-core hosts, is 2. Disk: 100 TB / 0.8, less 32 old, in 16 TB hosts, is 6.
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.points.reference.new_hosts, 6);
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("the hosts question, several generations spread evenly: the smallest host sets the pace", async () => {
  const r = await Reader.start();
  const p = r.page;
  await r.answer({ goal: "hosts", name: "new_hosts", label: "new hosts to buy", unit: "host", decision: "How many new hosts to order." });
  await r.forToday();
  await p.click("#coach button.primary");
  await p.click('[data-hosts="generations"]');
  await p.check('[data-chain="requests"]');
  await p.click('[data-routing="equal"]');
  await r.next();
  assert.equal(await p.evaluate(() => builder.state.doc.nodes.find((n) => n.name === "new_hosts").formula), "new_for_requests");
  assert.equal(await firstPattern(r), "max(ceil(busy_cores / (smallest_cores * (1 - queueing_margin))), old_hosts) - old_hosts");
  await r.defineAll({
    new_for_requests: { kind: "derived", formula: "max(ceil(busy_cores / (smallest_cores * (1 - queueing_margin))), old_hosts) - old_hosts" },
    busy_cores: { kind: "input", unit: "core", decided: "outside", prov: "assumption", source: "the busy hour's processor load, from the owners", value: 80 },
    smallest_cores: { kind: "derived", formula: "min(cores_per_old_host, cores_per_new_host)" },
    cores_per_old_host: { kind: "input", unit: "core/host", decided: "outside", prov: "assumption", source: "last generation's specification", value: 16 },
    cores_per_new_host: { kind: "input", unit: "core/host", decided: "you", prov: "vendor_claim", source: "the quoted specification", value: 32 },
    queueing_margin: { kind: "input", decided: "you", prov: "assumption", source: "the margin kept below the knee", value: 0.3 },
    old_hosts: { kind: "input", decided: "outside", prov: "assumption", source: "the hosts still in service, from the asset list", value: 4 },
  });
  // Every host at 16 cores' pace: 80 / (16 * 0.7) needs 8 hosts, 4 of which are old.
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.points.reference.new_hosts, 4);
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("a cost in euros: the currency is the reader's, and the book accepts it", async () => {
  const r = await Reader.start();
  const p = r.page;
  await p.click('[data-goal="cost"]');
  assert.equal(await p.inputValue("#w-unit"), "USD");
  await p.selectOption("#w-currency", "EUR");
  // The answer's unit moves with the currency; the unit chips offer the new one.
  assert.equal(await p.inputValue("#w-unit"), "EUR");
  assert.equal(await p.locator('[data-unit="EUR"]').count(), 1);
  await p.fill("#w-name", "purchase");
  await p.fill("#w-label", "the purchase");
  await r.next();
  await p.fill("#w-decision", "The budget line for the order.");
  await r.next();
  await r.forToday();
  await r.defineAll({
    purchase: { kind: "derived", formula: "hosts * host_price" },
    hosts: { kind: "input", unit: "host", decided: "you", prov: "assumption", source: "the fleet as sized", value: 10 },
    host_price: { kind: "input", unit: "EUR/host", decided: "outside", prov: "vendor_claim", source: "the supplier's quote", value: 7000 },
  });
  const files = await r.files();
  assert.match(files["model.yaml"], /\ncurrency: EUR\n/);
  const verdict = book(files);
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.points.reference.purchase, 70000);
  }
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("the table: type a given number and what is worked out from it changes; nothing else can be typed over", async () => {
  const r = await Reader.start();
  const p = r.page;
  await r.answer({ goal: "hosts", name: "fleet", label: "machines in the fleet", unit: "host", decision: "The platform's machine count." });
  await r.forToday();
  await p.click("#coach button.primary");
  await p.click('[data-hosts="roles"]');
  await p.fill("#w-roles", "collectors, store");
  await r.next();
  await r.defineAll({
    collectors_hosts: { kind: "input", decided: "you", prov: "assumption", source: "the ingest tier as sized", value: 6 },
    store_hosts: { kind: "input", decided: "you", prov: "vendor_claim", source: "the supplier's sizing", value: 12 },
  });
  await p.click('[data-view="table"]');
  assert.ok(await p.isHidden("#graph-wrap"));
  const value = (name) => p.locator(`tr[data-row="${name}"] td.num`).innerText();
  assert.equal((await value("fleet")).trim(), "18");
  // A worked-out value has no cell to type into; a given one does.
  assert.equal(await p.locator('tr[data-row="fleet"] [data-cell]').count(), 0);
  await p.fill('[data-cell="collectors_hosts"]', "8");
  await p.press('[data-cell="collectors_hosts"]', "Enter");
  await r.settled();
  assert.equal((await value("fleet")).trim(), "20");
  // Enter moved on to the next number.
  assert.equal(await p.evaluate(() => document.activeElement?.dataset.cell), "store_hosts");
  // Not a number: refused, and the model keeps what it had.
  await p.fill('[data-cell="store_hosts"]', "a dozen");
  await p.press('[data-cell="store_hosts"]', "Enter");
  assert.match(await p.locator("#t-msg").innerText(), /not a number/);
  assert.equal(await p.inputValue('[data-cell="store_hosts"]'), "12");
  // Filter, then sort by value, largest first.
  await p.fill("#t-filter", "supplier");
  assert.deepEqual(await p.locator("tr[data-row]").evaluateAll((rows) => rows.map((x) => x.dataset.row)), ["store_hosts"]);
  await p.fill("#t-filter", "");
  await p.click('[data-sort="value"]');
  await p.click('[data-sort="value"]');
  assert.deepEqual(await p.locator("tr[data-row]").evaluateAll((rows) => rows.map((x) => x.dataset.row)), ["fleet", "store_hosts", "collectors_hosts"]);
  // A row opens in the inspector, which walks the chain either way.
  await p.click('[data-pick="fleet"]');
  assert.deepEqual(await p.locator("#panel [data-goto]").evaluateAll((b) => b.map((x) => x.dataset.goto)), ["collectors_hosts", "store_hosts"]);
  await p.click('#panel [data-goto="store_hosts"]');
  assert.equal(await p.evaluate(() => builder.ui.selected), "store_hosts");
  // The file the book reads has the typed number, and the book agrees.
  const verdict = book(await r.files());
  if (verdict) {
    assert.ok(verdict.ok, JSON.stringify(verdict.problems));
    assert.equal(verdict.points.reference.fleet, 20);
  }
  // As a spreadsheet: downloaded from the File tab, and recalculated by a spreadsheet application.
  await p.click('[data-tab="file"]');
  const [download] = await Promise.all([p.waitForEvent("download"), p.click("#f-xlsx")]);
  assert.equal(download.suggestedFilename(), "fleet.xlsx");
  const sheet = recalculated(await download.path(), "Answers");
  if (sheet) assert.deepEqual(sheet.find((row) => row[0] === "fleet")?.slice(2, 4), ["20", "host"]);
  // On a phone, the table scrolls inside its own box; the page does not scroll sideways.
  await p.setViewportSize({ width: 360, height: 740 });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.deepEqual(r.errors, []);
  await r.context.close();
});

test("a scenario whose draws alone go wrong is refused, as the book's sampler refuses it", async () => {
  const r = await Reader.start();
  await r.answer({ name: "rooted", label: "a square root of a range", unit: "dimensionless", decision: "A test of the sampler." });
  await r.forToday();
  await r.page.click("#coach button.primary");
  await r.define({ kind: "derived", formula: "sqrt(swing)" });
  await r.defineAll({
    swing: { kind: "input", decided: "outside", prov: "assumption", source: "uniform: the ends are all that is known", shape: "uniform", parameters: { minimum: -1, maximum: 3 } },
  });
  const checks = await r.checks();
  assert.ok(checks.some((c) => c.level === "fail" && /draws/.test(c.text)), JSON.stringify(checks));
  const verdict = book(await r.files());
  if (verdict) assert.ok(!verdict.ok && verdict.problems.some((p) => /not finite/.test(p)), JSON.stringify(verdict.problems));
  assert.deepEqual(r.errors, []);
  await r.context.close();
});
