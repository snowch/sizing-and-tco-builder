/*
 * The spreadsheet export works out what the book works out.
 *
 * Every fixture model the export accepts is written as a workbook with no cached values, so that
 * the spreadsheet application has to calculate every cell itself, and LibreOffice Calc opens and
 * recalculates it. Each cell on the Model sheet must then equal the book's own value for that node
 * at the reference scenario (the fixtures hold it, from the book's Python toolkit), each ceiling's
 * verdict must be the book's, and each scenario's answers must be the book's for that scenario.
 *
 * Without LibreOffice the recalculation tests are skipped, unless REQUIRE_SOFFICE is set, as it is
 * in CI, where a skip would hide a broken export.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "../engine/formula.js";
import { formula, NotExportable, spreadsheet, workbook, workbookNames } from "../engine/spreadsheet.js";
import { column, xlsx } from "../engine/xlsx.js";

const FIXTURES = new URL("../conformance/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const manifest = read("manifest.json");
const units = read("units.json").registry;
const results = read("results.json");

// -- the translation, without a spreadsheet ---------------------------------------------------------

const as = (text, names = null) => formula(parse(text), names ?? new Map([..."abcdef"].map((n) => [n, n])));

test("formulas: a spreadsheet's precedence is written around", () => {
  // Python's unary minus binds looser than its power; a spreadsheet's binds tighter.
  assert.equal(as("-a**2"), "-(a^2)");
  assert.equal(as("(-a)**2"), "(-a)^2");
  // Python's power groups from the right; a spreadsheet's from the left.
  assert.equal(as("a**b**c"), "a^(b^c)");
  assert.equal(as("(a**b)**c"), "(a^b)^c");
  assert.equal(as("a - (b - c)"), "a-(b-c)");
  assert.equal(as("a - b - c"), "a-b-c");
  assert.equal(as("a / (b * c)"), "a/(b*c)");
  assert.equal(as("a / b * c"), "a/b*c");
  assert.equal(as("(a + b) * c"), "(a+b)*c");
  assert.equal(as("a * -b"), "a*(-b)");
  assert.equal(as("ceil(a / (b * (1 - c)))"), "_xlfn.CEILING.MATH(a/(b*(1-c)))");
  assert.equal(as("max(a, b, floor(c)) + log(d) * exp(e) - sqrt(f)"), "MAX(a,b,_xlfn.FLOOR.MATH(c))+LN(d)*EXP(e)-SQRT(f)");
  assert.equal(as("a * 1.5e-7 + 2"), "a*1.5E-7+2");
});

test("names: a node named like a cell gets a leading underscore, and case does not collide", () => {
  const names = workbookNames(["ram1", "xfd1048576", "r1c1", "r", "c", "true", "hosts", "busy_cores", "Hosts"]);
  assert.deepEqual([...names.values()], ["_ram1", "_xfd1048576", "_r1c1", "_r", "_c", "_true", "hosts", "busy_cores", "Hosts_2"]);
});

test("the writer: column letters, and a zip a reader recognises", () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(column), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  const bytes = xlsx([{ name: "S", rows: [["x", 1, { f: "B1*2", v: 2 }]] }]);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual([...bytes.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);
});

test("a model whose units do not work is not exported", () => {
  const c = read("cases/invalid/unit-declared-vs-produced.json");
  assert.throws(() => spreadsheet(c.files, { units, results: { ...results, ...c.results } }), NotExportable);
});

// -- recalculated by a spreadsheet application ---------------------------------------------------------

function soffice() {
  try {
    execFileSync("soffice", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* RFC 4180, as LibreOffice writes it. */
function csv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const close = (got, want) => Math.abs(got - want) <= 1e-9 * Math.max(Math.abs(want), 1e-300) + 1e-12;

const available = soffice();
if (!available && process.env.REQUIRE_SOFFICE) throw new Error("REQUIRE_SOFFICE is set and LibreOffice (soffice) is not installed");

test("recalculated in LibreOffice Calc, every exported model gives the book's values", { skip: !available && "LibreOffice is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "builder-xlsx-"));
  const exported = [];
  for (const id of manifest.cases) {
    const want = read(`cases/${id}.json`);
    if (!want.load.ok || !want.scenarios?.reference?.point) continue;
    const options = { units, results: { ...results, ...want.results }, cache: false };
    let sheet;
    try {
      sheet = spreadsheet(want.files, options);
    } catch (error) {
      if (error instanceof NotExportable) continue;
      throw error;
    }
    const file = `${id.replaceAll("/", "__")}.xlsx`;
    writeFileSync(join(dir, file), workbook(want.files, options));
    exported.push({ id, file, want, sheet });
  }
  assert.ok(exported.length >= 40, `only ${exported.length} models exported`);
  execFileSync("soffice", [
    `-env:UserInstallation=file://${join(dir, "profile")}`, "--headless",
    "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1",
    "--outdir", join(dir, "out"), ...exported.map((e) => join(dir, e.file)),
  ], { stdio: "ignore", timeout: 600000 });
  const written = new Set(readdirSync(join(dir, "out")));

  const problems = [];
  let cells = 0;
  for (const { id, file, want, sheet } of exported) {
    const stem = file.replace(/\.xlsx$/, "");
    if (!written.has(`${stem}-Model.csv`)) {
      problems.push(`${id}: LibreOffice did not open it`);
      continue;
    }
    const byName = new Map([...sheet.workbookNames].map(([node, name]) => [name, node]));
    const rows = csv(readFileSync(join(dir, "out", `${stem}-Model.csv`), "utf8"));
    const book = want.scenarios.reference.point;
    const seen = new Set();
    for (const r of rows) {
      const node = byName.get(r[0]);
      if (!node) continue;
      seen.add(node);
      const got = Number(r[2]);
      const expected = book[node];
      if (typeof expected === "number" && Number.isFinite(expected)) {
        cells += 1;
        if (r[2] === "" || !close(got, expected)) problems.push(`${id}: ${node} is ${r[2]} in the spreadsheet and ${expected} in the book`);
      } else if (r[2] !== "" && Number.isFinite(got) && !(r[2] === "not known yet" || r[2] === "not yet measured")) {
        problems.push(`${id}: ${node} is ${r[2]} in the spreadsheet; the book has no value for it`);
      }
    }
    for (const node of sheet.workbookNames.keys()) if (!seen.has(node)) problems.push(`${id}: ${node} has no row`);

    // Each ceiling's verdict, worked out by the spreadsheet, is the book's.
    const verdicts = want.scenarios.reference.ceilings ?? {};
    if (Object.keys(verdicts).length && written.has(`${stem}-Ceilings.csv`)) {
      for (const r of csv(readFileSync(join(dir, "out", `${stem}-Ceilings.csv`), "utf8"))) {
        const node = byName.get(r[0]);
        if (!node || !verdicts[node]) continue;
        const wanted = { ok: "ok", over: "over", "inside headroom": "inside the margin" }[verdicts[node].verdict];
        if (r[6] !== wanted) problems.push(`${id}: ceiling ${node} says ${r[6]} in the spreadsheet and ${verdicts[node].verdict} in the book`);
        if (!close(Number(r[5]), verdicts[node].allowed)) problems.push(`${id}: ceiling ${node} allows ${r[5]}; the book allows ${verdicts[node].allowed}`);
      }
    }

    // Each scenario's answers, written as a snapshot, are the book's for that scenario.
    if (written.has(`${stem}-Scenarios.csv`)) {
      const scen = csv(readFileSync(join(dir, "out", `${stem}-Scenarios.csv`), "utf8"));
      const outs = sheet.model.outputs;
      for (const r of scen) {
        const at = want.scenarios[r[0]]?.point;
        if (!at) continue;
        outs.forEach((o, i) => {
          const expected = at[o];
          if (typeof expected === "number" && Number.isFinite(expected) && !close(Number(r[4 + i]), expected)) {
            problems.push(`${id}: scenario ${r[0]} gives ${o} = ${r[4 + i]} in the spreadsheet and ${expected} in the book`);
          }
        });
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(cells > 1000, `only ${cells} cells compared`);
});
