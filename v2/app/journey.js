/*
 * The start screen and the Build view: the question, the customer's notes, the candidates the
 * engineer confirms, the requirements, the options, each option's numbers, what is missing, and
 * the answer as far as it can be worked out. Six steps, one open at a time unless the expert
 * view opens them all.
 *
 * Every value on this screen is typed or confirmed by the engineer. The page never fills one in.
 */

import { findCandidates, findWritten } from "../../engine/candidates.js";
import { $, esc, fmt, lower, n, unitWords } from "./ui.js";
import { ORIGINS, QUESTIONS, ROLE_NAMES, WRITTEN_PATTERNS, SAMPLE_NOTES, evidenceOf, originOf, provenanceFor, questionById } from "./questions.js";
import { merge } from "./parts.js";
import { newOption, optionsFor } from "./state.js";
import { answerLabel, answerNode, blocker, byName, coversPart, docFor, evaluateOption, isBlank, missing, neededFor, optionById, ours, partOf, valueOf } from "./evaluate.js";
import { drawInterview } from "./interview.js";

// -- the model as the chosen parts make it -----------------------------------------------------------

/* Rebuild the document from the chosen parts, carrying every value and origin across by (part, local name). */
export function rebuildDoc(app) {
  const { state, ctx } = app;
  const chosen = ctx.parts.filter((p) => state.parts.includes(p.id));
  const oldDoc = state.doc, oldMap = state.map ?? {};
  if (!chosen.length) {
    state.doc = { dsl: 2, model: "solution", title: state.sentence || "An answer", currency: ctx.currency, description: "", nodes: [
      { name: "horizon", kind: "input", decided: "outside", unit: "year", label: "evaluation period", note: null, value: null, distribution: null, provenance: { kind: "", source: "" }, range: null },
      { name: "total_cost", kind: "derived", unit: ctx.currency, label: "cost over the period", note: null, formula: "0 * horizon" },
    ], outputs: ["total_cost"], correlations: [] };
    state.map = { horizon: { part: "all", local: "horizon" }, total_cost: { part: "all", local: "total_cost" } };
  } else {
    const merged = merge(chosen, ctx.index, { model: "solution", title: state.sentence || "" });
    state.doc = merged.doc;
    state.map = Object.fromEntries(merged.map);
  }
  for (const n of state.doc.nodes) if (n.kind === "input" && !n.provenance) n.provenance = { kind: "", source: "" };
  if (!oldDoc) return;
  // Carry values across by (part, local name), so a part ticked later keeps what was entered.
  const keyOf = (map, name) => { const m = map[name]; return m ? `${m.part}|${m.local}` : `?|${name}`; };
  const old = new Map(oldDoc.nodes.map((nd) => [keyOf(oldMap, nd.name), nd]));
  const renamed = new Map();
  for (const nd of state.doc.nodes) {
    const was = old.get(keyOf(state.map, nd.name));
    if (!was) continue;
    renamed.set(was.name, nd.name);
    if (nd.kind === "input" && was.kind === "input" && was.decided !== "definition") {
      nd.value = was.value; nd.distribution = was.distribution; nd.provenance = was.provenance; nd.range = was.range;
    }
    if (nd.kind === "derived" && was.added) { nd.added = true; }
  }
  // Cost lines the engineer added live outside any part: keep them.
  const extras = oldDoc.nodes.filter((nd) => nd.added);
  for (const x of extras) {
    if (!state.doc.nodes.some((nd) => nd.name === x.name)) { state.doc.nodes.push(structuredClone(x)); state.map[x.name] = { part: "other", local: x.name }; }
  }
  if (extras.length) fixTotal(state);
  for (const o of state.options) {
    const overrides = {}, provenance = {};
    for (const [name, v] of Object.entries(o.overrides)) { const to = renamed.get(name) ?? (state.doc.nodes.some((nd) => nd.name === name) ? name : null); if (to) { overrides[to] = v; provenance[to] = o.provenance[name]; } }
    o.overrides = overrides; o.provenance = provenance;
    o.same = o.same.map((name) => renamed.get(name) ?? name).filter((name) => state.doc.nodes.some((nd) => nd.name === name));
  }
}
/* The grand total adds the parts' totals and every cost line the engineer added. */
function fixTotal(state) {
  const total = state.doc.nodes.find((nd) => nd.name === "total_cost");
  const extras = state.doc.nodes.filter((nd) => nd.added && nd.kind === "derived").map((nd) => nd.name);
  const partTotals = state.parts.length === 1 ? [] : state.parts.map((p) => `${p}_total_cost`);
  if (state.parts.length === 1) {
    // A single part's total already sums its lines; the extras join that sum.
    const base = total.formula.replace(/\s*\+\s*x\d+_cost/g, "");
    total.formula = extras.length ? `${base} + ${extras.join(" + ")}` : base;
  } else {
    total.formula = [...partTotals, ...extras].join(" + ") || "0 * horizon";
  }
  if (!state.parts.length) total.formula = extras.length ? extras.join(" + ") : "0 * horizon";
}

export function addCostLine(app, name, when) {
  const { state } = app;
  const id = `x${state.nextLine++}`;
  const once = when === "once";
  state.doc.nodes.push({ name: id, kind: "input", decided: "you", unit: once ? state.doc.currency : `${state.doc.currency}/year`, label: once ? `${name}, once` : `${name} a year`, note: null, value: null, distribution: null, provenance: { kind: "", source: "" }, range: null, added: true });
  state.doc.nodes.push({ name: `${id}_cost`, kind: "derived", unit: state.doc.currency, label: name, note: null, formula: once ? id : `${id} * horizon`, added: true });
  state.map[id] = { part: "other", local: id };
  state.map[`${id}_cost`] = { part: "other", local: `${id}_cost` };
  fixTotal(state);
}

// -- the inputs the finder and the interpreter can fill --------------------------------------------

export function finderInputs(app) {
  const { state, ctx } = app;
  const current = state.options.find((o) => o.role === "current");
  const out = [];
  for (const nd of state.doc.nodes) {
    if (nd.kind !== "input" || nd.decided === "definition" || /(^|_)included$/.test(nd.name)) continue;
    const m = state.map[nd.name] ?? { part: "all", local: nd.name };
    const part = ctx.parts.find((p) => p.id === m.part);
    const keys = part?.keys?.[m.local] ?? (m.local === "horizon" ? "year view|-year|over \\d+ years|for \\d+ years|period" : null);
    if (!keys) continue;
    const context = part?.context ? new RegExp(part.context, "i") : null;
    if (nd.decided === "outside") out.push({ key: `shared|${nd.name}`, name: inputName(app, nd), unit: nd.unit, keys, scope: "shared", context });
    else if (current) out.push({ key: `${current.id}|${nd.name}`, name: `${current.name}: ${lower(inputName(app, nd))}`, unit: nd.unit, keys, scope: current.id, context });
  }
  return out;
}
export function inputName(app, nd) {
  const m = app.state.map[nd.name];
  const label = nd.label ?? nd.name.replaceAll("_", " ");
  return label;
}
export const targetLabel = (app, key) => {
  const [where, name] = key.split("|");
  if (where === "note") return `${name} (a written requirement)`;
  const nd = byName(app.state.doc).get(name);
  if (!nd) return key;
  return where === "shared" ? inputName(app, nd) : `${optionById(app.state, where)?.name ?? where}: ${lower(inputName(app, nd))}`;
};

export function runFinder(app) {
  const { state } = app;
  const inputs = finderInputs(app);
  const current = state.options.find((o) => o.role === "current");
  const found = findCandidates(state.notes, inputs, { current: current?.id ?? "current" });
  const written = findWritten(state.notes, WRITTEN_PATTERNS).map((w, k) => ({ id: `w${k}`, kind: "note", category: w.category, sentence: w.sentence, confidence: "confident", target: `note|${w.category}`, alternatives: [], status: "pending", text: "" }));
  const keep = state.candidates.filter((c) => c.status === "confirmed");
  const fresh = [...found, ...written].filter((c) => !keep.some((x) => x.sentence === c.sentence && x.at === c.at && x.kind === c.kind));
  state.candidates = [...keep, ...fresh];
}

export function confirmCandidate(app, c) {
  const { state } = app;
  if (!c.target) return false;
  const [where, name] = c.target.split("|");
  const evidence = c.by === "ai" ? `“${c.sentence}” (suggested by the on-device interpreter)` : `“${c.sentence}”`;
  if (where === "note") {
    state.written[name] = state.written[name] ? `${state.written[name]} ${c.sentence}` : c.sentence;
  } else if (where === "shared") {
    const nd = byName(state.doc).get(name);
    if (!nd || !Number.isFinite(c.value)) return false;
    nd.value = c.value; nd.distribution = null;
    nd.provenance = provenanceFor("customer", evidence);
  } else {
    const o = optionById(state, where);
    if (!o || !Number.isFinite(c.value)) return false;
    if (o.ours) { const nd = byName(state.doc).get(name); nd.value = c.value; nd.distribution = null; nd.provenance = provenanceFor("customer", evidence); }
    else { o.overrides[name] = c.value; o.provenance[name] = provenanceFor("customer", evidence); o.same = o.same.filter((x) => x !== name); }
  }
  c.status = "confirmed";
  return true;
}
export function unconfirmCandidate(app, c) {
  const { state } = app;
  if (c.status === "confirmed" && c.target) {
    const [where, name] = c.target.split("|");
    if (where === "shared") { const nd = byName(state.doc).get(name); if (nd && nd.value === c.value) { nd.value = null; nd.provenance = { kind: "", source: "" }; } }
    else if (where !== "note") { const o = optionById(state, where); if (o && !o.ours && o.overrides[name] === c.value) { delete o.overrides[name]; delete o.provenance[name]; } else if (o?.ours) { const nd = byName(state.doc).get(name); if (nd && nd.value === c.value) { nd.value = null; nd.provenance = { kind: "", source: "" }; } } }
  }
  c.status = "pending";
}

// -- the start screen ---------------------------------------------------------------------------------

export function drawStart(app) {
  const { state } = app;
  $("types").innerHTML = QUESTIONS.map((q) => `<button type="button" aria-pressed="${state.type === q.id}" data-type="${q.id}">${q.label}</button>`).join("");
  $("typenote").textContent = questionById(state.type).note;
  if (!state.sentenceEdited) { state.sentence = questionById(state.type).sentence; $("sentence").value = state.sentence; }
  $("notes").value = state.notes;
  for (const b of document.querySelectorAll("[data-type]")) b.onclick = () => { state.type = b.dataset.type; app.save(); drawStart(app); };
}

/* Begin: the model from the question's needs, the options the question starts with. */
export function begin(app, { find }) {
  const { state, ctx } = app;
  const q = questionById(state.type);
  state.options = optionsFor(state.type);
  state.parts = q.kind === "sizing" ? ["infra"] : q.id === "custom" ? [] : ctx.parts.map((p) => p.id).filter((p) => p === "infra");
  state.doc = null;
  rebuildDoc(app);
  state.candidates = [];
  state.written = {};
  state.whatIfs = [];
  if (find) {
    runFinder(app);
    // A confirmed customer figure in a part not yet chosen would be lost, so every part the notes mention is offered.
    state.open = ["customer"];
  } else state.open = ["requirements"];
}

// -- the build view ----------------------------------------------------------------------------------

const STEPS = [
  { id: "customer", title: "Customer", q: "What do we know?" },
  { id: "requirements", title: "Requirements", q: "What does the customer need?" },
  { id: "options", title: "Options", q: "What are we comparing?" },
  { id: "inputs", title: "Inputs", q: "What numbers do we have?" },
  { id: "missing", title: "Missing information", q: "What do we still need?" },
  { id: "answer", title: "Answer", q: "What does the model calculate?" },
];

function stepSummary(app, id) {
  const { state } = app;
  if (id === "customer") {
    const c = state.candidates;
    if (!c.length) return state.notes ? "No candidates yet" : "No notes: values entered by hand";
    const done = c.filter((x) => x.status === "confirmed").length, left = c.filter((x) => x.status === "pending").length;
    return `${done} confirmed${left ? ` · ${left} to check` : ""}`;
  }
  if (id === "requirements") {
    const sh = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside");
    return `${sh.filter((nd) => !isBlank(nd)).length} of ${sh.length} known · ${state.parts.map((p) => app.ctx.parts.find((x) => x.id === p)?.domain.toLowerCase()).join(", ") || "no area yet"}`;
  }
  if (id === "options") return state.options.map((o) => o.name).join(" · ") || "none";
  if (id === "inputs") { const r = missing(state).req.filter((x) => x.scope !== "shared").length; return r ? `${r} needed option ${r === 1 ? "number" : "numbers"} missing` : "Every needed number is in"; }
  if (id === "missing") { const m = missing(state); return `${m.req.length} required · ${m.opt.length} optional`; }
  if (id === "answer") { const b = blocker(state); return b || `${answerLabel(state)} for ${ours(state).name}: ${fmt(valueOf(app.evaluate(ours(state)), answerNode(state)), byName(state.doc).get(answerNode(state))?.unit, state.doc.currency)}`; }
  return "";
}
const stepDone = (app, id) => {
  const { state } = app;
  const m = missing(state);
  return id === "customer" ? state.candidates.every((c) => c.status !== "pending") : id === "requirements" ? !m.req.some((x) => x.scope === "shared") : id === "options" ? state.options.length > 0 : id === "inputs" ? !m.req.some((x) => x.scope !== "shared") : id === "missing" ? !m.req.length : !blocker(state);
};

export function drawBuild(app) {
  const { state } = app;
  if (state.expert) state.open = STEPS.map((s) => s.id);
  $("steps").innerHTML = STEPS.map((s, k) => {
    const open = state.open.includes(s.id);
    const done = stepDone(app, s.id) && !open;
    return `<section class="step ${open ? "open" : ""} ${done ? "done" : ""}" data-step="${s.id}">
      <button type="button" class="head" data-toggle="${s.id}" aria-expanded="${open}"><span class="num">${done ? "✓" : k + 1}</span><span class="title">${s.title}<span>${s.q}</span></span><span class="sum" data-sum="${s.id}">${esc(stepSummary(app, s.id))}</span></button>
      ${open ? `<div class="body" id="body-${s.id}"></div>` : ""}
    </section>`;
  }).join("");
  for (const b of document.querySelectorAll("[data-toggle]")) b.onclick = () => { const id = b.dataset.toggle; state.open = state.open.includes(id) ? state.open.filter((x) => x !== id) : [...state.open, id]; app.save(); drawBuild(app); };
  const draw = { customer: drawCustomer, requirements: drawRequirements, options: drawOptions, inputs: drawInputs, missing: drawMissing, answer: drawAnswerStep };
  for (const s of STEPS) if (state.open.includes(s.id)) draw[s.id](app, $(`body-${s.id}`));
  refresh(app);
}
const nextButton = (id) => { const k = STEPS.findIndex((s) => s.id === id); const next = STEPS[k + 1]; return next ? `<div class="next"><button type="button" class="primary" data-next="${next.id}" data-from="${id}">Continue: ${next.title.toLowerCase()} →</button></div>` : ""; };
function wireNext(app, el) {
  for (const b of el.querySelectorAll("[data-next]")) b.onclick = () => {
    const { state } = app;
    if (!state.expert) state.open = state.open.filter((x) => x !== b.dataset.from);
    if (!state.open.includes(b.dataset.next)) state.open.push(b.dataset.next);
    app.save(); drawBuild(app);
    document.querySelector(`[data-step="${b.dataset.next}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
}

/* Step 1: the notes and the candidates found in them. */
function drawCustomer(app, el) {
  const { state } = app;
  const cands = state.candidates;
  const mark = (c) => (c.kind === "note" || !c.length ? esc(c.sentence) : `${esc(c.sentence.slice(0, c.at))}<mark>${esc(c.sentence.slice(c.at, c.at + c.length))}</mark>${esc(c.sentence.slice(c.at + c.length))}`);
  const allKeys = finderInputs(app).map((i) => i.key);
  const options = (c) => {
    if (c.kind === "note") return `<select disabled aria-label="Requirement"><option>${esc(targetLabel(app, c.target))}</option></select>`;
    const alts = c.alternatives.filter((a) => allKeys.includes(a));
    const rest = allKeys.filter((x) => !alts.includes(x));
    return `<select data-map="${c.id}" aria-label="Which input this number is" ${c.status !== "pending" ? "disabled" : ""}><option value="">${c.confidence === "none" ? "No input matched: choose one" : "Choose which input…"}</option>
      ${alts.length ? `<optgroup label="Best matches">${alts.map((a) => `<option value="${a}" ${c.target === a ? "selected" : ""}>${esc(targetLabel(app, a))}</option>`).join("")}</optgroup>` : ""}
      <optgroup label="Every input">${rest.map((a) => `<option value="${a}" ${c.target === a ? "selected" : ""}>${esc(targetLabel(app, a))}</option>`).join("")}</optgroup></select>`;
  };
  const unit = (c) => (c.kind === "note" || !c.target ? "" : esc(unitWords(byName(state.doc).get(c.target.split("|")[1])?.unit ?? "")));
  const conf = (c) => (c.confidence === "confident" ? `<span class="conf confident">Confident${c.by === "ai" ? " (interpreter)" : ""}</span>` : c.confidence === "ambiguous" ? `<span class="conf ambiguous">Ambiguous<small>${c.by === "ai" ? "the interpreter was not sure" : `${c.alternatives.length} inputs fit equally`}: choose one</small></span>` : `<span class="conf none">No match<small>Choose an input, or reject it</small></span>`);
  const status = (c) => (c.status === "confirmed" ? `<span class="status"><span class="done">✓ Confirmed</span><button type="button" data-undo="${c.id}">Undo</button></span>`
    : c.status === "rejected" ? `<span class="status"><span class="no">Rejected</span><button type="button" data-undo="${c.id}">Undo</button></span>`
    : `<span class="status"><button type="button" class="ok" data-confirm="${c.id}" ${c.target ? "" : "disabled"}>Confirm</button><button type="button" data-reject="${c.id}">Reject</button></span>`);
  const confident = cands.filter((c) => c.status === "pending" && c.confidence === "confident").length;
  el.innerHTML = `
    <p class="hint">Paste customer notes, requirements, quotes, emails or other information.</p>
    <textarea class="notes" id="notes2" aria-label="Customer notes">${esc(state.notes)}</textarea>
    <div class="actions">
      <button type="button" class="ghost" id="refind">Find candidate inputs</button>
      <button type="button" class="ai" id="use-ai">Interpret the notes on this device <span class="badge">Optional</span></button>
    </div>
    <div class="notice" id="ai-notice" hidden></div>
    ${cands.length ? `
    <div class="row" style="justify-content:space-between;margin-top:14px">
      <strong>${cands.length} candidate ${cands.length === 1 ? "input" : "inputs"} found</strong>
      ${confident ? `<button type="button" class="ghost" id="confirm-all">Confirm all ${confident} confident</button>` : ""}
    </div>
    <p class="note" style="margin:4px 0 0">A candidate becomes an input only when you confirm it. Check the ambiguous ones and choose what they are. A percentage becomes a share: 30% is 0.3.</p>
    <div class="cands"><div class="cand head" aria-hidden="true"><span>Candidate input</span><span>Value</span><span>Match</span><span>Status</span></div>
      ${cands.map((c) => `<div class="cand ${c.status}">${options(c)}
        <span class="valcell">${c.kind === "note" ? "text" : `<input type="number" step="any" value="${c.value}" data-cval="${c.id}" aria-label="Value" ${c.status !== "pending" ? "disabled" : ""}><span class="unit">${unit(c)}</span>`}</span>
        ${conf(c)}${status(c)}<div class="quote">Found in: “${mark(c)}”</div></div>`).join("")}
    </div>` : `<p class="callout">No candidates yet. Paste notes and choose “Find candidate inputs”, or go straight on and enter the requirements yourself.</p>`}
    ${nextButton("customer")}`;
  const find = (id) => state.candidates.find((c) => c.id === id);
  el.querySelector("#notes2").oninput = (e) => { state.notes = e.target.value; app.save(); };
  el.querySelector("#refind").onclick = () => { runFinder(app); app.save(); drawBuild(app); };
  el.querySelector("#use-ai").onclick = () => app.interpretNotes(el.querySelector("#ai-notice"));
  el.querySelector("#confirm-all")?.addEventListener("click", () => { for (const c of state.candidates) if (c.status === "pending" && c.confidence === "confident") confirmCandidate(app, c); app.save(); drawBuild(app); });
  for (const s of el.querySelectorAll("[data-map]")) s.onchange = () => { const c = find(s.dataset.map); c.target = s.value; app.save(); drawBuild(app); };
  for (const v of el.querySelectorAll("[data-cval]")) v.oninput = () => { find(v.dataset.cval).value = v.value.trim() === "" ? NaN : Number(v.value); app.save(); };
  for (const b of el.querySelectorAll("[data-confirm]")) b.onclick = () => { confirmCandidate(app, find(b.dataset.confirm)); app.save(); drawBuild(app); };
  for (const b of el.querySelectorAll("[data-reject]")) b.onclick = () => { find(b.dataset.reject).status = "rejected"; app.save(); drawBuild(app); };
  for (const b of el.querySelectorAll("[data-undo]")) b.onclick = () => { unconfirmCandidate(app, find(b.dataset.undo)); app.save(); drawBuild(app); };
  wireNext(app, el);
}

const badge = (role) => `<span class="badge ${role}">${{ needed: "Needed", optional: "Optional", recorded: "Recorded only" }[role]}</span>`;
const numInput = (v, attrs, label) => `<input type="number" step="any" ${attrs} value="${Number.isFinite(v) ? v : ""}" placeholder="not known yet" aria-label="${esc(label)}">`;
/* An origin as a button: click it to see the evidence and change it. */
export const chip = (key, provenance, ro = false) => {
  const via = originOf(provenance);
  const cls = { customer: "customer", quote: "quote", published: "published", assumption: "assume", fact: "defn" }[via] ?? "unset";
  return `<button type="button" class="chip ${cls}" data-org="${key}" ${ro ? 'data-ro="1"' : ""} title="Where this number came from">${via ? ORIGINS[via].label : "Where from?"}</button>`;
};
export const calcChip = `<span class="chip calc">Calculated</span>`;

function sharedRole(app, nd) {
  const { state } = app;
  if (state.options.some((o) => neededFor(state, o).has(nd.name))) return "needed";
  return "optional";
}

/* Step 2: the requirements, entered once, in the customer's terms. */
function drawRequirements(app, el) {
  const { state, ctx } = app;
  const names = byName(state.doc);
  const cat = (nd) => { const m = state.map[nd.name]; return ctx.parts.find((p) => p.id === m?.part)?.requirements?.[m.local] ?? (nd.name === "horizon" ? "Time period" : "Other constraints"); };
  const shared = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside");
  const rows = (list) => list.map((nd) => {
    const role = sharedRole(app, nd);
    return `<div class="rq ${isBlank(nd) ? "blank" : ""} ${role}" data-rq="${nd.name}"><span class="nm">${esc(inputName(app, nd))}${badge(role)}</span>
      <span class="ctl">${numInput(nd.value, `data-shared="${nd.name}"`, inputName(app, nd))}<span class="unit">${esc(unitWords(nd.unit))}</span>${chip(`shared|${nd.name}`, nd.provenance)}</span></div>`;
  }).join("");
  const cards = ctx.index.requirements.map((c) => {
    const list = shared.filter((nd) => cat(nd) === c);
    const written = ctx.index.written[c];
    if (!list.length && !written) return "";
    return `<div class="req"><h4>${c}</h4>${rows(list)}${written ? `<textarea data-note="${c}" placeholder="${esc(written)}" aria-label="${c}">${esc(state.written[c] ?? "")}</textarea><span class="note">${badge("recorded")} Written down with the answer; the calculation does not use it.</span>` : ""}</div>`;
  }).join("");
  el.innerHTML = `
    <p class="callout">You don't need to know everything yet. Fill in what you know. We'll show you what is still needed.</p>
    <p class="note" style="margin:0">Which areas do the customer's requirements cover?</p>
    <div class="areas">${ctx.parts.map((p) => `<label class="${state.parts.includes(p.id) ? "on" : ""}"><input type="checkbox" data-area="${p.id}" ${state.parts.includes(p.id) ? "checked" : ""}> ${esc(p.domain)}: ${esc(p.title.toLowerCase())}</label>`).join("")}</div>
    <div class="reqs">${cards}</div>
    ${nextButton("requirements")}`;
  for (const x of el.querySelectorAll("[data-shared]")) x.oninput = () => { const nd = names.get(x.dataset.shared); setNum(nd, x); app.save(); refresh(app); };
  for (const x of el.querySelectorAll("[data-note]")) x.oninput = () => { state.written[x.dataset.note] = x.value; app.save(); };
  for (const x of el.querySelectorAll("[data-area]")) x.onchange = () => { state.parts = x.checked ? [...state.parts, x.dataset.area] : state.parts.filter((p) => p !== x.dataset.area); state.parts = ctx.parts.map((p) => p.id).filter((p) => state.parts.includes(p)); rebuildDoc(app); app.save(); drawBuild(app); };
  wireNext(app, el);
}
function setNum(nd, el) {
  const x = el.value.trim() === "" ? NaN : Number(el.value);
  nd.value = Number.isFinite(x) ? x : null;
  if (Number.isFinite(x)) nd.distribution = null;
  (el.closest(".rq") ?? el.closest("td"))?.classList.toggle("blank", !Number.isFinite(x));
}

/* Step 3: the options, each held to the same requirements. */
function drawOptions(app, el) {
  const { state, ctx } = app;
  const shared = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside" && !isBlank(nd) && sharedRole(app, nd) === "needed").slice(0, 4);
  const req = shared.map((nd) => fmt(nd.value, nd.unit, state.doc.currency)).join(" · ");
  const k = Math.max(1, state.options.length);
  const xs = state.options.map((_, j) => ((j + 0.5) / k) * 100);
  el.innerHTML = `
    <p class="note" style="margin:0">Every option is evaluated against the same customer requirements, so none can be flattered by a different workload.</p>
    <div class="flow" aria-label="Customer requirements feed every option, and every option feeds the answer">
      <div class="node">Customer requirements<small>${esc(req || "entered once")}</small></div>
      <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">${xs.map((x) => `<line x1="50" y1="0" x2="${x}" y2="26" vector-effect="non-scaling-stroke"/>`).join("")}</svg>
      <div class="row3" style="grid-template-columns:repeat(${k}, minmax(0, 1fr))">${state.options.map((o) => `<div class="node ${o.ours ? "ours" : ""}">${esc(o.name)}<small>${o.ours ? "ours" : esc(ROLE_NAMES[o.role]?.toLowerCase() ?? "")}</small></div>`).join("")}</div>
      <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">${xs.map((x) => `<line x1="${x}" y1="0" x2="50" y2="26" vector-effect="non-scaling-stroke"/>`).join("")}</svg>
      <div class="node ans">Answer<small>${esc(answerLabel(state))}</small></div>
    </div>
    <div class="optcards">${state.options.map((o) => `<div class="optcard ${o.ours ? "ours" : ""}">
      <span class="kind">${esc(ROLE_NAMES[o.role] ?? "Option")}</span>
      <input type="text" value="${esc(o.name)}" data-optname="${o.id}" aria-label="Option name">
      <span class="row"><label><input type="radio" name="ours" data-ours="${o.id}" ${o.ours ? "checked" : ""}> This is ours</label>${state.options.length > 1 ? `<button type="button" class="link" data-remove="${o.id}">Remove</button>` : ""}</span>
      ${state.parts.length > 1 ? `<span class="note">Covers:</span><span class="covers">${state.parts.map((p) => `<label><input type="checkbox" data-inc="${o.id}" data-part="${p}" ${coversPart(state, o, p) ? "checked" : ""}> ${esc(ctx.parts.find((x) => x.id === p)?.domain ?? p)}</label>`).join("")}</span>` : ""}
    </div>`).join("")}</div>
    <div class="addopts">${["current", "ours", "rival", "alt", "custom"].map((r) => `<button type="button" class="ghost" data-add="${r}">+ ${ROLE_NAMES[r].replace(/ A$/, "")}</button>`).join("")}</div>
    ${nextButton("options")}`;
  for (const x of el.querySelectorAll("[data-optname]")) x.oninput = () => { optionById(state, x.dataset.optname).name = x.value || "Unnamed option"; app.save(); refresh(app); };
  for (const x of el.querySelectorAll("[data-ours]")) x.onchange = () => { swapOurs(app, x.dataset.ours); app.save(); drawBuild(app); };
  for (const x of el.querySelectorAll("[data-inc]")) x.onchange = () => {
    const o = optionById(state, x.dataset.inc);
    const covers = new Set(o.covers ?? state.parts);
    if (x.checked) covers.add(x.dataset.part); else covers.delete(x.dataset.part);
    o.covers = state.parts.filter((p) => covers.has(p));
    app.save(); drawBuild(app);
  };
  for (const x of el.querySelectorAll("[data-remove]")) x.onclick = () => { state.options = state.options.filter((o) => o.id !== x.dataset.remove); if (!state.options.some((o) => o.ours)) swapOurs(app, state.options[0].id); app.save(); drawBuild(app); };
  for (const x of el.querySelectorAll("[data-add]")) x.onclick = () => {
    const used = new Set(state.options.map((o) => o.id));
    let id = 0; while (used.has(`o${id}`)) id += 1;
    const o = newOption(x.dataset.add, id, false);
    const same = state.options.filter((y) => y.role === o.role).length;
    if (x.dataset.add === "rival") o.name = `Competitor ${String.fromCharCode(65 + same)}`;
    else if (same) o.name = `${ROLE_NAMES[o.role]} ${same + 1}`;
    state.options.push(o);
    app.save(); drawBuild(app);
  };
  wireNext(app, el);
}
/* Make another option ours: its overrides become the model's values, and ours becomes overrides. */
function swapOurs(app, id) {
  const { state } = app;
  const was = ours(state), now = optionById(state, id);
  if (!now || was === now) return;
  const names = byName(state.doc);
  const wasOverrides = {}, wasProv = {};
  for (const nd of state.doc.nodes) {
    if (nd.kind !== "input" || nd.decided !== "you" || /(^|_)included$/.test(nd.name)) continue;
    if (!isBlank(nd)) { wasOverrides[nd.name] = nd.value; wasProv[nd.name] = nd.provenance; }
    if (Object.hasOwn(now.overrides, nd.name)) { nd.value = now.overrides[nd.name]; nd.distribution = null; nd.provenance = now.provenance[nd.name] ?? { kind: "", source: "" }; }
    else if (!now.same.includes(nd.name)) { nd.value = null; nd.provenance = { kind: "", source: "" }; }
  }
  was.ours = false; was.overrides = wasOverrides; was.provenance = wasProv; was.same = [];
  now.ours = true; now.overrides = {}; now.provenance = {}; now.same = [];
  void names;
}

/* Step 4: each option's own numbers. */
function drawInputs(app, el) {
  const { state, ctx } = app;
  const opts = state.options;
  const cls = (o) => (o.ours ? "ours" : "");
  const you = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "you" && !/(^|_)included$/.test(nd.name));
  const groups = [...new Set(you.map((nd) => partOf(state, nd.name)))];
  const needAny = (nd) => opts.some((o) => neededFor(state, o).has(nd.name));
  const partName = (p) => (p === "other" ? "Other costs" : ctx.parts.find((x) => x.id === p)?.domain ?? p);
  const cell = (o, nd) => {
    if (!coversPart(state, o, partOf(state, nd.name))) return `<td class="${cls(o)} left">Not in this option</td>`;
    const has = o.ours ? !isBlank(nd) : Object.hasOwn(o.overrides, nd.name);
    const v = o.ours ? nd.value : o.overrides[nd.name];
    const same = !o.ours && o.same.includes(nd.name);
    const prov = o.ours ? nd.provenance : (same ? nd.provenance : o.provenance[nd.name]);
    return `<td class="${cls(o)} ${has || same ? "" : "blank"}"><div class="cell">
      <span class="val">${numInput(same ? nd.value : v, `data-opt="${o.id}" data-in="${nd.name}" ${same ? "disabled" : ""}`, `${o.name}: ${inputName(app, nd)}`)}${chip(`${o.id}|${nd.name}`, prov ?? { kind: "", source: "" }, same)}</span>
      ${o.ours ? "" : `<label class="same"><input type="checkbox" data-same="${o.id}" data-in="${nd.name}" ${same ? "checked" : ""}> same as ${esc(ours(state).name)}</label>`}
    </div></td>`;
  };
  const body = groups.map((g) => {
    const rows = you.filter((nd) => partOf(state, nd.name) === g);
    const top = groups.length > 1 ? `<tr class="grp"><td>${esc(partName(g))}</td>${opts.map((o) => `<td class="${cls(o)}">${coversPart(state, o, g) ? "" : '<span class="note">not covered</span>'}</td>`).join("")}</tr>` : "";
    return top + rows.map((nd) => `<tr><td>${esc(inputName(app, nd))} ${badge(needAny(nd) ? "needed" : "optional")}<span class="unit">${esc(unitWords(nd.unit))}</span></td>${opts.map((o) => cell(o, nd)).join("")}</tr>`).join("");
  }).join("");
  el.innerHTML = `
    <p class="note" style="margin:0">What each option provides and charges. The customer's requirements are not repeated here: every option uses the same ones. Click an origin to say where a number came from. An option with no figure of its own for something can be marked the same as ours; otherwise it stays blank until you enter one.</p>
    <div class="table-wrap"><table class="opts"><thead><tr><th></th>${opts.map((o) => `<th class="${cls(o)}">${esc(o.name)}${o.ours ? ' <span class="tag">Ours</span>' : ""}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="${opts.length + 1}" class="note">Nothing to fill in yet. Tick an area in Requirements, or add a cost line.</td></tr>`}</tbody></table></div>
    <div class="bulk">${opts.map((o) => `<div class="bulk-row"><span class="note">Where do ${esc(o.name)}'s figures come from, unless a figure says otherwise?</span>
      <select data-bulk-origin="${o.id}" aria-label="Origin for ${esc(o.name)}'s figures"><option value="">Choose…</option>${Object.entries(ORIGINS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select>
      <input type="text" data-bulk-evidence="${o.id}" placeholder="evidence, e.g. quote Q-1042 or the price list's URL" aria-label="Evidence for ${esc(o.name)}'s figures">
      <button type="button" class="ghost" data-bulk-apply="${o.id}">Apply to figures not yet said</button></div>`).join("")}</div>
    <div class="row" style="margin-top:10px"><button type="button" class="ghost" id="show-addline">+ Add a cost line</button></div>
    <div class="addline" id="addline" hidden>
      <input type="text" id="line-name" placeholder="What it is, e.g. Training" aria-label="Name of the cost line">
      <select id="line-when" aria-label="When it is paid"><option value="once">Paid once</option><option value="yearly">Paid every year</option></select>
      <button type="button" class="ghost" id="add-line">Add</button>
    </div>
    ${nextButton("inputs")}`;
  const names = byName(state.doc);
  for (const x of el.querySelectorAll("[data-opt]")) x.oninput = () => {
    const o = optionById(state, x.dataset.opt), nd = names.get(x.dataset.in);
    const v = x.value.trim() === "" ? NaN : Number(x.value);
    if (o.ours) setNum(nd, x);
    else { if (Number.isFinite(v)) o.overrides[nd.name] = v; else { delete o.overrides[nd.name]; delete o.provenance[nd.name]; } x.closest("td")?.classList.toggle("blank", !Number.isFinite(v)); }
    app.save(); refresh(app);
  };
  for (const x of el.querySelectorAll("[data-same]")) x.onchange = () => {
    const o = optionById(state, x.dataset.same), name = x.dataset.in;
    if (x.checked) { o.same = [...new Set([...o.same, name])]; delete o.overrides[name]; delete o.provenance[name]; } else o.same = o.same.filter((s) => s !== name);
    app.save(); drawBuild(app);
  };
  for (const b of el.querySelectorAll("[data-bulk-apply]")) b.onclick = () => {
    const o = optionById(state, b.dataset.bulkApply);
    const via = el.querySelector(`[data-bulk-origin="${o.id}"]`).value, evidence = el.querySelector(`[data-bulk-evidence="${o.id}"]`).value.trim();
    if (!via) return;
    for (const nd of you) {
      if (!coversPart(state, o, partOf(state, nd.name))) continue;
      if (o.ours) { if (!isBlank(nd) && !originOf(nd.provenance)) nd.provenance = provenanceFor(via, evidence); }
      else if (Object.hasOwn(o.overrides, nd.name) && !originOf(o.provenance[nd.name])) o.provenance[nd.name] = provenanceFor(via, evidence);
    }
    app.save(); drawBuild(app);
  };
  el.querySelector("#show-addline").onclick = () => { const f = el.querySelector("#addline"); f.hidden = !f.hidden; if (!f.hidden) el.querySelector("#line-name").focus(); };
  el.querySelector("#add-line").onclick = () => { const name = el.querySelector("#line-name").value.trim(); if (!name) return; addCostLine(app, name, el.querySelector("#line-when").value); app.save(); drawBuild(app); };
  wireNext(app, el);
}

/* Step 5: what is still needed, and what would merely be nice to have. */
function drawMissing(app, el) {
  const { state, ctx } = app;
  const { req, opt } = missing(state);
  const where = (x) => (x.scope === "shared" ? `Customer requirements · ${ctx.parts.find((p) => p.id === partOf(state, x.name))?.requirements?.[state.map[x.name]?.local] ?? ""}` : x.option.name);
  const item = (x) => `<li><span>${esc(inputName(app, x.node))}<span class="why2">${esc(where(x))}${x.scope !== "shared" && !x.option.ours ? " · or mark it the same as ours" : ""}</span></span><button type="button" class="link" data-goto="${x.scope}|${x.name}">Enter</button></li>`;
  el.innerHTML = `
    <p class="note" style="margin:0">Nothing is filled in for you. A required value is one the calculation cannot do without; an optional one it can.</p>
    <div id="interview"></div>
    <div class="missing" style="margin-top:10px">
      <div><h4>Required <span class="badge needed">${req.length}</span></h4>${req.length ? `<ul>${req.map(item).join("")}</ul>` : `<p class="none">Nothing required is missing.</p>`}</div>
      <div><h4>Optional <span class="badge">${opt.length}</span></h4>${opt.length ? `<ul>${opt.map(item).join("")}</ul>` : `<p class="none">Nothing optional is missing.</p>`}</div>
    </div>
    ${nextButton("missing")}`;
  drawInterview(app, el.querySelector("#interview"));
  for (const b of el.querySelectorAll("[data-goto]")) b.onclick = () => goTo(app, b.dataset.goto);
  wireNext(app, el);
}
function goTo(app, key) {
  const { state } = app;
  const [scope, name] = key.split("|");
  const step = scope === "shared" ? "requirements" : "inputs";
  if (!state.open.includes(step)) state.open.push(step);
  app.save(); drawBuild(app);
  const sel = scope === "shared" ? `[data-shared="${name}"]` : `[data-opt="${scope}"][data-in="${name}"]`;
  const x = document.querySelector(sel);
  if (x) { x.scrollIntoView({ block: "center", behavior: "smooth" }); x.focus({ preventScroll: true }); }
}

/* Step 6: the answer, as far as it can be worked out. */
function drawAnswerStep(app, el) {
  const { state } = app;
  const b = blocker(state);
  const name = answerNode(state);
  const unit = byName(state.doc).get(name)?.unit;
  el.innerHTML = b ? `<p class="callout warn">${esc(b)}. The answer appears as soon as every required value is in; nothing optional holds it up.</p>`
    : `<p class="note" style="margin:0">${esc(answerLabel(state))}, worked out the same way for every option:</p>
      <div class="table-wrap"><table><thead><tr><th>Option</th><th>${esc(answerLabel(state))}</th></tr></thead><tbody>${state.options.map((o) => `<tr><td>${esc(o.name)}${o.ours ? ' <span class="tag">Ours</span>' : ""}</td><td class="num">${esc(fmt(valueOf(app.evaluate(o), name), unit, state.doc.currency))}</td></tr>`).join("")}</tbody></table></div>
      <div class="next"><button type="button" class="primary" id="answer-go">See the answer →</button></div>`;
  el.querySelector("#answer-go")?.addEventListener("click", () => app.show("results"));
}

/* Summaries, the aside and anything that depends on values, without redrawing the fields being typed in. */
export function redrawBuild(app) { drawBuild(app); }
export function refresh(app) {
  const { state } = app;
  app.invalidate();
  if (state.mode !== "build") { app.setModes(); return; }
  for (const s of STEPS) { const sum = document.querySelector(`[data-sum="${s.id}"]`); if (sum) sum.textContent = stepSummary(app, s.id); }
  for (const r of document.querySelectorAll("[data-rq]")) r.classList.toggle("blank", isBlank(byName(state.doc).get(r.dataset.rq)));
  const mEl = $("body-missing");
  if (mEl && !mEl.contains(document.activeElement)) drawMissing(app, mEl);
  const aEl = $("body-answer");
  if (aEl) drawAnswerStep(app, aEl);
  $("aside-q").textContent = `${questionById(state.type).label}: ${answerLabel(state)}`;
  const name = answerNode(state);
  const unit = byName(state.doc).get(name)?.unit;
  $("optsum").innerHTML = state.options.map((o) => {
    const miss = missing(state).req.filter((x) => x.scope === "shared" || x.scope === o.id).length;
    const v = name ? valueOf(app.evaluate(o), name) : NaN;
    return `<li class="${o.ours ? "ours" : ""}"><span>${esc(o.name)} ${o.ours ? '<span class="tag">Ours</span>' : ""}</span>${miss ? `<span class="w">waits on ${miss}</span>` : Number.isFinite(v) ? `<span class="v">${esc(fmt(v, unit, state.doc.currency))}</span>` : '<span class="w">not yet</span>'}</li>`;
  }).join("");
  const b = blocker(state);
  const need = $("need");
  need.className = `need ${b ? "" : "ok"}`;
  need.textContent = b || "Ready";
  $("go-results").disabled = Boolean(b);
  $("structure-box").hidden = !state.expert;
  if (state.expert) $("structure").innerHTML = state.doc.nodes.filter((nd) => nd.kind !== "input").map((nd) => `<div><b>${esc(nd.label ?? nd.name)}</b> = ${esc(nd.kind === "derived" ? nd.formula : `${nd.of} kept below ${nd.limit} with headroom ${nd.headroom}`)}</div>`).join("");
  app.setModes();
}
