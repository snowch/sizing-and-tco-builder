/*
 * The interview: the app asks for what is still missing, one question at a time, in fixed words
 * generated from the model; the engineer answers in their own; the answer is read into the
 * input's unit (by the on-device model where there is one, by a plain number reader otherwise)
 * and shown as a candidate the engineer confirms. "Don't know" leaves the blank. Nothing is
 * ever filled in by the page.
 *
 * It is not a conversation: the page's side is the question, the unit and the reason; the
 * model's reply is a number or nothing, never prose.
 */

import { $, esc, fmt, lower, unitWords } from "./ui.js";
import { ORIGINS, provenanceFor } from "./questions.js";
import { byName, isBlank, missing, optionById, ours } from "./evaluate.js";

const label = (nd) => nd.label ?? nd.name.replaceAll("_", " ");

/* The questions still open, required first: each a scope and an input. */
export function questions(app) {
  const { state } = app;
  const { req, opt } = missing(state);
  const skipped = new Set(state.interview?.skipped ?? []);
  const list = [...req, ...opt].filter((x) => !skipped.has(`${x.scope}|${x.name}`));
  return list.map((x) => ({ key: `${x.scope}|${x.name}`, scope: x.scope, option: x.option ?? null, node: x.node, required: req.includes(x) }));
}
export function questionText(app, q) {
  const { state } = app;
  const what = lower(label(q.node));
  const unit = unitWords(q.node.unit) || (q.node.unit === "dimensionless" ? "a fraction" : "");
  const who = q.scope === "shared" ? "the customer's" : `${q.option.name}'s`;
  const ask = q.scope === "shared" ? `What is ${who} ${what}?` : `For ${q.option.name}, what is the ${what}?`;
  const why = q.required ? `Needed for the answer${q.scope !== "shared" ? ` for ${q.option.name}` : ""}.` : "Optional: the answer can be worked out without it.";
  return { ask, unit: unit ? `In ${unit}.` : "", why, note: q.node.note ?? "" };
}
const defaultOrigin = (q) => (q.scope === "shared" ? "customer" : q.option.ours ? "quote" : q.option.role === "current" ? "customer" : q.option.role === "rival" ? "published" : "assumption");

export function drawInterview(app, el) {
  const { state } = app;
  state.interview ??= { on: false, skipped: [], pending: null };
  const iv = state.interview;
  const list = questions(app);
  if (!iv.on) {
    el.innerHTML = list.length ? `<div class="row" style="margin-top:12px"><button type="button" class="primary" id="iv-start">Ask me what's missing</button><span class="note">${list.length} ${list.length === 1 ? "question" : "questions"}, one at a time. Answer in your own words; you confirm each figure before it goes in.</span></div>` : "";
    el.querySelector("#iv-start")?.addEventListener("click", () => { iv.on = true; iv.pending = null; app.save(); drawInterview(app, el); });
    return;
  }
  const q = list[0];
  if (!q) {
    el.innerHTML = `<div class="iv"><p class="callout">Nothing left to ask${iv.skipped.length ? `; ${iv.skipped.length} skipped. ` : ". "}<button type="button" class="link" id="iv-again">Ask the skipped ones again</button> · <button type="button" class="link" id="iv-stop">Close</button></p></div>`;
    el.querySelector("#iv-again").onclick = () => { iv.skipped = []; app.save(); drawInterview(app, el); };
    el.querySelector("#iv-stop").onclick = () => { iv.on = false; app.save(); drawInterview(app, el); };
    return;
  }
  const t = questionText(app, q);
  const pending = iv.pending && iv.pending.key === q.key ? iv.pending : null;
  const cur = state.doc.currency;
  el.innerHTML = `<div class="iv">
    <div class="iv-head"><span class="eyebrow">${esc(q.scope === "shared" ? "Customer requirements" : q.option.name)} · ${list.length} to go</span><button type="button" class="link" id="iv-stop">Close</button></div>
    <h4 class="iv-q">${esc(t.ask)}</h4>
    <p class="note" style="margin:2px 0 8px">${esc(t.unit)} ${esc(t.why)}${t.note ? ` ${esc(t.note)}` : ""}</p>
    ${pending ? `<div class="iv-cand ${pending.unknown ? "unknown" : ""}">
        ${pending.unknown ? `<span>No figure in that answer. Leave it blank for now?</span>` : `<span class="iv-val">${esc(fmt(pending.value, q.node.unit, cur))}</span><span class="note">read from “${esc(pending.answer)}”${pending.by === "ai" ? " by the on-device model" : ""}${pending.sure ? "" : " · not sure: check it"}</span>`}
        ${pending.unknown ? "" : `<span class="iv-origin"><label class="note" for="iv-via">Origin</label><select id="iv-via">${Object.entries(ORIGINS).map(([k, v]) => `<option value="${k}" ${k === (pending.via ?? defaultOrigin(q)) ? "selected" : ""}>${v.label}</option>`).join("")}</select></span>`}
        <span class="status">${pending.unknown ? `<button type="button" class="ok" id="iv-blank">Leave blank</button>` : `<button type="button" class="ok" id="iv-confirm">Confirm</button>`}<button type="button" id="iv-retry">Change the answer</button></span>
      </div>` : `<div class="iv-ask">
        <input type="text" id="iv-answer" placeholder="e.g. about 500, they said 480 last quarter" aria-label="Your answer" autocomplete="off">
        <button type="button" class="primary" id="iv-go">Answer</button>
        <button type="button" class="ghost" id="iv-unknown">Don't know</button>
        ${q.scope !== "shared" && !q.option.ours ? `<button type="button" class="ghost" id="iv-same">Same as ${esc(ours(state).name)}</button>` : ""}
        <button type="button" class="ghost" id="iv-skip">Skip for now</button>
      </div><p class="note iv-progress" id="iv-progress" hidden></p>
      ${app.interpreter.loaded() ? "" : `<p class="note" style="margin:6px 0 0">Answers are read as plain numbers (500 TB, £60k, 30%). To answer in your own words, load the on-device model from the Customer step first.</p>`}`}
  </div>`;
  el.querySelector("#iv-stop").onclick = () => { iv.on = false; iv.pending = null; app.save(); drawInterview(app, el); };
  const answer = async () => {
    const text = el.querySelector("#iv-answer").value.trim();
    if (!text) return;
    const progress = el.querySelector("#iv-progress");
    progress.hidden = false; progress.textContent = "Reading…";
    const read = await app.interpreter.interpretAnswer(t.ask, { name: label(q.node), unit: q.node.unit }, text, (p) => { app.chipProgress?.(p); progress.textContent = p.text ?? ""; });
    app.chipDone?.();
    iv.pending = { key: q.key, answer: text, ...read };
    app.save(); drawInterview(app, el);
  };
  el.querySelector("#iv-go")?.addEventListener("click", answer);
  el.querySelector("#iv-answer")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); answer(); } });
  el.querySelector("#iv-answer")?.focus();
  el.querySelector("#iv-unknown")?.addEventListener("click", () => { iv.skipped.push(q.key); iv.pending = null; app.save(); app.redrawBuild(); });
  el.querySelector("#iv-skip")?.addEventListener("click", () => { iv.skipped.push(q.key); iv.pending = null; app.save(); app.redrawBuild(); });
  el.querySelector("#iv-same")?.addEventListener("click", () => { const o = q.option; o.same = [...new Set([...o.same, q.node.name])]; delete o.overrides[q.node.name]; iv.pending = null; app.save(); app.redrawBuild(); });
  el.querySelector("#iv-blank")?.addEventListener("click", () => { iv.skipped.push(q.key); iv.pending = null; app.save(); app.redrawBuild(); });
  el.querySelector("#iv-retry")?.addEventListener("click", () => { iv.pending = null; app.save(); drawInterview(app, el); });
  el.querySelector("#iv-via")?.addEventListener("change", (e) => { iv.pending.via = e.target.value; app.save(); });
  el.querySelector("#iv-confirm")?.addEventListener("click", () => {
    const via = el.querySelector("#iv-via").value;
    const evidence = `“${pending.answer}”${pending.by === "ai" ? " (read by the on-device model)" : ""}`;
    const prov = provenanceFor(via, evidence);
    if (q.scope === "shared" || q.option.ours) {
      const nd = byName(state.doc).get(q.node.name);
      nd.value = pending.value; nd.distribution = null; nd.provenance = prov;
    } else {
      q.option.overrides[q.node.name] = pending.value;
      q.option.provenance[q.node.name] = prov;
      q.option.same = q.option.same.filter((x) => x !== q.node.name);
    }
    iv.pending = null;
    app.save(); app.redrawBuild();
  });
  void isBlank; void optionById; void $;
}
