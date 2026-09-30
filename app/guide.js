/*
 * Guided mode, on unless the reader asks to see everything: the page shows what the model is
 * ready for and nothing more, and each feature appears when the model makes it useful.
 *
 * What shows is worked out from the model alone, never from a record of what the reader has
 * done, so nobody can get stuck: a finished model, an example or an opened file shows everything
 * it can use at once. A feature that has just appeared carries a "new" mark until it is used.
 */

import { blanksOrder, isComplete } from "./workbench.js";

const KEY = "sizing-and-tco-builder:everything";

export function showingEverything() {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function showEverything(on) {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not remembered; the switch still works for this visit.
  }
}

/* Which features the model is ready for, by name. */
export function ready(app) {
  const { state, previewed } = app;
  const values = previewed?.values ?? new Map();
  const defined = Boolean(state.answer) && !state.pending.length;
  const workedOut = state.doc.nodes.some((n) => n.kind === "derived" && values.get(n.name)?.state === "ok");
  const answered = values.get(state.answer)?.state === "ok";
  const complete = defined && isComplete(state) && !blanksOrder(state).length && answered;
  const ranged = state.doc.nodes.filter((n) => n.kind === "input" && n.sure === "shape").length;
  return {
    "tab:node": true,
    "tab:checks": defined,
    "tab:file": defined,
    "tab:sources": defined,
    "tab:measure": complete && ranged >= 1,
    "tab:together": complete && ranged >= 2,
    "tab:scenarios": complete,
    "view:graph": true,
    "view:table": workedOut,
    "view:explore": complete,
    answers: workedOut,
  };
}

/* Show and hide the page's features to match, and mark the ones that have just appeared. */
export function applyGuide(app) {
  const everything = showingEverything();
  const toggle = document.getElementById("guide");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(everything));
    toggle.title = everything ? "Show only what the model is ready for" : "Show every feature, whatever the model is ready for";
  }
  const open = ready(app);
  // The tab or view the reader is on is always shown: the next-step card may have sent them there.
  open[`tab:${app.ui.tab}`] = true;
  open[`view:${app.ui.view ?? "graph"}`] = true;
  const noticed = (app.state.noticed ??= Object.keys(open).filter((k) => open[k]));
  const show = (el, key) => {
    if (!el) return;
    el.hidden = !everything && !open[key];
    el.classList.toggle("new", !everything && open[key] && !noticed.includes(key) && key !== "answers");
  };
  for (const b of document.querySelectorAll("#tabs [data-tab]")) show(b, `tab:${b.dataset.tab}`);
  for (const b of document.querySelectorAll("[data-view]")) show(b, `view:${b.dataset.view}`);
  const views = [...document.querySelectorAll("[data-view]")].filter((b) => !b.hidden);
  document.querySelector(".viewswitch").hidden = views.length < 2;
  show(document.querySelector(".results"), "answers");
}

/* A feature used for the first time loses its "new" mark. */
export function notice(app, key) {
  const noticed = (app.state.noticed ??= []);
  if (!noticed.includes(key)) noticed.push(key);
}
