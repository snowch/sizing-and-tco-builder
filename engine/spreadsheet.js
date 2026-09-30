/*
 * A model as a spreadsheet that still works: every given number in a shaded cell, every worked-out
 * value a live formula over them, so a price changed in the spreadsheet moves the total. It is a
 * copy for people whose process wants a spreadsheet; the model file stays the source of truth,
 * and each sheet says so.
 *
 * Each node gets a workbook-level name, so a formula reads as the model's does:
 *   ceil(busy_cores / (cores_per_host * (1 - queueing_margin)))
 *   =CEILING.MATH(busy_cores/(cores_per_host*(1-queueing_margin)))
 * A formula whose units need converting carries the factor the book's evaluator applies (GiB to
 * TB, say), so each cell is in the unit beside it. A spreadsheet has no units, so it cannot check
 * them; the model file did, before it was exported.
 *
 * Two rules differ between Python's arithmetic and a spreadsheet's, and the translation writes
 * around both: a spreadsheet's unary minus binds tighter than its power (-2^2 is 4), and its power
 * groups from the left (2^3^2 is 64). Every power and every negation is written in brackets.
 */

import { checkUnits, pointValueOfInput, real, walk } from "./evaluate.js";
import { registryFor } from "./index.js";
import { loadModel, loadScenario, measuredSd, measuredValue } from "./model.js";
import { number, xlsx } from "./xlsx.js";

export class NotExportable extends Error {}

// -- names --------------------------------------------------------------------------------------------

/* A name a spreadsheet will take: not a cell reference (abc12, r1c1, r, c), not TRUE or FALSE. */
function nameOk(name) {
  return !/^[a-z]{1,3}\d+$/i.test(name) && !/^r\d*c\d*$/i.test(name) && !/^[rc]$/i.test(name) && !/^(true|false)$/i.test(name);
}

/* Each node's name in the workbook: its own where a spreadsheet allows it, otherwise with a
 * leading underscore; names differing only in case are told apart, since a workbook's are not. */
export function workbookNames(names) {
  const out = new Map();
  const taken = new Set();
  for (const name of names) {
    let n = nameOk(name) ? name : `_${name}`;
    for (let i = 2; taken.has(n.toLowerCase()); i += 1) n = `${nameOk(name) ? name : `_${name}`}_${i}`;
    taken.add(n.toLowerCase());
    out.set(name, n);
  }
  return out;
}

// -- formulas -----------------------------------------------------------------------------------------

const FUNCTIONS = { ceil: "_xlfn.CEILING.MATH", floor: "_xlfn.FLOOR.MATH", sqrt: "SQRT", log: "LN", exp: "EXP", max: "MAX", min: "MIN" };
const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2 };

/* A parsed formula (sizing/expr.py's tree) as a spreadsheet formula over workbook names. */
export function formula(tree, names) {
  const atom = (t) => t.op === "ref" || t.op === "const" || t.op === "call";
  const inner = (t) => (atom(t) ? write(t) : `(${write(t)})`);
  function write(t) {
    switch (t.op) {
      case "const":
        return number(t.value);
      case "ref":
        return names.get(t.name);
      case "neg":
        return `-${inner(t.args[0])}`;
      case "call":
        return `${FUNCTIONS[t.fn]}(${t.args.map(write).join(",")})`;
      case "**":
        return `${inner(t.args[0])}^${inner(t.args[1])}`;
      default: {
        const p = PRECEDENCE[t.op];
        const [a, b] = t.args;
        const side = (x, right) => {
          if (x.op === "neg" || x.op === "**") return `(${write(x)})`;
          const q = PRECEDENCE[x.op];
          if (q === undefined) return write(x);
          // Same level: the left side needs no brackets; the right side of - or / does.
          if (q < p || (right && q === p && (t.op === "-" || t.op === "/"))) return `(${write(x)})`;
          return write(x);
        };
        return `${side(a, false)}${t.op}${side(b, true)}`;
      }
    }
  }
  return write(tree);
}

const scaled = (text, factor) => (factor === undefined || factor === 1 ? text : `(${text})*${number(factor)}`);

// -- values ----------------------------------------------------------------------------------------

/* Every node's value at a scenario's point, or null where it cannot be had: an input with no
 * number, a measurement not taken, and everything worked out from them. */
function values(model, factors, scenario = null) {
  const out = new Map();
  for (const name of model.order) {
    const node = model.nodes.get(name);
    try {
      let v = null;
      if (node.kind === "input") v = pointValueOfInput(node, scenario);
      else if (node.kind === "measured") v = node.measurement === null ? null : scenario?.overrides.has(name) ? scenario.overrides.get(name) : measuredValue(node);
      else v = real(walk(node.kind === "derived" ? node.formula : node.of, out)) * (factors.get(name) ?? 1);
      if (typeof v === "number" && Number.isFinite(v)) out.set(name, v);
    } catch {
      // Waits on a node with no value, or its arithmetic fails: no value, and the cell says why.
    }
  }
  return out;
}

// -- the sheets ----------------------------------------------------------------------------------------

const KIND = { input: "given", derived: "worked out", measured: "measured", ceiling: "ceiling" };
const DECIDED = { you: "you decide it", outside: "outside your control", definition: "true by definition" };
const CLAIM = { fact: "fact", vendor_claim: "vendor's claim", assumption: "assumption" };
const unitText = (u) => (u === "dimensionless" ? "" : u);

function shapeText(node) {
  const d = node.distribution;
  if (!d || !(d instanceof Map)) return "";
  const [shape] = [...d.keys()];
  const p = d.get(shape);
  const params = p instanceof Map ? [...p].map(([k, v]) => `${k} ${v?.value ?? v}`).join(", ") : "";
  return `${shape}: ${params}${node.value === null ? ". The value is its middle." : ""}`;
}

/*
 * The workbook for a model's files. files: { "model.yaml", "scenarios/*.yaml" }. ranges: the
 * builder's sampled ranges for the answers, written as a snapshot. cache: write each formula's
 * value too, so a viewer that does not recalculate still shows numbers.
 */
export function spreadsheet(files, { units, results = {}, ranges = null, cache = true, chart = null }) {
  const registry = registryFor(units);
  const model = loadModel(files["model.yaml"], { registry, results });
  const checked = checkUnits(model, registry);
  if (checked.problems.length) throw new NotExportable("The model's units do not work yet. Fix what the Checks tab lists first.");
  const { factors } = checked;
  // The sheet shows the reference scenario, where the book quotes its numbers from. It is usually
  // the model as declared; where it changes a number, the cell has the scenario's and says so.
  const scenarios = [];
  for (const path of Object.keys(files).filter((p) => p.startsWith("scenarios/") && p.endsWith(".yaml")).sort()) {
    try {
      scenarios.push(loadScenario(files[path], path));
    } catch {
      // A scenario file the book would not read is not a scenario; the Checks tab says so.
    }
  }
  const reference = scenarios.find((s) => s.name === "reference") ?? null;
  const point = values(model, factors, reference);
  const pinned = (name) => reference?.overrides.has(name) ?? false;

  const order = [
    ...model.order.filter((n) => model.nodes.get(n).kind === "input"),
    ...model.order.filter((n) => model.nodes.get(n).kind === "measured"),
    ...model.order.filter((n) => model.nodes.get(n).kind === "derived"),
    ...model.order.filter((n) => model.nodes.get(n).kind === "ceiling"),
  ];
  const names = workbookNames(order);
  const FIRST = 6; // the row of the first node on the Model sheet
  const row = new Map(order.map((n, i) => [n, FIRST + i]));
  const cached = (name) => (cache ? (point.has(name) ? point.get(name) : "not known yet") : undefined);

  // A worked-out value whose inputs are not all numbers says so, rather than counting a blank as nought.
  const guarded = (name, text, deps) => {
    if (point.has(name) || !deps.length) return text;
    return `IF(COUNT(${deps.map((d) => names.get(d)).join(",")})<${deps.length},"not known yet",${text})`;
  };

  const modelRows = [];
  for (const name of order) {
    const node = model.nodes.get(name);
    const answer = model.outputs.includes(name);
    let value;
    let from = "";
    let range = "";
    if (node.kind === "input") {
      const v = pointValueOfInput(node, reference);
      value = { v: v ?? null, s: node.provenance.kind === "vendor_claim" ? "vendor" : "given" };
      from = node.provenance.source;
      range = pinned(name)
        ? `The reference scenario sets this; the model declares ${pointValueOfInput(node, null) ?? "no number"}.`
        : node.distribution !== null ? shapeText(node) : v === null ? "Not known yet: type a number." : "";
    } else if (node.kind === "measured") {
      value = node.measurement === null ? { v: "not yet measured" } : { v: pinned(name) ? reference.overrides.get(name) : measuredValue(node) };
      if (pinned(name) && node.measurement !== null) range = `The reference scenario sets this; the measurement is ${measuredValue(node)}.`;
      const stack = node.measurement?.produced_by?.stack;
      from = node.measurement === null ? `${node.result}, not taken yet` : `${node.result}, measured on ${stack ?? "?"}, standard error ${measuredSd(node)}`;
    } else {
      const tree = node.kind === "derived" ? node.formula : node.of;
      const deps = [...node.depends].filter((d) => node.kind === "derived" || refsOf(tree).has(d)).sort();
      value = { f: guarded(name, scaled(formula(tree, names), factors.get(name)), deps), v: cached(name), s: answer ? "answer" : undefined };
      from = node.kind === "derived" ? node.formulaText : `checks ${node.ofText}; see the Ceilings sheet`;
    }
    modelRows.push([
      { v: names.get(name), s: "code" },
      node.label ?? "",
      value,
      unitText(node.unit),
      answer ? `${KIND[node.kind]}, an answer` : KIND[node.kind],
      node.kind === "input" ? DECIDED[node.decided] ?? node.decided : "",
      node.kind === "input" ? CLAIM[node.provenance.kind] ?? node.provenance.kind : "",
      { v: from, s: node.kind === "derived" ? "code" : undefined },
      range,
    ]);
  }

  const title = model.title || model.name;
  const source = `Exported by the Model Builder from ${model.name}.yaml. The model file is the source of truth: a change made here does not go back to it.`;
  const modelSheet = {
    name: "Model",
    cols: [30, 30, 16, 16, 18, 20, 14, 60, 40],
    freeze: FIRST - 1,
    rows: [
      [{ v: title, s: "title" }],
      [{ v: `Type into the shaded cells; every other value is worked out from them by a live formula. Money is in ${model.currency}. Each value is in the unit beside it, and a formula that mixes units carries the factor that converts them.`, s: "note" }],
      [{ v: source, s: "note" }],
      [],
      ["Name", "Label", "Value", "Unit", "Kind", "Who decides", "Claim", "Source, or the model's formula", "Range"].map((v) => ({ v, s: "head" })),
      ...modelRows,
    ],
  };

  const answerRows = model.outputs.map((name) => {
    const r = ranges?.outputs?.[name];
    return [
      { v: names.get(name), s: "code" },
      model.nodes.get(name).label ?? "",
      { f: names.get(name), v: cached(name), s: "answer" },
      unitText(model.nodes.get(name).unit),
      r ? r.p5 : "",
      r ? r.p50 : "",
      r ? r.p95 : "",
    ];
  });
  const answers = {
    name: "Answers",
    cols: [30, 34, 16, 16, 16, 16, 16],
    rows: [
      [{ v: title, s: "title" }],
      [{ v: "The answers, each a live formula over the Model sheet.", s: "note" }],
      [{ v: source, s: "note" }],
      ...(ranges ? [[{ v: `The last three columns are a snapshot from ${ranges.samples} draws of every range at seed ${ranges.seed}: nine draws in ten fell between the low and the high. A spreadsheet cannot redraw them; they do not move when a number here changes.`, s: "note" }]] : []),
      [],
      ["Answer", "Label", "Value", "Unit", ...(ranges ? ["Low (1 in 20 below)", "Middle", "High (1 in 20 above)"] : [])].map((v) => ({ v, s: "head" })),
      ...answerRows,
    ],
  };

  const sheets = [answers, modelSheet];

  const ceilings = order.filter((n) => model.nodes.get(n).kind === "ceiling");
  if (ceilings.length) {
    const top = 5;
    const rows = ceilings.map((name, i) => {
      const node = model.nodes.get(name);
      const r = top + 1 + i;
      const limit = scaled(formula(node.limit, names), factors.get(`${name}.limit`));
      const margin = scaled(formula(node.headroom, names), factors.get(`${name}.headroom`));
      const v = point.get(name);
      const lim = cache ? safe(() => real(walk(node.limit, point)) * (factors.get(`${name}.limit`) ?? 1)) : undefined;
      const mar = cache ? safe(() => real(walk(node.headroom, point)) * (factors.get(`${name}.headroom`) ?? 1)) : undefined;
      const allowed = typeof lim === "number" && typeof mar === "number" ? lim * (1 - mar) : undefined;
      const verdict = typeof v === "number" && typeof allowed === "number" ? (v > lim ? "over" : v > allowed ? "inside the margin" : "ok") : undefined;
      return [
        { v: names.get(name), s: "code" },
        { v: node.ofText, s: "code" },
        { f: names.get(name), v: cached(name) },
        { f: limit, v: lim },
        { f: margin, v: mar },
        { f: `D${r}*(1-E${r})`, v: allowed },
        { f: `IF(C${r}>D${r},"over",IF(C${r}>F${r},"inside the margin","ok"))`, v: verdict },
        { v: node.because, s: "wrap" },
      ];
    });
    sheets.push({
      name: "Ceilings",
      cols: [28, 36, 14, 14, 12, 14, 18, 60],
      rows: [
        [{ v: "Where the model stops working", s: "title" }],
        [{ v: "Each ceiling checks a value against a limit, keeping a margin below it. Allowed is the limit less the margin. All live.", s: "note" }],
        [{ v: source, s: "note" }],
        [],
        ["Ceiling", "Checks", "Value", "Limit", "Margin", "Allowed", "Verdict", "Because"].map((v) => ({ v, s: "head" })),
        ...rows,
      ],
    });
  }

  if (scenarios.length) {
    const outs = model.outputs;
    sheets.push({
      name: "Scenarios",
      cols: [22, 30, 50, 50, ...outs.map(() => 16)],
      rows: [
        [{ v: "Scenarios", s: "title" }],
        [{ v: "Each scenario changes some given numbers, with a reason. The answers here were worked out when the file was exported and do not move; to see one live, type its changes into the Model sheet.", s: "note" }],
        [{ v: source, s: "note" }],
        [],
        ["Scenario", "Title", "Because", "What it changes", ...outs.map((o) => `${o}${unitText(model.nodes.get(o).unit) ? ` (${unitText(model.nodes.get(o).unit)})` : ""}`)].map((v) => ({ v, s: "head" })),
        ...scenarios.map((s) => {
          const at = values(model, factors, s);
          const changes = [...s.overrides].map(([k, v]) => `${k} = ${v}${model.nodes.has(k) && unitText(model.nodes.get(k).unit) ? ` ${model.nodes.get(k).unit}` : ""}`).join("; ");
          return [s.name, s.title, { v: s.because, s: "wrap" }, { v: changes || "nothing: the model as declared", s: "wrap" }, ...outs.map((o) => (at.has(o) ? at.get(o) : "not known yet"))];
        }),
      ],
    });
  }

  // The chart the reader last drew in Explore, as its numbers: a snapshot, worked out when exported.
  if (chart?.rows?.length) {
    sheets.push({
      name: "Chart",
      cols: chart.rows[0].map((_, i) => (i ? 18 : 30)),
      rows: [
        [{ v: chart.title, s: "title" }],
        [{ v: "The numbers behind the chart last drawn in the builder's Explore view, worked out by the model when the file was exported. They do not move when a number here changes.", s: "note" }],
        [{ v: source, s: "note" }],
        [],
        chart.rows[0].map((v) => ({ v: String(v), s: "head" })),
        ...chart.rows.slice(1).map((r) => r.map((c) => (c === null || c === undefined ? "" : c))),
      ],
    });
  }

  const defined = order.map((n) => ({ name: names.get(n), ref: `'Model'!$C$${row.get(n)}` }));
  return { sheets, names: defined, model, point, workbookNames: names, rowOf: row };
}

function refsOf(tree, out = new Set()) {
  if (tree.op === "ref") out.add(tree.name);
  for (const a of tree.args ?? []) refsOf(a, out);
  return out;
}

function safe(fn) {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/* The .xlsx file's bytes. */
export function workbook(files, options) {
  const { sheets, names } = spreadsheet(files, options);
  return xlsx(sheets, names);
}
