/*
 * The page: loads the data and the part templates, keeps the state, evaluates each option
 * through the engine, asks the worker for the toolkit's verdict on the files, and draws
 * whichever view is open. The origin popover lives here because every view uses it.
 */

import { registryFor } from "../../engine/index.js";
import { judge } from "../../app/judge.js";
import { PROBLEM_WORDS } from "../../app/words.js";
import { plain } from "../../app/ui.js";
import { loadPart } from "./parts.js";
import { $, esc, fmt } from "./ui.js";
import { ORIGINS, evidenceOf, originOf, provenanceFor, SAMPLE_NOTES } from "./questions.js";
import { clear, emptyState, load, save } from "./state.js";
import { blocker, byName, evaluateOption, files, optionById, ours } from "./evaluate.js";
import { begin, drawBuild, drawStart, rebuildDoc, refresh, finderInputs } from "./journey.js";
import { drawResults } from "./results.js";
import { drawChecks, drawExplain } from "./explain.js";
import { createInterpreter } from "./interpret.js";

const here = new URL(".", import.meta.url);
const data = (name) => fetch(new URL(`../../data/${name}`, here)).then((r) => r.json());
const text = (path) => fetch(new URL(path, here)).then((r) => r.text());

async function main() {
  const [units, results, index] = await Promise.all([data("units.json"), data("results.json"), fetch(new URL("../templates/index.json", here)).then((r) => r.json())]);
  const registry = registryFor(units);
  const parts = await Promise.all(index.parts.map(async (meta) => loadPart(meta, await text(`../templates/${meta.file}`), { registry })));
  const ctx = { registry, results, units, index, parts, currency: parts[0]?.doc.currency ?? "GBP" };

  const app = { ctx, state: load() ?? emptyState(), verdict: { id: 0, report: null }, cache: new Map() };
  app.save = () => save(app.state);
  app.invalidate = () => { app.cache.clear(); askVerdict(); };
  app.evaluate = (option) => {
    if (!app.cache.has(option.id)) app.cache.set(option.id, evaluateOption(app.state, option, { registry, results }));
    return app.cache.get(option.id);
  };
  app.problemWords = (p) => {
    const words = PROBLEM_WORDS[p.code]?.[0];
    if (!words) return plain(`${p.code}${p.node ? ` (${p.node})` : ""}${p.detail ? `: ${p.detail}` : ""}`);
    return plain(words.replace("{node}", p.node ?? "a node").replace("{part}", p.part ? ` (${p.part})` : "").replace("{scenario}", p.scenario ?? "")) + (p.detail ? `: ${plain(p.detail)}` : "");
  };
  app.interpreter = createInterpreter(globalThis.__v2Interpreter ?? { loadBackend: (onProgress) => import("./webllm.js").then((m) => m.load(onProgress)) });

  // -- the toolkit's verdict on the files, off the page's thread where the browser allows ------------
  let worker = null;
  try { worker = new Worker(new URL("../../app/worker.js", import.meta.url), { type: "module" }); worker.postMessage({ type: "init", results, units }); } catch { worker = null; }
  let asked = 0;
  function received(m) {
    if (m.id !== asked) return;
    app.verdict = { id: m.id, report: m.report ?? { load: { ok: false, message: m.error } } };
    if (app.state.mode === "explain") drawChecks(app);
  }
  worker?.addEventListener("message", (e) => received(e.data));
  function askVerdict() {
    if (!app.state.doc || blocker(app.state)) { asked += 1; app.verdict = { id: asked, report: null }; return; }
    const written = files(app.state);
    asked += 1;
    app.verdict = { id: asked, report: null };
    if (worker) worker.postMessage({ type: "judge", id: asked, files: written });
    else received({ id: asked, ...judge(written, { results, units }) });
  }

  // -- modes ------------------------------------------------------------------------------------------
  app.setModes = () => {
    const { state } = app;
    const started = state.mode !== "start" && state.doc;
    const done = started && !blocker(state);
    const b = $("m-build"), r = $("m-results"), x = $("m-explain");
    b.disabled = !started; r.disabled = !done; x.disabled = !done;
    r.title = done ? "Results: communicate the answer" : "Fill in every required value first";
    x.title = done ? "Explain: defend every number" : "Fill in every required value first";
    for (const [el, m] of [[b, "build"], [r, "results"], [x, "explain"]]) el.setAttribute("aria-pressed", String(state.mode === m));
    $("expert").setAttribute("aria-pressed", String(state.expert));
  };
  app.show = (mode) => {
    const { state } = app;
    state.mode = mode;
    $("pop").hidden = true;
    for (const m of ["start", "build", "results", "explain"]) $(`v-${m}`).hidden = m !== mode;
    $("solution-line").textContent = mode === "start" ? "New answer" : state.sentence;
    if (mode === "start") drawStart(app);
    if (mode === "build") drawBuild(app);
    if (mode === "results") { app.invalidate(); drawResults(app); }
    if (mode === "explain") { app.invalidate(); drawExplain(app); }
    app.setModes();
    app.save();
    window.scrollTo({ top: 0 });
  };

  // -- the start screen's controls --------------------------------------------------------------------
  $("sentence").oninput = (e) => { app.state.sentence = e.target.value; app.state.sentenceEdited = true; app.save(); };
  $("notes").oninput = (e) => { app.state.notes = e.target.value; app.save(); };
  $("sample-notes").onclick = () => { app.state.notes = SAMPLE_NOTES; $("notes").value = SAMPLE_NOTES; $("notes").focus(); app.save(); };
  $("go-find").onclick = () => {
    if (!app.state.notes.trim()) { $("start-note").textContent = "Paste some notes first, or skip and enter values yourself."; return; }
    begin(app, { find: true }); app.save(); app.show("build");
  };
  $("go-skip").onclick = () => { begin(app, { find: false }); app.save(); app.show("build"); };
  $("go-results").onclick = () => app.show("results");
  $("m-build").onclick = () => app.show("build");
  $("m-results").onclick = () => app.show("results");
  $("m-explain").onclick = () => { app.state.focus = null; app.show("explain"); };
  $("new").onclick = () => { clear(); app.state = emptyState(); app.cache.clear(); app.show("start"); };
  $("expert").onclick = () => { app.state.expert = !app.state.expert; app.save(); if (app.state.mode === "build") drawBuild(app); if (app.state.mode === "explain") $("expert-more").open = app.state.expert; app.setModes(); };

  // -- the interpreter, optional --------------------------------------------------------------------------
  app.interpretNotes = async (notice) => {
    notice.hidden = false;
    const status = await app.interpreter.status();
    if (!status.available) { notice.textContent = status.reason; return; }
    if (!notice.dataset.agreed) {
      notice.innerHTML = `The on-device model is ${esc(status.size ?? "a download")}. It runs in this browser; the notes never leave this device. It only suggests candidates, each with the sentence it came from, and nothing reaches the model until you confirm it. <button type="button" class="ghost" id="ai-go">Download and interpret</button>`;
      notice.querySelector("#ai-go").onclick = () => { notice.dataset.agreed = "1"; app.interpretNotes(notice); };
      return;
    }
    notice.innerHTML = `<span id="ai-text">Starting…</span><progress id="ai-progress" max="1" value="0"></progress>`;
    try {
      const found = await app.interpreter.interpret(app.state.notes, finderInputs(app), (p) => { const t = notice.querySelector("#ai-text"), pr = notice.querySelector("#ai-progress"); if (t) t.textContent = p.text ?? ""; if (pr && typeof p.progress === "number") pr.value = p.progress; });
      const keep = app.state.candidates.filter((c) => c.status !== "pending" || c.by !== "ai");
      app.state.candidates = [...keep, ...found.filter((c) => !keep.some((k) => k.status === "confirmed" && k.target === c.target))];
      app.save(); drawBuild(app);
      const n2 = document.querySelector("#ai-notice");
      if (n2) { n2.hidden = false; n2.textContent = `${found.length} candidate${found.length === 1 ? "" : "s"} suggested by the interpreter, marked as such. Confirm each one you agree with.`; }
    } catch (error) {
      notice.textContent = `The interpreter could not run: ${error.message}. The candidate finder still works without it.`;
    }
  };

  // -- the origin popover: click a chip to see the evidence and, where it is editable, change it ------
  const pop = $("pop");
  function scopeFor(key) {
    const [where, name] = key.split("|");
    const nd = byName(app.state.doc).get(name);
    if (!nd) return null;
    const o = where === "shared" ? null : optionById(app.state, where);
    if (!o || o.ours || nd.decided !== "you") return { nd, get: () => nd.provenance, set: (p) => { nd.provenance = p; }, whose: where === "shared" ? "Customer requirements" : (o?.name ?? "Our solution"), value: nd.value };
    return { nd, get: () => o.provenance[name] ?? { kind: "", source: "" }, set: (p) => { o.provenance[name] = p; }, whose: o.name, value: o.overrides[name] };
  }
  function openPop(btn) {
    const s = scopeFor(btn.dataset.org);
    if (!s) return;
    const ro = btn.dataset.ro === "1";
    const p = s.get();
    const via = originOf(p);
    pop.innerHTML = `<span class="k">${esc(s.whose)}</span><strong>${esc(s.nd.label ?? s.nd.name)}: ${esc(fmt(s.value, s.nd.unit, app.state.doc.currency))}</strong>
      <span class="k">Origin</span>${ro ? `<span>${via ? ORIGINS[via].label : "Not said yet"}</span>` : `<select id="pop-origin"><option value="">Not said yet</option>${Object.entries(ORIGINS).map(([k, v]) => `<option value="${k}" ${via === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>`}
      <span class="k">Evidence</span>${ro ? `<blockquote>${esc(evidenceOf(p) || "Not said yet")}</blockquote>` : `<input type="text" id="pop-source" value="${esc(evidenceOf(p))}" placeholder="the sentence, quote reference, document or URL">`}
      ${via ? `<span class="note">${esc(ORIGINS[via].note)}</span>` : ""}
      <button type="button" class="close" id="pop-close">Close</button>`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 24);
    pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    pop.style.top = `${r.bottom + 6 + 260 > innerHeight ? Math.max(12, r.top - 266) : r.bottom + 6}px`;
    $("pop-close").onclick = () => { pop.hidden = true; btn.focus(); };
    if (!ro) {
      const write = () => { const v = $("pop-origin").value, t = $("pop-source").value; s.set(v ? provenanceFor(v, t) : { kind: "", source: "" }); app.save(); refreshChips(); refresh(app); };
      $("pop-origin").onchange = write;
      $("pop-source").oninput = write;
    }
  }
  function refreshChips() {
    for (const b of document.querySelectorAll("button.chip[data-org]")) {
      const s = scopeFor(b.dataset.org);
      if (!s) continue;
      const via = originOf(s.get());
      b.className = `chip ${{ customer: "customer", quote: "quote", published: "published", assumption: "assume", fact: "defn" }[via] ?? "unset"}`;
      b.textContent = via ? ORIGINS[via].label : "Where from?";
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.chip[data-org]");
    if (b) { e.preventDefault(); e.stopPropagation(); openPop(b); return; }
    if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.hidden = true; });

  // -- go ------------------------------------------------------------------------------------------------
  if (app.state.doc && app.state.mode !== "start") { rebuildDoc(app); app.show(app.state.mode); } else app.show("start");

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register(new URL("../../sw.js", import.meta.url), { scope: new URL("../../", import.meta.url).pathname }); } catch { /* offline use is a convenience */ }
  }
  app.files = () => files(app.state);
  globalThis.__v2 = app;
}

main().catch((error) => { document.body.insertAdjacentHTML("afterbegin", `<p class="callout warn">The page could not start: ${esc(error.message)}</p>`); throw error; });
