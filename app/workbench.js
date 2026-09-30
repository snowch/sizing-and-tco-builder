/*
 * Everything the builder shows, worked out from its state.
 *
 * Two kinds of answer come out of here, and they are kept apart:
 *
 *   - the preview: values at the point for whatever part of the model is complete, so the tree
 *     can show numbers while the reader is still defining things. An input with no number, and
 *     everything downstream of it, shows as not yet measured; a node that waits on a name still
 *     to define says how many it waits on.
 *
 *   - the verdict: once nothing is left to define, the model and its scenarios are written as
 *     files and the engine (the book's rules, held to the book by the conformance suite) reports
 *     on those files. The build checks the reader sees are that report and nothing else, apart
 *     from the few the builder asks for itself, which say so.
 */

import { describe } from "../engine/describe.js";
import { ceilingReport, checkUnits, pointValueOfInput, real, walk } from "../engine/evaluate.js";
import { tornado } from "../engine/tornado.js";
import { FormulaError, parse, refs } from "../engine/formula.js";
import { formatUnits, inferUnits, producedUnits } from "../engine/infer.js";
import { report } from "../engine/index.js";
import { blocked, isConditional, order } from "../engine/model.js";
import { sorted } from "../engine/python.js";
import { writeModel, writeScenario } from "../engine/write.js";
import { PATTERNS, PROBLEM_WORDS, CAUSE_WORDS, REFINE, money } from "./words.js";
import { plain } from "./ui.js";

// -- the graph as it stands -----------------------------------------------------------------------

/* Parse every defined node's formulas. A formula that does not parse is kept, with its error. */
export function graph(state) {
  const nodes = new Map();
  for (const n of state.doc.nodes) {
    const entry = { name: n.name, node: n, depends: new Set(), trees: {}, error: null };
    const fields = n.kind === "derived" ? ["formula"] : n.kind === "ceiling" ? ["of", "limit", "headroom"] : [];
    for (const field of fields) {
      const text = field === "headroom" ? n.headroom || "0" : n[field];
      try {
        entry.trees[field] = parse(text ?? "", `${n.name} ${field}`);
        for (const r of refs(entry.trees[field])) entry.depends.add(r);
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
        entry.error = error.message;
      }
    }
    nodes.set(n.name, entry);
  }
  for (const p of state.pending) if (!nodes.has(p.name)) nodes.set(p.name, { name: p.name, pending: p, depends: new Set(), trees: {}, error: null });
  return nodes;
}

export function parentsOf(nodes, name) {
  return sorted([...nodes.values()].filter((e) => e.depends.has(name)).map((e) => e.name));
}

/* Names still to define, breadth first from the answers, then any left over. */
export function pendingOrder(state, nodes = graph(state)) {
  const out = [];
  const seen = new Set();
  const queue = [...state.doc.outputs, ...state.doc.nodes.filter((n) => n.kind === "ceiling").map((n) => n.name)];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !nodes.has(name)) continue;
    seen.add(name);
    const entry = nodes.get(name);
    if (entry.pending) out.push(name);
    queue.push(...sorted(entry.depends));
  }
  for (const p of state.pending) if (!out.includes(p.name)) out.push(p.name);
  return out;
}

/* Everything upstream of a node. */
export function upstream(nodes, name) {
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    const entry = nodes.get(stack.pop());
    for (const d of entry?.depends ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return seen;
}

// -- the preview: values at the point for the complete part ----------------------------------------

function engineInput(n) {
  const common = { name: n.name, unit: n.unit, label: n.label ?? null, note: n.note ?? null };
  const shaped = n.sure === "shape" && n.distribution;
  const hasValue = n.sure !== "none" && typeof n.value === "number";
  if (!shaped && !hasValue) {
    // Preview only: an input with no number behaves as the book's unmeasured constant does, so
    // that it and everything downstream show as not yet measured.
    return { ...common, kind: "measured", result: "", measurement: null, depends: new Set(), missing: true };
  }
  return {
    ...common,
    kind: "input",
    value: hasValue ? n.value : null,
    distribution: shaped ? new Map([[n.distribution.shape, new Map(Object.entries(n.distribution.parameters))]]) : null,
    provenance: { ...(n.provenance ?? { kind: "", source: "" }) },
    slider: n.range ?? null,
    decided: n.decided ?? "",
    depends: new Set(),
  };
}

function engineNode(n, entry, results) {
  if (n.kind === "input") return engineInput(n);
  const common = { name: n.name, unit: n.unit, label: n.label ?? null, note: n.note ?? null, kind: n.kind, depends: entry.depends };
  if (n.kind === "derived") return { ...common, formula: entry.trees.formula, formulaText: n.formula };
  if (n.kind === "measured") return { ...common, result: n.result, measurement: results[n.result] ?? null };
  return {
    ...common,
    of: entry.trees.of,
    ofText: n.of,
    limit: entry.trees.limit,
    limitText: n.limit,
    headroom: entry.trees.headroom,
    headroomText: n.headroom ?? "",
    because: n.because ?? "",
  };
}

/*
 * Values for every node that can have one. Each node gets a state:
 *   ok, to-define, waits (on names to define), not-yet-measured, unit (its units are wrong),
 *   formula (its formula does not parse), error (the arithmetic fails), unknown-unit.
 */
export function preview(state, { registry, results }, nodes = graph(state)) {
  const out = new Map();
  const complete = new Map();
  for (const [name, entry] of nodes) {
    if (entry.pending) {
      out.set(name, { state: "to-define" });
      continue;
    }
    const waits = [...upstream(nodes, name)].filter((d) => nodes.get(d)?.pending || !nodes.has(d));
    if (waits.length) {
      out.set(name, { state: "waits", waits: waits.length });
      continue;
    }
    if (entry.error) {
      out.set(name, { state: "formula", message: entry.error });
      continue;
    }
    try {
      registry.parse(entry.node.unit);
    } catch {
      out.set(name, { state: "unknown-unit" });
      continue;
    }
    complete.set(name, engineNode(entry.node, entry, results));
  }
  // A node downstream of one with a broken formula or unit cannot be worked out either.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, node] of complete) {
      const broken = [...node.depends].find((d) => !complete.has(d));
      if (broken) {
        complete.delete(name);
        out.set(name, { state: "error", message: `waits on ${broken}, which cannot be worked out` });
        changed = true;
      }
    }
  }
  const model = { name: state.doc.model, nodes: complete, outputs: [], correlations: [] };
  let units = { problems: [], factors: new Map() };
  try {
    model.order = order(model);
    units = checkUnits(model, registry);
  } catch {
    for (const name of complete.keys()) out.set(name, { state: "error", message: "the model has a loop" });
    return { values: out, ceilings: {}, model };
  }
  const unitTrouble = new Map();
  for (const p of units.problems) if (!unitTrouble.has(p.node)) unitTrouble.set(p.node, p);
  const stuck = blocked(model);
  const values = new Map();
  for (const name of model.order) {
    const node = complete.get(name);
    if (stuck.has(name)) {
      out.set(name, { state: "not-yet-measured", because: stuck.get(name) });
      continue;
    }
    if (unitTrouble.has(name)) {
      out.set(name, { state: "unit", problem: unitTrouble.get(name) });
      continue;
    }
    try {
      let value;
      if (node.kind === "input") value = pointValueOfInput(node, null);
      else if (node.kind === "measured") value = Number(node.measurement.summary.value);
      else value = real(walk(node.kind === "derived" ? node.formula : node.of, values)) * units.factors.get(name);
      if (typeof value !== "number") throw new Error("no value");
      values.set(name, value);
      out.set(name, { state: "ok", value });
    } catch (error) {
      out.set(name, { state: "error", message: error.message });
    }
  }
  let ceilings = {};
  try {
    ceilings = ceilingReport(model, values, units.factors);
  } catch {
    ceilings = {};
  }
  return { values: out, ceilings, model, factors: units.factors, points: values };
}

// -- the files, and the book's verdict on them ------------------------------------------------------

/* A node as the writer takes it: the builder's own bookkeeping left out. */
function forFile(n) {
  if (n.kind !== "input") return n;
  const out = { ...n };
  if (n.sure !== "shape") out.distribution = null;
  if (n.sure === "none") out.value = null;
  if (n.sure === "shape" && typeof n.value !== "number") out.value = null;
  delete out.sure;
  return out;
}

export function documentForFile(state) {
  return { ...state.doc, nodes: state.doc.nodes.map(forFile), description: state.decision.trim() || state.doc.description };
}

export function files(state) {
  const out = { "model.yaml": writeModel(documentForFile(state)) };
  for (const s of state.scenarios) out[`scenarios/${s.scenario}.yaml`] = writeScenario(s);
  return out;
}

/* The book's verdict on the files, once there is a file to judge. */
export function verdict(state, context) {
  if (state.pending.length || !state.doc.nodes.length) return null;
  const written = files(state);
  try {
    return { files: written, report: report(written, context) };
  } catch (error) {
    return { files: written, report: { load: { ok: false, code: "builder", message: error.message } } };
  }
}

/* One line per build check, in words, from the engine's report. */
export function checks(state, judged) {
  const out = [];
  if (state.upgradedFrom) {
    out.push({ level: "warn", text: `This model was written for dsl ${state.upgradedFrom}. The builder now writes dsl ${state.doc.dsl}, and holds the model to that version's rules.`, chapter: null });
  }
  if (state.pending.length) {
    out.push({ level: "todo", text: `Still to define: ${state.pending.map((p) => p.name).join(", ")}`, chapter: "point_estimates", why: "The file cannot be checked until every name in it is defined." });
    return out;
  }
  if (!judged) return out;
  const r = judged.report;
  if (!r.load.ok) {
    out.push({ level: "fail", text: `The model file cannot be read: ${plain(r.load.message)}`, chapter: null });
    return out;
  }
  for (const p of r.verify.problems) {
    const [template, chapter] = PROBLEM_WORDS[p.code] ?? [p.code, null];
    const part = p.part ? `'s ${p.part === "limit" ? "limit" : "margin"}` : "";
    let text = template.replace("{node}", p.node ?? "something").replace("{part}", part).replace("{scenario}", p.scenario ?? "");
    if (p.cause) text += `: ${CAUSE_WORDS[p.cause] ?? p.cause}`;
    out.push({ level: "fail", text, chapter, code: p.code, node: p.node, detail: p.detail });
  }
  if (r.verify.crashed) out.push({ level: "fail", text: "The checks cannot read this file through to the end", detail: plain(r.verify.crashed.message) });
  if (!out.some((c) => c.level === "fail")) out.unshift({ level: "pass", text: "Every check passes." });
  return out;
}

// -- units while a formula is typed -----------------------------------------------------------------

/* Units of every defined node, and every pending name that has one. */
export function knownUnits(state, registry) {
  const known = new Map();
  for (const n of state.doc.nodes) {
    try {
      known.set(n.name, { units: registry.parse(n.unit), text: n.unit });
    } catch {
      // An unknown unit is reported where it is declared.
    }
  }
  return known;
}

/*
 * A formula for a node, read as it is typed: what it produces, whether that is the node's unit,
 * which names it introduces, and the unit the formula fixes for each of them.
 */
export function readFormula(state, { registry, previewed }, text, target, self) {
  let tree;
  try {
    tree = parse(text, "formula");
  } catch (error) {
    return { error: error.message };
  }
  const known = knownUnits(state, registry);
  known.delete(self);
  const names = [...refs(tree)];
  if (names.includes(self)) return { error: `${self} cannot be worked out from itself.` };
  const pendingUnits = new Map();
  for (const p of state.pending) {
    if (p.name !== self && p.unit) {
      try {
        pendingUnits.set(p.name, { units: registry.parse(p.unit), text: p.unit });
      } catch {
        // A pending name with a unit the registry refuses gets it asked again.
      }
    }
  }
  const fresh = new Set(names.filter((n) => !known.has(n) && !pendingUnits.has(n)));
  let targetUnits = null;
  try {
    targetUnits = target ? registry.parse(target) : null;
  } catch {
    targetUnits = null;
  }
  const inferred = inferUnits(tree, { known: new Map([...known, ...pendingUnits]), fresh, target: targetUnits, targetText: target, registry });
  const all = new Map([...known, ...pendingUnits]);
  for (const [k, v] of inferred) all.set(k, v);
  const newNames = names.filter((n) => !known.has(n));
  const complete = names.every((n) => all.has(n));
  let produced = null;
  let matches = null;
  if (complete) {
    const magnitudes = new Map();
    for (const [k, v] of previewed?.values ?? []) if (v.state === "ok") magnitudes.set(k, v.value);
    const result = producedUnits(tree, { registry, units: new Map([...all].map(([k, v]) => [k, v.units])), magnitudes });
    if (result.error) return { tree, error: result.error, newNames, inferred };
    produced = result.units;
    if (targetUnits) {
      const a = registry.describe(produced).dimensionality;
      const b = registry.describe(targetUnits).dimensionality;
      matches = sameDimensions(a, b);
    }
  }
  return { tree, produced, producedText: produced ? formatUnits(produced, registry) : null, matches, newNames, inferred, complete };
}

export function sameDimensions(a, b) {
  const x = Object.entries(a).filter(([, v]) => v !== 0).sort();
  const y = Object.entries(b).filter(([, v]) => v !== 0).sort();
  return JSON.stringify(x) === JSON.stringify(y);
}

/* The book's patterns that give a node's unit. */
export function patternsFor(state, { registry }, name, unit) {
  if (!unit) return [];
  let target;
  try {
    target = registry.parse(unit);
  } catch {
    return [];
  }
  const base = name.replace(/_(?:at_horizon|to_buy|needed)$/, "");
  const out = [];
  const mine = [];
  for (const pattern of PATTERNS) {
    if (pattern.hosts && pattern.hosts !== state.hosts) continue;
    if (pattern.routing && pattern.routing !== state.routing) continue;
    const formula = pattern.formula.replaceAll("{name}", base);
    if (formula.split(/[^\p{L}\p{N}_]+/u).includes(name)) continue;
    const units = new Map();
    let usable = true;
    for (const [k, v] of Object.entries(pattern.units)) {
      const key = k.replaceAll("{name}", base);
      const existing = state.doc.nodes.find((n) => n.name === key);
      try {
        units.set(key, registry.parse(existing ? existing.unit : money(v, state.doc.currency).replaceAll("{unit}", unit)));
      } catch {
        usable = false;
      }
    }
    if (!usable) continue;
    const produced = producedUnits(parse(formula), { registry, units });
    if (produced.error) continue;
    if (!sameDimensions(registry.describe(produced.units).dimensionality, registry.describe(target).dimensionality)) continue;
    (pattern.hosts ? mine : out).push({ ...pattern, formula });
  }
  // The patterns for the structure the reader chose come first.
  return [...mine, ...out];
}

// -- the next step --------------------------------------------------------------------------------

export function horizonNode(state) {
  if (!state.horizon || state.horizon === "none") return null;
  return state.doc.nodes.find((n) => n.name === state.horizon) ?? state.pending.find((p) => p.name === state.horizon) ?? null;
}

export function isComplete(state) {
  return Boolean(state.answer) && !state.pending.length && state.horizon !== null;
}

/*
 * The one thing to do next, with its reason and chapter: the flow's questions first, then each
 * name to define, then a failing build check, then the refinements in the order that pays.
 */
export function nextStep(state, { checks: list, answerUnitIsHosts }) {
  if (!state.answer) return { id: "answer", chapter: "point_estimates" };
  if (!state.decision.trim()) return { id: "decision", chapter: "point_estimates" };
  if (state.horizon === null) return { id: "horizon", chapter: "what_a_workload_is" };
  if (answerUnitIsHosts && state.hosts === null && state.pending.some((p) => p.name === state.answer)) {
    return { id: "hosts", chapter: "bandwidth_and_the_binding_constraint" };
  }
  const todo = pendingOrder(state)[0];
  if (todo) return { id: "define", name: todo, chapter: "what_a_workload_is" };
  const failing = list.find((c) => c.level === "fail");
  if (failing) return { id: "fix", check: failing, chapter: failing.chapter };
  const refine = REFINE.find((r) => !refinementDone(state, r.id) && !state.skipped.includes(r.id));
  if (refine) return { id: "refine", refine, chapter: refine.chapters[0] };
  return { id: "done" };
}

export function outsideInputs(state) {
  return state.doc.nodes.filter((n) => n.kind === "input" && n.decided === "outside");
}

export function refinementDone(state, id) {
  switch (id) {
    case "sources":
    case "measure":
      return state.seen.includes(id);
    case "ceiling":
      return state.doc.nodes.some((n) => n.kind === "ceiling");
    case "ranges":
      return outsideInputs(state).length > 0 && outsideInputs(state).every((n) => n.sure === "shape" || n.keepOne);
    case "scenario":
      return state.scenarios.length > 1;
    default:
      return false;
  }
}

// -- measure first ----------------------------------------------------------------------------------

/* The book's tornado (engine/tornado.js, held to sizing/evaluate.py's), for one answer. */
export function measureFirst(previewed, output) {
  const { model, factors, points } = previewed;
  if (!model?.order || !points?.has(output)) return null;
  try {
    return { base: points.get(output), bars: tornado(model, { overrides: new Map() }, output, factors) };
  } catch {
    return { base: points.get(output), bars: [] };
  }
}

// -- small readings --------------------------------------------------------------------------------

export function unitWords(registry, text) {
  try {
    const units = registry.parse(text);
    const info = registry.describe(units);
    if (!info.multiplicative) return { ok: false, words: "a unit that does not convert by a factor. The builder does not offer it." };
    return { ok: true, ...describe(info.dimensionality, units) };
  } catch {
    return { ok: false, words: "not a unit the builder knows." };
  }
}

export function classification(previewed) {
  return previewed.model && isConditional(previewed.model) ? "conditional" : "definitional";
}

/*
 * Units for names still to define, worked out again from every formula each time the model
 * changes. A name the formula could not pin when it was typed (two unknowns in one product) is
 * pinned as soon as the other is defined, which is the design's rule for the last unknown in a
 * product. Only a unit is ever filled in, never a number.
 */
export function reinfer(state, registry) {
  const open = state.pending.filter((p) => !p.unit);
  if (!open.length) return false;
  let changed = false;
  for (let pass = 0; pass < 4; pass += 1) {
    let found = false;
    for (const n of state.doc.nodes) {
      const texts = n.kind === "derived" ? [[n.formula, n.unit]] : n.kind === "ceiling" ? [[n.limit, n.unit], [n.headroom, "dimensionless"]] : [];
      for (const [text, target] of texts) {
        if (!text) continue;
        const r = readFormula(state, { registry }, text, target, n.name);
        for (const [name, unit] of r.inferred ?? []) {
          const p = state.pending.find((x) => x.name === name);
          if (p && !p.unit) {
            p.unit = unit.text;
            found = true;
          }
        }
      }
    }
    if (!found) break;
    changed = true;
  }
  return changed;
}
