/*
 * The builder's entry point: load the book's data, restore the reader's model, draw, and redraw
 * on every change. Static files only; nothing leaves the browser.
 */

import { DSL_VERSION, loadModel, loadScenario } from "../engine/model.js";
import { Registry } from "../engine/units.js";
import { documentFrom, scenarioDocumentFrom } from "../engine/write.js";
import { emptyState, forget, load, reference, save } from "./state.js";
import { $, esc, useOutline } from "./ui.js";
import { drawAnswers, drawCoach, drawGraph, drawHeader, drawPanel, drawRefine, drawTree } from "./view.js";
import { openWizard, wireWizardButtons } from "./wizard.js";
import { drawTable } from "./table.js";
import { drawExplore } from "./explore.js";
import { ANSWERS, PATTERNS, money } from "./words.js";
import { judge } from "./judge.js";
import { checks, files, nextStep, preview, reinfer } from "./workbench.js";

async function data(name) {
  const response = await fetch(new URL(`../data/${name}`, import.meta.url));
  if (!response.ok) throw new Error(`could not load data/${name}`);
  return response.json();
}

async function boot() {
  const [units, results, outline, examples] = await Promise.all([
    data("units.json"), data("results.json"), data("outline.json"), data("examples.json"),
  ]);
  useOutline(outline);
  const ctx = { registry: new Registry(units), units, results, outline, examples, patterns: PATTERNS };
  const stored = load();
  const app = {
    ctx,
    state: stored ?? emptyState(),
    ui: { tab: "node", selected: null },
    previewed: null,
    render,
    commit() {
      reinfer(app.state, ctx.registry);
      if (!app.state.example) save(app.state);
      render();
    },
    startOver() {
      app.state = emptyState();
      app.ui = { tab: "node", selected: null };
      forget();
      render();
      showStart();
    },
  };
  globalThis.builder = app; // for the browser's console, and the flow tests

  // The verdict and the ranges come from a worker, so sampling never freezes the page. Each
  // request carries a number; an answer to an older request than the latest is dropped.
  let worker = null;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.postMessage({ type: "init", results: ctx.results, units });
  } catch {
    worker = null;
  }
  let asked = 0;
  let waiting = [];
  app.verdict = { id: 0, files: null, report: null, ranges: null };
  app.settled = () => (app.verdict.id === asked ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve)));
  function received(message) {
    if (message.id !== asked) return;
    app.verdict = { id: message.id, files: app.files, report: message.report ?? { load: { ok: false, message: message.error } }, ranges: message.ranges ?? null };
    draw();
    for (const resolve of waiting.splice(0)) resolve();
  }
  worker?.addEventListener("message", (event) => received(event.data));
  function ask() {
    const written = app.files;
    if (app.state.pending.length || !app.state.doc.nodes.length) {
      asked += 1;
      received({ id: asked, report: null, ranges: null });
      return;
    }
    if (app.verdict.files && JSON.stringify(app.verdict.files) === JSON.stringify(written)) return;
    asked += 1;
    if (worker) worker.postMessage({ type: "judge", id: asked, files: written });
    else received({ id: asked, ...judge(written, { results: ctx.results, units }) });
  }

  function render() {
    const { state } = app;
    const context = { registry: ctx.registry, results: ctx.results };
    app.previewed = preview(state, context);
    app.files = files(state);
    ask();
    draw();
  }

  function draw() {
    const { state } = app;
    const current = app.verdict.id === asked && app.verdict.report ? { files: app.verdict.files, report: app.verdict.report } : null;
    const checking = app.verdict.id !== asked;
    app.checks = checking ? [{ level: "todo", text: "Checking the file with the book's rules…" }] : checks(state, current);
    app.ranges = checking ? null : app.verdict.ranges;
    const answerUnit = state.pending.find((p) => p.name === state.answer)?.unit;
    const answerUnitIsHosts = Boolean(answerUnit) && /^hosts?$/.test(answerUnit.trim());
    app.next = checking && !state.pending.length && state.answer && state.horizon !== null ? { id: "checking" } : nextStep(state, { checks: app.checks, answerUnitIsHosts });
    if (!app.ui.selected && state.answer) app.ui.selected = state.answer;
    $("add-output").hidden = !state.answer || Boolean(state.example);
    drawHeader(app);
    drawTree(app);
    drawRefine(app);
    drawCoach(app);
    drawGraph(app);
    drawTable(app);
    drawExplore(app);
    drawAnswers(app);
    drawPanel(app);
  }

  function showStart() {
    $("start").hidden = false;
    $("goals").innerHTML = Object.entries(ANSWERS).map(([k, a]) => `<button type="button" class="goal" data-goal="${k}"><strong>${esc(a.title)}</strong><span>${esc(a.blurb)}</span>${a.unit ? `<span><code>${esc(money(a.unit, app.state.doc.currency))}</code></span>` : "<span><code>your unit</code></span>"}</button>`).join("");
    $("examples").innerHTML = ctx.examples.map((e) => `<button type="button" data-example="${esc(e.id)}">${esc(e.title)}</button>`).join("");
    for (const b of $("goals").querySelectorAll("[data-goal]")) {
      b.addEventListener("click", () => {
        app.state = emptyState();
        app.state.goal = b.dataset.goal;
        app.ui = { tab: "node", selected: null };
        $("start").hidden = true;
        app.commit();
        openWizard(app, { type: "answer" });
      });
    }
    for (const b of $("examples").querySelectorAll("[data-example]")) {
      b.addEventListener("click", () => {
        const example = ctx.examples.find((e) => e.id === b.dataset.example);
        const opened = openFiles(example.files);
        if (opened.error) return;
        app.state = opened.state;
        app.state.example = example.id;
        app.state.exampleTitle = example.title;
        app.ui = { tab: "node", selected: app.state.answer };
        $("start").hidden = true;
        render();
      });
    }
    $("goals").querySelector(".goal")?.focus();
  }

  /* A model file (and its scenarios) read with the engine, as the book reads it, into the state. */
  function openFiles(textByPath) {
    const modelPath = Object.keys(textByPath).find((p) => /(^|\/)model\.ya?ml$/.test(p)) ?? Object.keys(textByPath).find((p) => /^\s*nodes:/m.test(textByPath[p]));
    if (!modelPath) return { error: "None of these is a model file: a model file has a nodes: section." };
    let model;
    let upgradedFrom = null;
    let text = textByPath[modelPath];
    // A file written for an earlier version of the rules is read under the current ones, and the
    // checks say so; whatever the current rules refuse in it is refused as usual.
    const older = /^dsl:[ \t]*(\d+)[ \t]*$/m.exec(text);
    if (older && Number(older[1]) < DSL_VERSION) {
      upgradedFrom = Number(older[1]);
      text = text.replace(older[0], `dsl: ${DSL_VERSION}`);
    }
    try {
      model = loadModel(text, { registry: ctx.registry, results: ctx.results, where: modelPath });
    } catch (error) {
      return { error: `The book would refuse ${modelPath}: ${error.message}` };
    }
    let doc;
    try {
      doc = documentFrom(model);
    } catch (error) {
      return { error: `The builder cannot hold ${modelPath}: ${error.message}` };
    }
    const state = emptyState();
    // The builder writes the book's format, which says its version on its first line.
    state.doc = { ...doc, dsl: DSL_VERSION, nodes: doc.nodes.map((n) => (n.kind === "input" ? { ...n, sure: n.distribution ? "shape" : n.value === null ? "none" : "one" } : n)) };
    state.goal = "other";
    state.answer = doc.outputs[0] ?? null;
    state.decision = doc.description;
    state.horizon = doc.nodes.some((n) => n.name === "horizon") ? "horizon" : "none";
    state.hosts = "opened";
    state.scenarios = [];
    for (const [path, text] of Object.entries(textByPath)) {
      if (path === modelPath) continue;
      try {
        state.scenarios.push(scenarioDocumentFrom(loadScenario(text, path)));
      } catch {
        // Not a scenario file: ignored, as the book ignores files it does not read.
      }
    }
    if (!state.scenarios.some((s) => s.scenario === "reference")) state.scenarios.unshift(reference());
    state.seen = ["sources", "measure"];
    if (upgradedFrom !== null) state.upgradedFrom = upgradedFrom;
    return { state };
  }

  $("new").addEventListener("click", () => {
    if (app.state.doc.nodes.length && !app.state.example && !globalThis.confirm?.("Start a new model? The one here is replaced. Copy or download its file first to keep it.")) return;
    app.startOver();
  });
  $("open").addEventListener("click", () => $("openfile").click());
  $("add-output").addEventListener("click", () => openWizard(app, { type: "output" }));
  $("openfile").addEventListener("change", async (e) => {
    const chosen = [...e.target.files];
    const texts = Object.fromEntries(await Promise.all(chosen.map(async (f) => [f.name, await f.text()])));
    e.target.value = "";
    const opened = openFiles(texts);
    if (opened.error) {
      globalThis.alert?.(opened.error);
      return;
    }
    app.state = opened.state;
    app.ui = { tab: "checks", selected: app.state.answer };
    $("start").hidden = true;
    app.commit();
  });
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => {
      app.ui.view = b.dataset.view;
      draw();
    });
  }
  $("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
  });
  for (const b of $("tabs").querySelectorAll("[data-tab]")) {
    b.addEventListener("click", () => {
      app.ui.tab = b.dataset.tab;
      if ((b.dataset.tab === "sources" || b.dataset.tab === "measure") && !app.state.seen.includes(b.dataset.tab) && !app.state.example) {
        app.state.seen.push(b.dataset.tab);
        app.commit();
      } else render();
    });
  }
  wireWizardButtons();
  render();
  if (!stored) showStart();

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: new URL("../", import.meta.url).pathname });
    } catch {
      // Offline use is a convenience; the builder works without it.
    }
  }
}

boot().catch((error) => {
  document.body.insertAdjacentHTML("afterbegin", `<p class="verdict bad" style="margin:16px">The builder could not start: ${esc(error.message)}</p>`);
});
