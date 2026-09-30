/*
 * The Results view: the answer, plainly; how it compares with each other option; where the
 * money goes, by category; and what-ifs, each a copy of the model with one thing changed.
 */

import { $, big, esc, fmt, lower, money, n } from "./ui.js";
import { questionById } from "./questions.js";
import { answerLabel, answerNode, atOption, byName, coversPart, neededFor, ours, partOf, valueOf } from "./evaluate.js";

/* The cost lines by category, through the parts' metadata; an added line is "Other". */
export function categories(app) {
  const { state, ctx } = app;
  const out = new Map();
  for (const nd of state.doc.nodes) {
    if (nd.kind !== "derived") continue;
    const m = state.map[nd.name];
    const cat = nd.added ? "Other" : ctx.parts.find((p) => p.id === m?.part)?.lines?.[m.local];
    if (!cat) continue;
    if (!out.has(cat)) out.set(cat, []);
    out.get(cat).push(nd.name);
  }
  return [...ctx.index.categories, "Other"].filter((c) => out.has(c)).map((c) => ({ name: c, lines: out.get(c) }));
}
export const catTotal = (app, ev, o, cat) => cat.lines.reduce((s, name) => s + (coversPart(app.state, o, partOf(app.state, name)) ? valueOf(ev, name) : 0), 0);

export function drawResults(app) {
  const { state } = app;
  const q = questionById(state.type);
  const cur = state.doc.currency;
  const us = ours(state), eu = app.evaluate(us);
  const name = answerNode(state);
  const unit = byName(state.doc).get(name)?.unit;
  const f = (v) => (q.kind === "cost" ? big(v, cur) : fmt(v, unit, cur));
  const mu = valueOf(eu, name);
  const others = state.options.filter((o) => o !== us);
  const h = byName(state.doc).get("horizon")?.value;
  const yrs = typeof h === "number" ? `over ${n(h)} ${h === 1 ? "year" : "years"}` : "";
  $("res-title").textContent = state.sentence || "The answer";
  $("answer").innerHTML = `
    <div class="answer"><span class="lbl">${esc(answerLabel(state))} · ${esc(us.name)}</span><span class="big">${esc(f(mu))}</span>
      <span class="row"><button type="button" class="link" data-why="total|${us.id}">Why? →</button><span class="note">Every figure traces back to an input and where it came from.</span></span></div>
    ${others.length ? `<div class="vs">${others.map((o) => {
      const m = valueOf(app.evaluate(o), name), d = m - mu;
      const good = q.kind === "cost" ? d > 0 : q.metric === "performance" ? d < 0 : d > 0;
      const words = q.kind === "cost" ? `${big(Math.abs(d), cur)} ${d > 0 ? "lower" : "higher"}` : unit === "dimensionless" ? `${n(Math.abs(d) * 100, 1)} points ${d > 0 ? "lower" : "higher"}` : `${fmt(Math.abs(d), unit, cur)} ${d > 0 ? "fewer" : "more"}`;
      const pct = q.kind === "cost" && m ? `${n((Math.abs(d) / Math.abs(m)) * 100)}% ${d > 0 ? "lower" : "higher"} ${yrs}` : "";
      return `<div class="card2"><span class="lbl">Compared with ${esc(o.name)}</span>
        <span class="big ${Math.abs(d) < 1e-9 ? "" : good ? "good" : "bad"}">${Math.abs(d) < 1e-9 ? "the same" : esc(words)}</span>
        ${pct ? `<span class="pct">${esc(pct)}</span>` : ""}
        <span class="sub">${esc(us.name)} ${esc(f(mu))} · ${esc(o.name)} ${esc(f(m))}</span>
        <button type="button" class="link why" data-why="${q.kind === "cost" ? "saving" : "total"}|${o.id}">Why? →</button></div>`;
    }).join("")}</div>` : ""}`;
  for (const b of document.querySelectorAll("[data-why]")) b.onclick = () => { const [kind, id] = b.dataset.why.split("|"); state.focus = { kind, id }; app.save(); app.show("explain"); };

  // The breakdown: by category for a cost answer; by resource for a sizing answer.
  const evs = state.options.map((o) => ({ o, ev: app.evaluate(o) }));
  const colour = (k) => `var(--s${(k % 8) + 1})`;
  if (q.kind === "cost") {
    $("bd-title").textContent = "Where the money goes";
    const cs = categories(app);
    const max = Math.max(...evs.map(({ ev }) => valueOf(ev, "total_cost")), 1);
    $("stack").innerHTML = evs.map(({ o, ev }) => `<div class="stackrow"><span class="name" title="${esc(o.name)}">${esc(o.name)}</span><span class="stackbar" role="img" aria-label="${esc(o.name)}: ${cs.map((c) => `${c.name} ${money(catTotal(app, ev, o, c), cur)}`).join(", ")}">${cs.map((c, k) => catTotal(app, ev, o, c) > 0 ? `<span style="width:${(catTotal(app, ev, o, c) / max) * 100}%;background:${colour(k)}" title="${esc(c.name)}: ${money(catTotal(app, ev, o, c), cur)}"></span>` : "").join("")}</span><span class="num">${big(valueOf(ev, "total_cost"), cur)}</span></div>`).join("");
    $("keys").innerHTML = cs.map((c, k) => `<span style="--c:${colour(k)}">${esc(c.name)}</span>`).join("");
    $("cost-table").innerHTML = `<thead><tr><th></th>${state.options.map((o) => `<th class="${o.ours ? "ours" : ""}">${esc(o.name)}</th>`).join("")}</tr></thead><tbody>${cs.map((c) => `<tr><td>${esc(c.name)}</td>${evs.map(({ o, ev }) => `<td class="num ${o.ours ? "ours" : ""}">${money(catTotal(app, ev, o, c), cur)}</td>`).join("")}</tr>`).join("")}<tr class="total"><td>Total ${esc(yrs)}</td>${evs.map(({ o, ev }) => `<td class="num ${o.ours ? "ours" : ""}">${money(valueOf(ev, "total_cost"), cur)}</td>`).join("")}</tr></tbody>`;
  } else {
    $("bd-title").textContent = "What sets the number";
    $("stack").innerHTML = "";
    $("keys").innerHTML = "";
    const P = (k) => (state.parts.length === 1 ? k : `infra_${k}`);
    const rows = ["units_for_cores", "units_for_memory", "units_for_data", "units", "raw_capacity", "cores_fill", "memory_fill", "data_fill"].map((k) => [P(k), byName(state.doc).get(P(k))]).filter(([, nd]) => nd);
    const setBy = (ev) => Object.entries({ processor: valueOf(ev, P("units_for_cores")), memory: valueOf(ev, P("units_for_memory")), data: valueOf(ev, P("units_for_data")) }).sort((a, b) => b[1] - a[1])[0][0];
    $("cost-table").innerHTML = `<thead><tr><th></th>${state.options.map((o) => `<th class="${o.ours ? "ours" : ""}">${esc(o.name)}</th>`).join("")}</tr></thead><tbody>${rows.map(([k, nd]) => `<tr><td>${esc(nd.label ?? k)}</td>${evs.map(({ o, ev }) => `<td class="num ${o.ours ? "ours" : ""}">${esc(fmt(valueOf(ev, k), nd.unit, cur))}</td>`).join("")}</tr>`).join("")}<tr class="total"><td>Set by</td>${evs.map(({ o, ev }) => `<td class="num ${o.ours ? "ours" : ""}">${setBy(ev)}</td>`).join("")}</tr></tbody>`;
  }

  drawWhatIfs(app);
}

/* What-ifs: plain questions built from the inputs the answer uses, and any number of any option. */
function drawWhatIfs(app) {
  const { state } = app;
  const names = byName(state.doc);
  const needed = new Set(state.options.flatMap((o) => [...neededFor(state, o)]));
  const shared = state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "outside" && needed.has(nd.name) && typeof nd.value === "number");
  const label = (nd) => nd.label ?? nd.name.replaceAll("_", " ");
  const QUICK = [];
  const growth = shared.find((nd) => /growth/.test(nd.name));
  if (growth) QUICK.push({ label: `growth is ${n((growth.value + 0.1) * 100)}% instead of ${n(growth.value * 100)}%`, changes: [{ scope: "shared", name: growth.name, value: growth.value + 0.1 }] });
  const h = names.get("horizon");
  if (h && typeof h.value === "number" && needed.has("horizon")) QUICK.push({ label: `we need ${n(h.value + 2)} years instead of ${n(h.value)}`, changes: [{ scope: "shared", name: "horizon", value: h.value + 2 }] });
  const prices = state.options.flatMap((o) => state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "you" && /(^|_)(price|server_price)$/.test(nd.name) && neededFor(state, o).has(nd.name)).map((nd) => { const v = o.ours ? nd.value : (o.overrides[nd.name] ?? (o.same.includes(nd.name) ? nd.value : null)); return typeof v === "number" && v > 0 ? { scope: o.id, name: nd.name, value: v * 0.9 } : null; }).filter(Boolean));
  if (prices.length) QUICK.push({ label: "hardware prices fall 10%", changes: prices });
  const sites = shared.find((nd) => /sites$/.test(nd.name));
  if (sites) QUICK.push({ label: "the customer adds another site", changes: [{ scope: "shared", name: sites.name, value: sites.value + 1 }] });
  $("quick").innerHTML = QUICK.map((q, k) => `<button type="button" data-q="${k}">What if ${esc(q.label)}?</button>`).join("");
  for (const b of document.querySelectorAll("[data-q]")) b.onclick = () => { state.whatIfs.push(QUICK[Number(b.dataset.q)]); app.save(); drawScenarios(app); };
  const you = (o) => state.doc.nodes.filter((nd) => nd.kind === "input" && nd.decided === "you" && neededFor(state, o).has(nd.name));
  $("c-input").innerHTML = `<optgroup label="Customer requirements">${shared.map((nd) => `<option value="shared|${nd.name}">${esc(label(nd))}</option>`).join("")}</optgroup>` +
    state.options.map((o) => `<optgroup label="${esc(o.name)}">${you(o).map((nd) => `<option value="${o.id}|${nd.name}">${esc(o.name)}: ${esc(lower(label(nd)))}</option>`).join("")}</optgroup>`).join("");
  $("c-add").onclick = () => {
    const [scope, name] = $("c-input").value.split("|");
    const raw = $("c-value").value.trim(), value = Number(raw);
    if (!raw || !Number.isFinite(value)) return;
    const nd = names.get(name);
    const o = scope === "shared" ? null : state.options.find((x) => x.id === scope);
    const was = scope === "shared" ? nd.value : (o.ours ? nd.value : (o.overrides[name] ?? nd.value));
    state.whatIfs.push({ label: `${o ? `${o.name}'s ` : ""}${lower(label(nd))} is ${fmt(value, nd.unit, state.doc.currency)} instead of ${fmt(was, nd.unit, state.doc.currency)}`, changes: [{ scope, name, value }] });
    $("c-value").value = "";
    app.save(); drawScenarios(app);
  };
  drawScenarios(app);
}
/* Every option's answer with some changes applied: shared ones to all, an option's to it alone. */
export function applied(app, changes) {
  const { state } = app;
  const name = answerNode(state);
  const out = {};
  for (const o of state.options) {
    const overrides = {};
    for (const c of changes) if (c.scope === "shared" || c.scope === o.id) overrides[c.name] = c.value;
    out[o.id] = Object.keys(overrides).length ? atOption(app.evaluate(o), overrides, [name]).get(name) ?? NaN : valueOf(app.evaluate(o), name);
  }
  return out;
}
function drawScenarios(app) {
  const { state } = app;
  const q = questionById(state.type);
  const cur = state.doc.currency;
  const us = ours(state);
  const unit = byName(state.doc).get(answerNode(state))?.unit;
  const cost = q.kind === "cost";
  const f = (v) => (cost ? money(v, cur) : fmt(v, unit, cur));
  const cols = [{ label: "Original answer", t: applied(app, []) }, ...state.whatIfs.map((s) => ({ label: `What if ${s.label}?`, t: applied(app, s.changes) }))];
  const rows = [
    ...state.options.map((o) => ({ name: `${o.name}: ${lower(answerLabel(state))}`, get: (t) => t[o.id], lowerBetter: q.metric !== "capacity" })),
    ...(cost ? state.options.filter((o) => o !== us).map((o) => ({ name: `Saving against ${o.name}`, get: (t) => t[o.id] - t[us.id], lowerBetter: false, strong: true })) : []),
  ];
  $("scen-table").innerHTML = `<thead><tr><th></th>${cols.map((c) => `<th style="white-space:normal;min-width:130px">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr><td${r.strong ? ' style="font-weight:700"' : ""}>${esc(r.name)}</td>${cols.map((c, k) => {
    const v = r.get(c.t), d = k ? v - r.get(cols[0].t) : 0;
    const better = r.lowerBetter ? d < 0 : d > 0;
    return `<td class="num"${r.strong ? ' style="font-weight:700"' : ""}>${esc(f(v))}${k && Number.isFinite(d) && Math.abs(d) >= 0.005 ? `<span class="d ${cost ? (better ? "down" : "up") : ""}">${d > 0 ? "+" : "−"}${esc(cost ? money(Math.abs(d), cur) : fmt(Math.abs(d), unit, cur))}</span>` : ""}</td>`;
  }).join("")}</tr>`).join("")}</tbody>`;
}
