/*
 * The Explain view: the answer as a tree of what it rests on, each line clickable for its
 * origin, evidence, calculation and what it feeds; what would flip a comparison; and, for when
 * the numbers are challenged, sensitivity, the checks (the engine's verdict on the files, and
 * the page's own fairness checks), every origin, and the files.
 */

import { $, download, esc, fmt, lower, money, n, unitWords } from "./ui.js";
import { ORIGINS, evidenceOf, originOf, provenanceFor, questionById } from "./questions.js";
import { answerLabel, answerNode, atOption, byName, coversPart, files, neededFor, optionById, ours, partOf, refsOf, valueOf } from "./evaluate.js";
import { categories, catTotal } from "./results.js";
import { calcChip, chip, inputName } from "./journey.js";

const label = (nd) => nd.label ?? nd.name.replaceAll("_", " ");
const FUNC_WORDS = { ceil: "round up", floor: "round down", max: "largest of", min: "smallest of", sqrt: "square root of", exp: "e to the", log: "log of" };

/* A formula in words, or with this option's numbers in it. */
function formula(app, nd, ev, words) {
  const { state } = app;
  const names = byName(state.doc);
  const text = nd.kind === "derived" ? nd.formula : `${nd.of}`;
  return String(text).replace(/[A-Za-z_]\w*|\d+(?:\.\d+)?|\*\*|[-+*/(),]/g, (t) => {
    if (t in FUNC_WORDS) return FUNC_WORDS[t];
    if (/^[A-Za-z_]/.test(t)) { const x = names.get(t); if (!x) return t; return words ? lower(label(x)) : fmt(valueOf(ev, t), x.unit, state.doc.currency); }
    return { "*": "×", "/": "÷", "-": "−", "**": "^" }[t] ?? t;
  }).replace(/\( /g, "(").replace(/ \)/g, ")");
}

/* The value of an input as this option has it, and its provenance. */
function inputFor(app, o, name) {
  const nd = byName(app.state.doc).get(name);
  if (nd.decided !== "you" || o.ours) return { value: nd.value, provenance: nd.provenance, key: nd.decided === "you" ? `${o.id}|${name}` : `shared|${name}`, whose: nd.decided === "outside" ? "Customer requirements" : nd.decided === "definition" ? "By definition" : o.name };
  if (Object.hasOwn(o.overrides, name)) return { value: o.overrides[name], provenance: o.provenance[name] ?? { kind: "", source: "" }, key: `${o.id}|${name}`, whose: o.name };
  if (o.same.includes(name)) return { value: nd.value, provenance: nd.provenance, key: `${ours(app.state).id}|${name}`, whose: `${o.name}, same as ${ours(app.state).name}` };
  return { value: null, provenance: { kind: "", source: "" }, key: `${o.id}|${name}`, whose: o.name };
}

function tree(app, o, ev, name, { open = false, who = false } = {}) {
  const { state } = app;
  const nd = byName(state.doc).get(name);
  if (!nd) return "";
  const cur = state.doc.currency;
  if (nd.kind === "input") {
    const i = inputFor(app, o, name);
    return `<details><summary class="leaf" data-node="${o.id}|${name}"><span class="t">${esc(label(nd))} ${nd.decided === "definition" ? '<span class="chip defn">Definition</span>' : chip(i.key, i.provenance, true)}</span><span class="tv">${esc(fmt(i.value, nd.unit, cur))}</span><span class="f">${esc(i.whose)} · ${esc(evidenceOf(i.provenance) || (nd.decided === "definition" ? nd.provenance?.source ?? "" : "not said yet"))}</span></summary></details>`;
  }
  const value = valueOf(ev, name);
  if (nd.kind === "derived" && /(^|_)total_cost$/.test(name) && !coversPart(state, o, partOf(state, name)) ) {
    return `<details><summary class="leaf"><span class="t"><span class="who">${esc(o.name)}:</span> ${esc(label(nd))}</span><span class="tv">${money(0, cur)}</span><span class="f">Not part of this option.</span></summary></details>`;
  }
  const kids = refsOf(nd.kind === "derived" ? nd.formula : nd.of).map((r) => tree(app, o, ev, r)).join("");
  const head = who ? `<span class="who">${esc(o.name)}:</span> ${esc(label(nd))}` : `${esc(label(nd))} ${calcChip}`;
  return `<details${open ? " open" : ""}><summary data-node="${o.id}|${name}"><span class="t">${head}</span><span class="tv">${esc(fmt(value, nd.unit, cur))}</span><span class="f">${esc(formula(app, nd, ev, true))} = ${esc(formula(app, nd, ev, false))}</span></summary>${kids}</details>`;
}
const tone = (d) => (Math.abs(d) < 0.5 ? "" : d > 0 ? "good" : "bad");
const edge = (d, cur) => (Math.abs(d) < 0.5 ? "even" : `${money(Math.abs(d), cur)} ${d > 0 ? "to us" : "to them"}`);

function totalTree(app, o) {
  const { state } = app;
  const ev = app.evaluate(o);
  const cur = state.doc.currency;
  if (questionById(state.type).kind !== "cost") return tree(app, o, ev, answerNode(state), { open: true });
  const cs = categories(app).filter((c) => catTotal(app, ev, o, c) !== 0 || c.lines.some((l) => coversPart(state, o, partOf(state, l))));
  const kids = cs.map((c) => `<details open><summary><span class="t">${esc(c.name)}</span><span class="tv">${money(catTotal(app, ev, o, c), cur)}</span></summary>${c.lines.filter((l) => coversPart(state, o, partOf(state, l))).map((l) => tree(app, o, ev, l)).join("")}</details>`).join("");
  return `<details open><summary data-node="${o.id}|total_cost"><span class="t">${esc(answerLabel(state))} · ${esc(o.name)}</span><span class="tv">${money(valueOf(ev, "total_cost"), cur)}</span><span class="f">${esc(cs.map((c) => c.name.toLowerCase()).join(" + "))} = ${esc(cs.map((c) => money(catTotal(app, ev, o, c), cur)).join(" + "))}</span></summary>${kids}</details>`;
}
function savingTree(app, them) {
  const { state } = app;
  const cur = state.doc.currency;
  const us = ours(state), eu = app.evaluate(us), et = app.evaluate(them);
  const s = valueOf(et, "total_cost") - valueOf(eu, "total_cost");
  const lineNode = (l) => { const d = (coversPart(state, them, partOf(state, l)) ? valueOf(et, l) : 0) - (coversPart(state, us, partOf(state, l)) ? valueOf(eu, l) : 0); const nd = byName(state.doc).get(l); return `<details><summary><span class="t">${esc(label(nd))}</span><span class="tv ${tone(d)}">${edge(d, cur)}</span><span class="f">theirs − ours = ${esc(money(valueOf(et, l), cur))} − ${esc(money(valueOf(eu, l), cur))}</span></summary>${tree(app, them, et, l, { who: true })}${tree(app, us, eu, l, { who: true })}</details>`; };
  const kids = categories(app).map((c) => ({ c, d: catTotal(app, et, them, c) - catTotal(app, eu, us, c) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).map(({ c, d }) =>
    `<details><summary><span class="t">${esc(c.name)}</span><span class="tv ${tone(d)}">${edge(d, cur)}</span><span class="f">theirs − ours = ${esc(money(catTotal(app, et, them, c), cur))} − ${esc(money(catTotal(app, eu, us, c), cur))}</span></summary>${c.lines.map(lineNode).join("")}</details>`).join("");
  return `<details open><summary><span class="t">${s >= 0 ? "Saving" : "Extra cost"} against ${esc(them.name)}</span><span class="tv ${s >= 0 ? "good" : "bad"}">${money(Math.abs(s), cur)}</span><span class="f">their total − our total = ${esc(money(valueOf(et, "total_cost"), cur))} − ${esc(money(valueOf(eu, "total_cost"), cur))}. Largest difference first.</span></summary>${kids}</details>`;
}

/* One number's story. */
function showDetail(app, oid, name) {
  const { state } = app;
  const o = optionById(state, oid), ev = app.evaluate(o), nd = byName(state.doc).get(name);
  const cur = state.doc.currency;
  const link = (x) => { const y = byName(state.doc).get(x); return y ? `<button type="button" class="link" data-detail="${oid}|${x}">${esc(label(y))}</button>` : esc(x); };
  const usedBy = state.doc.nodes.filter((x) => x.kind !== "input" && refsOf(x.kind === "derived" ? x.formula : x.of).includes(name));
  let body;
  if (nd.kind !== "input") {
    body = `<dl><dt>Value</dt><dd class="v">${esc(fmt(valueOf(ev, name), nd.unit, cur))}</dd><dt>Origin</dt><dd>${calcChip}</dd>
      <dt>Calculation</dt><dd>${esc(label(nd))} = ${esc(formula(app, nd, ev, true))}<br><span class="mono">= ${esc(formula(app, nd, ev, false))}</span></dd>
      ${nd.note ? `<dt>Note</dt><dd>${esc(nd.note)}</dd>` : ""}
      <dt>Made of</dt><dd><ul>${refsOf(nd.kind === "derived" ? nd.formula : nd.of).map((r) => `<li>${link(r)}</li>`).join("")}</ul></dd>
      <dt>Used by</dt><dd>${usedBy.length ? `<ul>${usedBy.map((x) => `<li>${link(x.name)}</li>`).join("")}</ul>` : "The answer"}</dd></dl>`;
  } else {
    const i = inputFor(app, o, name);
    const via = originOf(i.provenance);
    body = `<dl><dt>Value</dt><dd class="v">${esc(fmt(i.value, nd.unit, cur))}</dd><dt>Origin</dt><dd>${nd.decided === "definition" ? '<span class="chip defn">Definition</span>' : chip(i.key, i.provenance, true)}</dd>
      <dt>Evidence</dt><dd>${esc(evidenceOf(i.provenance) || i.provenance?.source || "Not said yet")}</dd>
      <dt>Belongs to</dt><dd>${esc(i.whose)}${nd.decided === "outside" ? " (the same for every option)" : ""}</dd>
      <dt>Used by</dt><dd>${usedBy.length ? `<ul>${usedBy.map((x) => `<li>${link(x.name)}</li>`).join("")}</ul>` : "Nothing yet"}</dd>
      ${via === "assumption" ? `<dt>Note</dt><dd>${esc(ORIGINS.assumption.note)}</dd>` : via === "customer" ? `<dt>Note</dt><dd>${esc(ORIGINS.customer.note)}</dd>` : ""}</dl>`;
  }
  $("detail").innerHTML = `<p class="eyebrow">${esc(o.name)}</p><h3 class="sub" style="margin-top:4px">${esc(label(nd))}</h3>${body}`;
  for (const b of document.querySelectorAll("#detail [data-detail]")) b.onclick = () => { const [a, x] = b.dataset.detail.split("|"); showDetail(app, a, x); };
  for (const s of document.querySelectorAll("#explain-tree summary.sel")) s.classList.remove("sel");
  document.querySelector(`#explain-tree summary[data-node="${oid}|${name}"]`)?.classList.add("sel");
}

export function drawExplain(app) {
  const { state } = app;
  const q = questionById(state.type);
  const us = ours(state);
  const choices = [{ kind: "total", id: us.id, label: `${answerLabel(state)} · ${us.name}` },
    ...state.options.filter((o) => o !== us).map((o) => (q.kind === "cost" ? { kind: "saving", id: o.id, label: `Saving against ${o.name}` } : { kind: "total", id: o.id, label: `${answerLabel(state)} · ${o.name}` }))];
  if (!state.focus || !choices.some((c) => c.kind === state.focus.kind && c.id === state.focus.id)) state.focus = choices[0];
  const sel = $("focus");
  sel.innerHTML = choices.map((c) => `<option value="${c.kind}|${c.id}" ${c.kind === state.focus.kind && c.id === state.focus.id ? "selected" : ""}>${esc(c.label)}</option>`).join("");
  sel.onchange = () => { const [kind, id] = sel.value.split("|"); state.focus = { kind, id }; app.save(); drawExplain(app); };
  const f = state.focus;
  $("explain-tree").innerHTML = f.kind === "saving" ? savingTree(app, optionById(state, f.id)) : totalTree(app, optionById(state, f.id));
  $("explain-tree").onclick = (e) => { const s = e.target.closest("summary[data-node]"); if (s && !e.target.closest("button")) { const [a, x] = s.dataset.node.split("|"); showDetail(app, a, x); } };
  $("detail").innerHTML = `<p class="note">Click a line in the explanation to see its source, origin, calculation and what depends on it.</p>`;

  const them = f.kind === "saving" ? optionById(state, f.id) : state.options.find((o) => o !== us);
  const flipSec = $("flip-section");
  flipSec.hidden = !(q.kind === "cost" && them);
  if (!flipSec.hidden) drawFlips(app, them);
  $("expert-more").open = state.expert || $("expert-more").open;
  drawSensitivity(app, q.kind === "cost" ? them : null);
  drawChecks(app);
  drawOrigins(app);
  drawFiles(app);
}

/* Where a comparison flips: for each input, the value that makes the two totals meet. */
function flipsAgainst(app, them) {
  const { state } = app;
  const us = ours(state);
  const eu = app.evaluate(us), et = app.evaluate(them);
  const names = byName(state.doc);
  const gap = (scope, name, x) => {
    const ou = scope === "shared" || scope === us.id ? { [name]: x } : {};
    const ot = scope === "shared" || scope === them.id ? { [name]: x } : {};
    const a = Object.keys(ot).length ? atOption(et, ot, ["total_cost"]).get("total_cost") : valueOf(et, "total_cost");
    const b = Object.keys(ou).length ? atOption(eu, ou, ["total_cost"]).get("total_cost") : valueOf(eu, "total_cost");
    return a - b;
  };
  const base = gap("none", "", 0);
  const cands = [];
  for (const nd of state.doc.nodes) {
    if (nd.kind !== "input" || nd.decided === "definition" || nd.name === "horizon" || /(^|_)included$/.test(nd.name)) continue;
    if (nd.decided === "outside") { if (typeof nd.value === "number" && (neededFor(state, us).has(nd.name) || neededFor(state, them).has(nd.name))) cands.push({ scope: "shared", nd, x0: nd.value, who: "The customer's" }); continue; }
    for (const o of [us, them]) {
      if (!neededFor(state, o).has(nd.name)) continue;
      const i = inputFor(app, o, nd.name);
      if (typeof i.value === "number") cands.push({ scope: o.id, nd, x0: i.value, who: `${o.name}:` });
    }
  }
  const out = [];
  for (const c of cands) {
    const hi = c.nd.unit === "dimensionless" ? (c.x0 <= 1 ? 1 : c.x0 * 10) : Math.max(c.x0 * 10, 1);
    const steps = 200;
    let best = null, px = 0, pg = gap(c.scope, c.nd.name, 0);
    for (let k = 1; k <= steps; k += 1) {
      const x = (hi * k) / steps, g = gap(c.scope, c.nd.name, x);
      if (Number.isFinite(g) && Number.isFinite(pg) && (g === 0 || Math.sign(g) !== Math.sign(pg))) {
        let a = px, b = x;
        for (let r = 0; r < 50; r += 1) { const m = (a + b) / 2; const gm = gap(c.scope, c.nd.name, m); if (Math.sign(gm) === Math.sign(pg)) a = m; else b = m; }
        const root = (a + b) / 2;
        if (best == null || Math.abs(root - c.x0) < Math.abs(best - c.x0)) best = root;
      }
      px = x; pg = g;
    }
    if (best == null) continue;
    out.push({ ...c, root: best, rel: c.x0 ? (best - c.x0) / c.x0 : Infinity });
  }
  void names;
  return { base, flips: out.sort((a, b) => Math.abs(a.rel) - Math.abs(b.rel)).slice(0, 6) };
}
function drawFlips(app, them) {
  const { state } = app;
  const us = ours(state);
  const { base, flips } = flipsAgainst(app, them);
  $("flip-title").textContent = `What would have to be true for ${base >= 0 ? them.name : us.name} to come out cheaper`;
  $("flips").innerHTML = flips.length ? flips.map((c) => {
    const up = c.root > c.x0;
    const pct = Number.isFinite(c.rel) ? `${up ? "+" : "−"}${n(Math.abs(c.rel) * 100, Math.abs(c.rel) < 0.1 ? 1 : 0)}%` : "from nothing";
    return `<li><span>${esc(c.who)} ${esc(lower(label(c.nd)))} ${up ? "rises" : "falls"} from <span class="num">${esc(fmt(c.x0, c.nd.unit, state.doc.currency))}</span> to <span class="num">${esc(fmt(c.root, c.nd.unit, state.doc.currency))}</span></span><span class="how">${pct}</span></li>`;
  }).join("") : `<li><span>No single number, moved on its own, changes which is cheaper.</span></li>`;
}

function drawSensitivity(app, them) {
  const { state } = app;
  const cur = state.doc.currency;
  const us = ours(state);
  const name = answerNode(state);
  const unit = byName(state.doc).get(name)?.unit;
  const cost = questionById(state.type).kind === "cost";
  const eu = app.evaluate(us), et = them ? app.evaluate(them) : null;
  const answer = (ou, ot) => {
    const b = Object.keys(ou).length ? atOption(eu, ou, [name]).get(name) : valueOf(eu, name);
    if (!them) return b;
    const a = Object.keys(ot).length ? atOption(et, ot, [name]).get(name) : valueOf(et, name);
    return a - b;
  };
  const base = answer({}, {});
  $("bars-title").textContent = them ? `What moves the saving against ${them.name} most` : `What moves ${lower(answerLabel(state))} most`;
  const cands = [];
  for (const nd of state.doc.nodes) {
    if (nd.kind !== "input" || nd.decided === "definition" || /(^|_)included$/.test(nd.name)) continue;
    if (nd.decided === "outside") { if (typeof nd.value === "number") cands.push({ label: `Customer: ${lower(label(nd))}`, move: (f) => answer({ [nd.name]: nd.value * f }, { [nd.name]: nd.value * f }) }); continue; }
    const iu = inputFor(app, us, nd.name);
    if (typeof iu.value === "number" && neededFor(state, us).has(nd.name)) cands.push({ label: `${us.name}: ${lower(label(nd))}`, move: (f) => answer({ [nd.name]: iu.value * f }, {}) });
    if (them) { const it = inputFor(app, them, nd.name); if (typeof it.value === "number" && neededFor(state, them).has(nd.name)) cands.push({ label: `${them.name}: ${lower(label(nd))}`, move: (f) => answer({}, { [nd.name]: it.value * f }) }); }
  }
  const bars = cands.map((c) => { const a = c.move(0.8), b = c.move(1.2); return { label: c.label, lo: Math.min(a, b), hi: Math.max(a, b) }; }).filter((b) => Number.isFinite(b.lo) && b.hi - b.lo > 1e-9).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo)).slice(0, 8);
  const min = Math.min(...bars.map((b) => b.lo), base, them ? 0 : base), max = Math.max(...bars.map((b) => b.hi), base, them ? 0 : base);
  const X = (x) => ((x - min) / (max - min || 1)) * 100;
  const crosses = them && min < 0 && max > 0;
  const f = (v) => (cost ? money(v, cur) : fmt(v, unit, cur));
  $("bars").innerHTML = bars.map((b) => `<div class="bar"><span>${esc(b.label)}</span><span class="track"><span class="fill" style="left:${X(b.lo)}%;width:${Math.max(1, X(b.hi) - X(b.lo))}%"></span>${crosses ? `<span class="zero" style="left:${X(0)}%" title="Where the saving is nothing"></span>` : ""}<span class="mid" style="left:${X(base)}%"></span></span><span class="num" style="text-align:right">±${esc(f((b.hi - b.lo) / 2))}</span></div>`).join("") +
    (crosses ? `<p class="note" style="margin:4px 0 0">The dashed line is a saving of nothing. A bar that crosses it can change the answer on its own.</p>` : "");
}

/* The checks: the engine's verdict on the files, then the page's own on fairness. */
export function drawChecks(app) {
  const { state } = app;
  const us = ours(state);
  const cost = questionById(state.type).kind === "cost";
  const items = [];
  const v = app.verdict;
  if (!v.report) items.push(["todo", "Checking the model files…"]);
  else if (!v.report.load.ok) items.push(["warn", `The model file does not load: ${v.report.load.message}`]);
  else {
    const problems = v.report.verify.problems;
    if (!problems.length) items.push(["", "The files pass every check the toolkit makes: units, provenance, shape, scenarios."]);
    // One line per kind of problem, naming every node it applies to, rather than one per node.
    const byCode = new Map();
    for (const p of problems) { if (!byCode.has(p.code)) byCode.set(p.code, []); byCode.get(p.code).push(p); }
    for (const [, list] of byCode) {
      if (list.length === 1 || !list[0].node) { for (const p of list) items.push(["warn", app.problemWords(p)]); continue; }
      const names = list.map((p) => label(byName(state.doc).get(p.node) ?? { name: p.node })).join(", ");
      items.push(["warn", `${list.length} figures: ${app.problemWords({ ...list[0], node: names, detail: "" })}`]);
    }
  }
  const shared = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside" && typeof nd.value === "number" && state.options.some((o) => neededFor(state, o).has(nd.name)));
  items.push(["", `Every option is evaluated against the same requirements: ${shared.map((nd) => `${lower(label(nd))} ${fmt(nd.value, nd.unit, state.doc.currency)}`).join(", ")}.`]);
  const others = state.options.filter((o) => o !== us);
  if (cost) for (const o of others) for (const p of state.parts) {
    const a = coversPart(state, us, p), b = coversPart(state, o, p);
    const dom = app.ctx.parts.find((x) => x.id === p)?.domain.toLowerCase() ?? p;
    if (a && !b) items.push(["warn", `${o.name} covers no ${dom}; ours does. If the customer still needs it, they would buy it elsewhere, and that cost belongs in ${o.name}. As it stands the comparison flatters them.`]);
    if (!a && b) items.push(["warn", `${us.name} covers no ${dom}; ${o.name} does. If the customer still needs it, cost it into ours. As it stands the comparison flatters us.`]);
  }
  const quoted = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "you" && originOf(nd.provenance) === "quote" && neededFor(state, us).has(nd.name)).length;
  if (quoted) items.push(["info", `${quoted} of the figures for ${us.name} come from our own quote. That is a supplier's claim, the same as a competitor's price, and is marked the same way.`]);
  const firm = (via) => via && via !== "assumption";
  const said = { customer: "the customer's own figure", quote: "from a quote", published: "a published price", fact: "a cited document" };
  for (const o of others) for (const nd of state.doc.nodes) {
    if (nd.kind !== "input" || nd.decided !== "you" || !neededFor(state, us).has(nd.name) || !neededFor(state, o).has(nd.name) || o.same.includes(nd.name)) continue;
    const a = originOf(inputFor(app, us, nd.name).provenance), b = originOf(inputFor(app, o, nd.name).provenance);
    if (firm(a) && b === "assumption" && inputFor(app, o, nd.name).value !== 0) items.push(["warn", `${o.name}: ${lower(label(nd))} is an assumption, while ours is ${said[a]}. Part of the difference rests on a guess about them.`]);
    if (a === "assumption" && firm(b) && nd.value !== 0) items.push(["warn", `Our ${lower(label(nd))} is an assumption, while the figure for ${o.name} is ${said[b]}. Firm ours up before the customer asks.`]);
  }
  if (cost) for (const o of state.options) {
    const ev = app.evaluate(o);
    const free = categories(app).flatMap((c) => c.lines).filter((l) => coversPart(state, o, partOf(state, l)) && valueOf(ev, l) === 0 && state.options.some((x) => x !== o && coversPart(state, x, partOf(state, l)) && valueOf(app.evaluate(x), l) > 0));
    if (free.length) items.push(["info", `${o.name} pays nothing for ${free.map((l) => lower(label(byName(state.doc).get(l)))).join(", ").replace(/, ([^,]*)$/, " or $1")}, where another option does. Confirm each really is nothing (included in another price, say) and was not left out.`]);
  }
  for (const [cat, text] of Object.entries(state.written)) if (text?.trim()) items.push(["info", `${cat} requirement recorded: “${text.trim()}”. The calculation does not check it; confirm every option meets it.`]);
  $("checks").innerHTML = items.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join("");
}

function drawOrigins(app) {
  const { state } = app;
  const cur = state.doc.currency;
  const shared = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside" && typeof nd.value === "number");
  $("origins-shared").innerHTML = `<thead><tr><th>Customer requirements</th><th>Origin</th><th>Evidence</th><th style="text-align:right">Value</th></tr></thead><tbody>${shared.map((nd) => `<tr><td>${esc(label(nd))}</td><td>${chip(`shared|${nd.name}`, nd.provenance, true)}</td><td class="note" style="white-space:normal">${esc(evidenceOf(nd.provenance) || "not said yet")}</td><td class="v">${esc(fmt(nd.value, nd.unit, cur))}</td></tr>`).join("")}</tbody>`;
  const you = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "you" && !/(^|_)included$/.test(nd.name) && state.options.some((o) => neededFor(state, o).has(nd.name)));
  $("origins-opts").innerHTML = you.length ? `<thead><tr><th>Each option</th>${state.options.map((o) => `<th class="${o.ours ? "ours" : ""}">${esc(o.name)}</th>`).join("")}</tr></thead><tbody>${you.map((nd) => `<tr><td>${esc(label(nd))}</td>${state.options.map((o) => { if (!neededFor(state, o).has(nd.name)) return `<td class="${o.ours ? "ours" : ""} left">not used</td>`; const i = inputFor(app, o, nd.name); return `<td class="${o.ours ? "ours" : ""}" title="${esc(evidenceOf(i.provenance))}"><span class="pair">${chip(i.key, i.provenance, true)}<span class="num">${esc(fmt(i.value, nd.unit, cur))}</span></span></td>`; }).join("")}</tr>`).join("")}</tbody>` : "";
}

function drawFiles(app) {
  const out = files(app.state);
  $("files-list").innerHTML = Object.keys(out).map((p) => `<li><a href="#" data-file="${esc(p)}">${esc(p)}</a> <button type="button" class="link" data-dl="${esc(p)}">download</button></li>`).join("");
  for (const a of document.querySelectorAll("[data-file]")) a.onclick = (e) => { e.preventDefault(); const pre = $("file-view"); pre.hidden = false; pre.textContent = out[a.dataset.file]; };
  for (const b of document.querySelectorAll("[data-dl]")) b.onclick = () => download(b.dataset.dl.replace("scenarios/", "scenario-"), out[b.dataset.dl]);
}

export { provenanceFor, unitWords };
