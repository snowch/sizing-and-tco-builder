/*
 * Drawing the builder: everything but the wizard, redrawn from the state on every change.
 */

import { point } from "../engine/evaluate.js";
import { sorted } from "../engine/python.js";
import { removeNode } from "./state.js";
import { $, chapterLink, chapters, esc, fmt } from "./ui.js";
import { CAUSE_WORDS, DECIDED_WORDS, PROVENANCE_WORDS, QUESTIONS, REFINE } from "./words.js";
import {
  graph, isComplete, measureFirst, parentsOf, pendingOrder, refinementDone, upstream,
} from "./workbench.js";
import { openWizard } from "./wizard.js";

// -- the value a node shows ------------------------------------------------------------------------

function valueText(v, unit = "") {
  if (!v) return "";
  switch (v.state) {
    case "ok":
      return `${fmt(v.value)}${unit && unit !== "dimensionless" ? ` ${unit}` : ""}`;
    case "to-define":
      return "to define";
    case "waits":
      return `waits on ${v.waits} to define`;
    case "not-yet-measured":
      return "not yet measured";
    case "unit":
      return "unit problem";
    case "formula":
      return "formula does not parse";
    case "unknown-unit":
      return "unknown unit";
    default:
      return "cannot be worked out";
  }
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const shown = (v) => v?.state === "to-define" || v?.state === "not-yet-measured";

function kindClass(app, name, v) {
  const node = app.state.doc.nodes.find((n) => n.name === name);
  if (!node || shown(v)) return "unknown";
  if (node.kind === "input" && node.provenance?.kind === "vendor_claim") return "vendor";
  return node.kind;
}

// -- header, tree, refinements ------------------------------------------------------------------------

export function drawHeader(app) {
  const { state } = app;
  $("title").textContent = state.doc.title || "Model Builder";
  const klass = state.doc.nodes.some((n) => n.kind === "measured" || n.kind === "ceiling") ? "conditional" : "definitional";
  const badge = $("klass");
  badge.hidden = !state.doc.nodes.length;
  badge.textContent = `${klass} model`;
  badge.className = `badge ${klass}`;
  badge.title = klass === "conditional"
    ? "It has a measured constant or a ceiling, so its answer holds only on what those describe (ch01)."
    : "Every relationship in it holds by definition, so sampling its inputs is enough (ch01).";
  $("qline").textContent = state.example ? `The book's model: ${state.exampleTitle}` : state.decision;
}

export function drawTree(app) {
  const { state, previewed, ui } = app;
  const nodes = graph(state);
  const rows = [];
  const seen = new Set();
  const walkTree = (name, depth) => {
    if (!nodes.has(name)) return;
    const again = seen.has(name);
    seen.add(name);
    rows.push({ name, depth, again });
    if (!again) for (const d of sorted(nodes.get(name).depends)) walkTree(d, depth + 1);
  };
  for (const o of state.doc.outputs) walkTree(o, 0);
  for (const n of state.doc.nodes) if (n.kind === "ceiling" && !seen.has(n.name)) walkTree(n.name, 0);
  const loose = [...nodes.keys()].filter((n) => !seen.has(n));
  const row = ({ name, depth, again }) => {
    const v = previewed.values.get(name);
    const entry = nodes.get(name);
    const label = entry.node?.label || entry.pending?.label || name;
    const flag = v?.state === "to-define" ? '<span class="todo">define</span>'
      : v?.state === "waits" ? `<span class="todo waits">waits on ${v.waits}</span>`
        : v?.state === "not-yet-measured" ? '<span class="todo nym">not yet measured</span>'
          : ["unit", "formula", "unknown-unit", "error"].includes(v?.state) ? `<span class="todo bad">${esc(valueText(v))}</span>`
            : `<span class="v">${esc(valueText(v))}</span>`;
    return `<li style="padding-left:${depth * 14}px"><button type="button" class="treeitem" data-node="${esc(name)}" aria-current="${ui.selected === name}"><i class="swatch ${kindClass(app, name, v)}"></i><span class="n">${esc(label)}${again ? ' <span class="note">(above)</span>' : ""}</span>${again ? "" : flag}</button></li>`;
  };
  $("tree").innerHTML = rows.length
    ? rows.map(row).join("") + (loose.length ? `<li class="note" style="margin-top:6px">Feeding no answer (the build refuses these):</li>${loose.map((n) => row({ name: n, depth: 0 })).join("")}` : "")
    : '<li class="note">Nothing yet. The answer goes here first.</li>';
  for (const b of $("tree").querySelectorAll("[data-node]")) {
    b.addEventListener("click", () => {
      const name = b.dataset.node;
      if (nodes.get(name)?.pending) return openWizard(app, { type: "define", name });
      ui.selected = name;
      ui.tab = "node";
      app.render();
    });
  }
}

export function drawRefine(app) {
  const { state } = app;
  const complete = isComplete(state);
  $("refine-note").hidden = complete;
  $("refine").innerHTML = REFINE.map((r) => {
    const done = refinementDone(state, r.id);
    const skipped = state.skipped.includes(r.id);
    return `<li class="${done ? "ok" : ""}"><span class="tick">${done ? "✓" : skipped ? "–" : "○"}</span><div><span class="what">${esc(r.what)}</span> ${chapters(r.chapters)}${complete ? `<br><button type="button" data-refine="${r.id}">${done ? "Open" : "Do it"}</button>` : ""}</div></li>`;
  }).join("");
  for (const b of $("refine").querySelectorAll("[data-refine]")) b.addEventListener("click", () => refine(app, b.dataset.refine));
}

export function refine(app, id) {
  const { state, ui } = app;
  const tabs = { sources: "sources", measure: "measure", scenario: "scenarios" };
  if (id === "ceiling") return openWizard(app, { type: "ceiling" });
  if (id === "ranges") {
    const next = state.doc.nodes.find((n) => n.kind === "input" && n.decided === "outside" && n.sure !== "shape" && !n.keepOne);
    if (next) {
      ui.selected = next.name;
      ui.tab = "node";
      ui.askRange = next.name;
      return app.render();
    }
    return;
  }
  if (tabs[id]) {
    if (!state.seen.includes(id) && (id === "sources" || id === "measure")) state.seen.push(id);
    ui.tab = tabs[id];
    app.commit();
  }
}

// -- the next step ---------------------------------------------------------------------------------

export function drawCoach(app) {
  const { state, next } = app;
  const C = $("coach");
  const set = (cls, label, msg, sub, chapter, buttons) => {
    C.className = cls;
    C.innerHTML = `<span class="lbl">${label}</span><span class="msg">${esc(msg)}<small>${sub}${chapter ? ` ${chapters([chapter])}` : ""}</small></span>${buttons.map((b, i) => `<button type="button" data-coach="${i}"${i === buttons.length - 1 ? ' class="primary"' : ""}>${esc(b[0])}</button>`).join("")}`;
    for (const el of C.querySelectorAll("[data-coach]")) el.addEventListener("click", () => buttons[Number(el.dataset.coach)][1]());
  };
  if (state.example) {
    return set("", "The book's model", `This is ${state.exampleTitle}, from the book.`, "Look around: every node, its source and the build's checks. Its numbers are the book's, with the book's sources. Start your own when you are ready.", null, [["Start your own model", () => app.startOver()]]);
  }
  switch (next.id) {
    case "answer":
      return set("", "Next step", "Start with the answer: what are you being asked for?", "Name it and give it a unit. Everything else is worked back from it.", "point_estimates", [["Name the answer", () => openWizard(app, { type: "answer" })]]);
    case "decision":
      return set("", "Next step", "Say what decision the answer feeds.", "It is how you will know the answer is precise enough.", "a_tco_for_finance", [["Say the decision", () => openWizard(app, { type: "decision" })]]);
    case "horizon":
      return set("", "Next step", "When is the answer for? Set the horizon.", esc(QUESTIONS.horizon.why), "what_a_workload_is", [["Set the horizon", () => openWizard(app, { type: "horizon" })]]);
    case "hosts":
      return set("", "Next step", "One kind of host, or several roles?", "The answer is a count of machines. How they divide the work decides whether the needs add up or the largest wins.", "bandwidth_and_the_binding_constraint", [["Answer it", () => openWizard(app, { type: "hosts" })]]);
    case "define": {
      const nodes = graph(state);
      const p = state.pending.find((x) => x.name === next.name);
      const parents = parentsOf(nodes, next.name);
      return set("", "Next step", `Define ${p?.label || next.name}`, `${parents.length ? `Needed by ${esc(parents.join(", "))}. ` : ""}Is it given, worked out, or measured?`, "what_a_workload_is", [["Define it", () => openWizard(app, { type: "define", name: next.name })]]);
    }
    case "fix":
      return set("fix", "Fix first", next.check.text, "The book's build refuses a file with this problem.", next.check.chapter, [["See the checks", () => { app.ui.tab = "checks"; if (next.check.node) app.ui.selected = next.check.node; app.render(); }]]);
    case "refine":
      return set("", "Next step", next.refine.what, esc(next.refine.why), next.refine.chapters[0], [["Skip", () => { state.skipped.push(next.refine.id); app.commit(); }], ["Do it", () => refine(app, next.refine.id)]]);
    case "checking":
      return set("", "Checking", "Checking the file with the book's rules.", "Every scenario is sampled as the book's build samples it. This takes a moment on a large model.", null, []);
    default:
      return set("done", "Done", "The answer is worked back to its inputs, the book's checks pass, and every refinement is done or skipped.", "Open File to copy or download the model.", null, [["Open the file", () => { app.ui.tab = "file"; app.render(); }]]);
  }
}

// -- the graph -------------------------------------------------------------------------------------

export function drawGraph(app) {
  const { state, previewed, ui } = app;
  const nodes = graph(state);
  const layer = new Map();
  const depth = (name, trail = new Set()) => {
    if (layer.has(name)) return layer.get(name);
    if (trail.has(name)) return 0;
    trail.add(name);
    const deps = [...(nodes.get(name)?.depends ?? [])].filter((d) => nodes.has(d));
    const value = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, trail))) : 0;
    layer.set(name, value);
    return value;
  };
  for (const name of nodes.keys()) depth(name);
  const cols = new Map();
  for (const name of sorted(nodes.keys())) {
    const l = layer.get(name);
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(name);
  }
  const W = 196, H = 46, GX = 60, GY = 12, P = 12;
  const nc = Math.max(1, cols.size);
  const nr = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const width = P * 2 + nc * W + (nc - 1) * GX;
  const height = P * 2 + nr * H + (nr - 1) * GY;
  const svg = $("graph");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const pos = new Map();
  for (const [l, names] of cols) names.forEach((n, i) => pos.set(n, { x: P + l * (W + GX), y: P + i * (H + GY) }));
  let s = "";
  for (const [name, entry] of nodes) {
    for (const d of entry.depends) {
      const a = pos.get(d), b = pos.get(name);
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      s += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
  }
  const fills = { input: "--input", derived: "--derived", measured: "--measured", ceiling: "--ceiling", unknown: "--bg", vendor: "--vendor" };
  const edges = { input: "--input-edge", derived: "--derived-edge", measured: "--measured-edge", ceiling: "--ceiling-edge", unknown: "--muted", vendor: "--vendor-edge" };
  for (const [name, entry] of nodes) {
    const p = pos.get(name);
    const v = previewed.values.get(name);
    const cls = kindClass(app, name, v);
    const bad = ["unit", "formula", "unknown-unit", "error"].includes(v?.state);
    const label = entry.node?.label || entry.pending?.label || name;
    const ceiling = previewed.ceilings?.[name];
    s += `<g class="node${ui.selected === name ? " hot" : ""}" data-node="${esc(name)}" tabindex="0" role="button" aria-label="${esc(`${label}: ${valueText(v, entry.node?.unit)}`)}">`
      + `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="4" fill="var(${fills[cls]})" stroke="${bad ? "var(--bad)" : `var(${edges[cls]})`}" stroke-width="1.5"${cls === "unknown" ? ' stroke-dasharray="4 3"' : ""}/>`
      + (entry.node?.decided === "you" ? `<rect x="${p.x}" y="${p.y}" width="5" height="${H}" rx="2" fill="var(--input-edge)"/>` : "")
      + `<text x="${p.x + 12}" y="${p.y + 18}">${esc(label.length > 30 ? `${label.slice(0, 29)}…` : label)}</text>`
      + `<text class="v" x="${p.x + W - 10}" y="${p.y + 36}" text-anchor="end">${esc(clip(valueText(v, entry.node?.unit), 28))}${ceiling ? ` · ${esc(ceiling.verdict)}` : ""}</text></g>`;
  }
  svg.innerHTML = s;
  for (const g of svg.querySelectorAll(".node")) {
    const go = () => {
      const name = g.dataset.node;
      if (nodes.get(name)?.pending) return openWizard(app, { type: "define", name });
      ui.selected = name;
      ui.tab = "node";
      app.render();
    };
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
}

// -- the answers -----------------------------------------------------------------------------------

export function drawAnswers(app) {
  const { state, previewed, ranges } = app;
  if (!state.doc.outputs.length) {
    $("answers").innerHTML = "";
    $("answers-note").textContent = "No answers yet. The first is the one you name at the start.";
    return;
  }
  const withRanges = ranges && Object.keys(ranges.outputs ?? {}).length;
  const rows = state.doc.outputs.map((o) => {
    const node = state.doc.nodes.find((n) => n.name === o);
    const p = state.pending.find((x) => x.name === o);
    const v = previewed.values.get(o);
    const range = ranges?.outputs?.[o];
    const unit = node?.unit ?? p?.unit ?? "";
    return `<tr><td>${esc(node?.label || p?.label || o)}</td><td class="n">${esc(v?.state === "ok" ? fmt(v.value) : valueText(v))}</td>${withRanges ? `<td class="n range">${range ? `${fmt(range.p5)} to ${fmt(range.p95)}` : "—"}</td>` : ""}<td>${esc(unit)}</td></tr>`;
  });
  $("answers").innerHTML = `<tr><th>Answer</th><th>At the point</th>${withRanges ? "<th>Nine in ten draws between</th>" : ""}<th>Unit</th></tr>${rows.join("")}`;
  $("answers-note").innerHTML = withRanges
    ? `The middle column uses one number per input: its value, or the middle of its range. The next draws every input with a range from its shape, ${esc(ranges.samples.toLocaleString("en-GB"))} times with seed ${esc(ranges.seed)}, moving inputs together where the model says they do, and shows where nine in ten of the answers fall. It is a statement about this model's inputs, and exactly as good as they are. ${chapters(["monte_carlo", "correlation_and_convergence"])}`
    : `Every input is one number, so there is no range to show yet. Give an input outside your control a range and the answers get one. ${chapters(["peak_mean_and_growth"])}`;
}

// -- the side panel ----------------------------------------------------------------------------------

export function drawPanel(app) {
  const { ui } = app;
  for (const b of $("tabs").querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
  const P = $("panel");
  const view = PANELS[ui.tab] ?? PANELS.node;
  P.innerHTML = view.html(app);
  view.wire?.(app, P);
}

const PANELS = {
  node: {
    html(app) {
      const { state, previewed, ui, ctx } = app;
      const name = ui.selected;
      const node = state.doc.nodes.find((n) => n.name === name);
      const pending = state.pending.find((p) => p.name === name);
      if (pending) {
        const parents = parentsOf(graph(state), name);
        return `<div class="inspector"><h2>still to define</h2><p class="q" style="font-size:16px">${esc(pending.label || name)}</p><p class="note">${parents.length ? `Needed by ${esc(parents.join(", "))}. ` : ""}${name === state.answer ? `It is the answer, in <code>${esc(pending.unit)}</code>.` : pending.unit ? `Its unit is fixed by the formula that uses it: <code>${esc(pending.unit)}</code>.` : "Its unit is settled when you define it."}</p><button type="button" class="primary" data-act="define">Define it</button></div>`;
      }
      if (!node) return '<p class="note">Pick a node in the tree or the graph.</p>';
      const v = previewed.values.get(name);
      const c = previewed.ceilings?.[name];
      const result = node.kind === "measured" ? ctx.results[node.result] : null;
      const shape = node.sure === "shape" && node.distribution ? `${node.distribution.shape}: ${Object.entries(node.distribution.parameters).map(([k, x]) => `${k} ${fmt(x)}`).join(", ")}` : "";
      const askRange = ui.askRange === name;
      return `<div class="inspector"><h2>${esc({ input: "given", derived: "worked out", measured: "measured", ceiling: "ceiling" }[node.kind])}</h2>
        <p class="q" style="font-size:16px">${esc(node.label || name)}</p>
        ${askRange ? `<div class="verdict warn">This input is outside your control and is one number. Give it a range with a shape, or say why one number is enough. ${chapters(["peak_mean_and_growth", "monte_carlo"])}<div class="row" style="margin-top:6px"><button type="button" data-act="range">Give it a range</button><button type="button" data-act="keep">One number is enough</button></div></div>` : ""}
        <dl><dt>name</dt><dd><code>${esc(name)}</code></dd>
        <dt>value</dt><dd class="mono">${esc(valueText(v, node.unit))}</dd>
        <dt>unit</dt><dd class="mono">${esc(node.unit)}</dd>
        ${node.kind === "input" ? `<dt>who decides</dt><dd>${esc(DECIDED_WORDS[node.decided] ?? "—")}</dd><dt>claim</dt><dd>${esc(PROVENANCE_WORDS[node.provenance?.kind] ?? "—")}</dd><dt>source</dt><dd>${esc(node.provenance?.source)}</dd>` : ""}
        ${shape ? `<dt>range</dt><dd class="mono">${esc(shape)}</dd>` : ""}
        ${node.kind === "derived" ? `<dt>formula</dt><dd class="mono">${esc(node.formula)}</dd>` : ""}
        ${node.kind === "measured" ? `<dt>result</dt><dd class="mono">${esc(node.result)}</dd>${result ? `<dt>measured on</dt><dd>${esc(result.produced_by?.stack)}</dd><dt>error</dt><dd class="mono">± ${fmt(result.summary.sd)}</dd><dt>holds for</dt><dd>${esc(Object.values(result.conditions ?? {})[0] ?? "")}</dd>` : "<dt>state</dt><dd>not taken yet</dd>"}` : ""}
        ${node.kind === "ceiling" ? `<dt>checks</dt><dd class="mono">${esc(node.of)}</dd><dt>limit</dt><dd class="mono">${esc(node.limit)}${c ? ` (${fmt(c.limit)})` : ""}</dd><dt>margin</dt><dd class="mono">${esc(node.headroom)}${c ? ` → allowed ${fmt(c.allowed)}` : ""}</dd>${c ? `<dt>verdict</dt><dd><strong>${esc(c.verdict)}</strong>${app.ranges?.ceilings?.[name] ? ` · over the allowed level in ${fmt(100 * app.ranges.ceilings[name].p_over_allowed)}% of draws` : ""}</dd>` : ""}<dt>because</dt><dd>${esc(node.because)}</dd>` : ""}
        ${node.note ? `<dt>note</dt><dd>${esc(node.note)}</dd>` : ""}</dl>
        ${v?.state === "unit" ? `<div class="verdict bad">The units of this formula do not work. The Checks tab has the book's wording once the model is complete.</div>` : ""}
        ${v?.message ? `<div class="verdict bad">${esc(v.message)}</div>` : ""}
        <div class="row"><button type="button" data-act="edit">Edit</button><button type="button" data-act="remove">Remove</button>
        <label class="row" style="width:auto"><input type="checkbox" data-act="output" style="width:auto" ${state.doc.outputs.includes(name) ? "checked" : ""}${name === state.answer ? " disabled" : ""}> an answer</label></div></div>`;
    },
    wire(app, P) {
      const name = app.ui.selected;
      P.querySelector("[data-act=define]")?.addEventListener("click", () => openWizard(app, { type: "define", name }));
      P.querySelector("[data-act=edit]")?.addEventListener("click", () => openWizard(app, { type: "edit", name }));
      P.querySelector("[data-act=range]")?.addEventListener("click", () => { app.ui.askRange = null; openWizard(app, { type: "edit", name }); });
      P.querySelector("[data-act=keep]")?.addEventListener("click", () => {
        const node = app.state.doc.nodes.find((n) => n.name === name);
        node.keepOne = true;
        app.ui.askRange = null;
        app.commit();
      });
      P.querySelector("[data-act=remove]")?.addEventListener("click", () => {
        if (!globalThis.confirm?.(`Remove ${name}? Formulas that use it will need it defined again.`)) return;
        const users = [...graph(app.state).values()].filter((e) => e.depends.has(name));
        removeNode(app.state, name);
        for (const u of users) if (u.name !== name) app.state.pending.push({ name, unit: null, label: name.replaceAll("_", " ") });
        app.state.pending = app.state.pending.filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i);
        app.ui.selected = null;
        app.commit();
      });
      P.querySelector("[data-act=output]")?.addEventListener("change", (e) => {
        const outs = app.state.doc.outputs;
        app.state.doc.outputs = e.target.checked ? [...new Set([...outs, name])] : outs.filter((o) => o !== name);
        app.commit();
      });
    },
  },

  checks: {
    html(app) {
      const list = app.checks;
      const klass = app.state.doc.nodes.some((n) => n.kind === "measured" || n.kind === "ceiling") ? "conditional" : "definitional";
      return `<h2>What the book's build checks</h2><p class="why">The rules <code>scripts/verify-models.py</code> applies to every model in the book, run by this builder's engine, which is held to the book's own toolkit case by case. A file that fails one does not build. ${chapters([], "appendix_a_dsl_reference")}</p>
        <ul class="checks">${list.length ? list.map((c) => `<li class="${c.level}">${esc(c.text)}${c.chapter ? ` <small>${chapterLink(c.chapter, { long: true })}</small>` : ""}${c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ""}</li>`).join("") : '<li class="todo">Nothing to check yet.</li>'}</ul>
        <p class="why" style="margin-top:14px">This is a <strong>${klass} model</strong>. ${klass === "conditional" ? "It has a measured constant or a ceiling, so its answer holds only for the implementation its constants were measured on and below the limits it declares." : "Every relationship in it holds by definition: sampling its inputs is enough."} ${chapters(["point_estimates"])}</p>`;
    },
  },

  file: {
    html(app) {
      const written = app.files;
      const blocks = Object.entries(written).map(([path, text]) => `<div><h3>${esc(path)}</h3><div class="row" style="margin-bottom:6px"><button type="button" data-copy="${esc(path)}">Copy</button><button type="button" data-download="${esc(path)}">Download</button><span class="note" data-said="${esc(path)}"></span></div><pre class="yaml">${esc(text)}</pre></div>`);
      return `<h2>The model file</h2><p class="why">The book's own format: the book's checks, its viewer and its problems read it as they read the book's models. Each scenario is a file of its own, in a <code>scenarios/</code> folder beside the model. ${chapters([], "appendix_a_dsl_reference")}</p>
        ${app.state.pending.length ? `<div class="verdict warn">Still to define: ${esc(app.state.pending.map((p) => p.name).join(", "))}. The book cannot load the file until they are, because a formula names them.</div>` : ""}
        <div class="grid2">${fieldHtml("f-model", "Model name", app.state.doc.model)}${fieldHtml("f-title", "Title", app.state.doc.title)}</div>
        <div class="files">${blocks.join("")}</div>`;
    },
    wire(app, P) {
      for (const b of P.querySelectorAll("[data-copy]")) {
        b.addEventListener("click", async () => {
          const path = b.dataset.copy;
          const say = P.querySelector(`[data-said="${CSS.escape(path)}"]`);
          try {
            await navigator.clipboard.writeText(app.files[path]);
            say.textContent = "Copied";
          } catch {
            const pre = b.parentElement.nextElementSibling;
            const range = document.createRange();
            range.selectNodeContents(pre);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            say.textContent = "Selected: copy with your keyboard";
          }
        });
      }
      for (const b of P.querySelectorAll("[data-download]")) {
        b.addEventListener("click", () => {
          const path = b.dataset.download;
          const url = URL.createObjectURL(new Blob([app.files[path]], { type: "text/yaml" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = path.replace("/", "-").replace(/^scenarios-/, "scenario-");
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      }
      const model = P.querySelector("#f-model");
      model?.addEventListener("change", () => {
        const v = model.value.trim();
        if (/^[a-z_][a-z0-9_]*$/.test(v)) { app.state.doc.model = v; app.commit(); } else model.setCustomValidity("Lower case, letters, digits and underscores.");
      });
      const title = P.querySelector("#f-title");
      title?.addEventListener("change", () => { app.state.doc.title = title.value; app.commit(); });
    },
  },

  sources: {
    html(app) {
      const inputs = app.state.doc.nodes.filter((n) => n.kind === "input");
      const group = (kind, head, swatch) => {
        const g = inputs.filter((n) => n.provenance?.kind === kind);
        return g.length ? `<h2 style="margin-top:12px"><i class="swatch ${swatch}"></i> ${esc(head)}</h2>${g.map((n) => `<p style="margin:0 0 8px"><strong>${esc(n.label || n.name)}</strong> <span class="note">${esc(DECIDED_WORDS[n.decided] ?? "")}${n.sure === "none" ? " · not known yet" : ""}</span><br><span class="note">${esc(n.provenance.source)}</span></p>`).join("")}` : "";
      };
      const measured = app.state.doc.nodes.filter((n) => n.kind === "measured");
      const outside = inputs.filter((n) => n.decided === "outside" && n.provenance?.kind !== "fact");
      return `<h2>Where the numbers come from</h2><p class="why">Every input, by how much its author was claiming. A vendor's claim is never promoted to a fact. The assumptions outside your control are the list of things you could go and measure; the decisions are yours to change. ${chapters(["where_the_numbers_come_from"])}</p>
        ${group("assumption", "Assumptions", "input")}${group("vendor_claim", "Vendors' claims", "vendor")}${group("fact", "Facts", "input")}
        ${measured.length ? `<h2 style="margin-top:12px"><i class="swatch measured"></i> Measured</h2>${measured.map((n) => `<p style="margin:0 0 8px"><strong>${esc(n.label || n.name)}</strong> <span class="note"><code>${esc(n.result)}</code>${app.ctx.results[n.result] ? `, measured on ${esc(app.ctx.results[n.result].produced_by?.stack)}` : ", not taken yet"}</span></p>`).join("")}` : ""}
        ${outside.length ? `<p class="note" style="margin-top:12px">Could be measured rather than assumed: ${outside.map((n) => `<code>${esc(n.name)}</code>`).join(", ")}.</p>` : ""}`;
    },
  },

  measure: {
    html(app) {
      const { state, previewed, ui } = app;
      const outputs = state.doc.outputs.filter((o) => previewed.values.get(o)?.state === "ok");
      if (!outputs.length) return `<h2>Which input to measure first</h2><p class="note">An answer needs a value first: define everything it rests on.</p>`;
      const output = outputs.includes(ui.measureOutput) ? ui.measureOutput : outputs[0];
      const t = measureFirst(previewed, output);
      const bars = t?.bars ?? [];
      const lo = Math.min(t.base, ...bars.map((b) => Math.min(b.low, b.high)));
      const hi = Math.max(t.base, ...bars.map((b) => Math.max(b.low, b.high)));
      const X = (v) => ((v - lo) / (hi - lo || 1)) * 100;
      const unshaped = state.doc.nodes.filter((n) => n.kind === "input" && n.decided === "outside" && n.sure !== "shape");
      const label = (n) => state.doc.nodes.find((x) => x.name === n)?.label || n;
      return `<h2>Which input to measure first</h2><p class="why">Each bar moves one input across the middle eight in ten of its own range (its 10th to its 90th percentile), with every other input at its point value, and shows how far the answer moves. The widest bar is the input the answer rests on most: measuring it narrows the answer most. ${chapters(["which_input_is_the_answer"])}</p>
        ${outputs.length > 1 ? `<div class="field"><label for="m-out">Answer</label><select id="m-out">${outputs.map((o) => `<option value="${esc(o)}"${o === output ? " selected" : ""}>${esc(label(o))}</option>`).join("")}</select></div>` : ""}
        ${bars.length ? `<div class="bars">${bars.map((b) => `<div class="bar" data-bar="${esc(b.node)}"><span>${esc(label(b.node))}</span><div class="track"><div class="fill" style="left:${X(Math.min(b.low, b.high))}%;width:${Math.max(1, X(Math.max(b.low, b.high)) - X(Math.min(b.low, b.high)))}%"></div><div class="mid" style="left:${X(t.base)}%"></div></div><div class="ends"><span>${fmt(b.low)}</span><span>${fmt(b.high)}</span></div></div>`).join("")}</div>` : `<p class="note">No input has a range yet, so nothing can be ranked.</p>`}
        ${unshaped.length ? `<p class="note" style="margin-top:12px">Not ranked, because each is one number: ${unshaped.map((n) => `<code>${esc(n.name)}</code>`).join(", ")}.</p>` : ""}
        <p class="note">One input at a time cannot show two inputs that matter only together. ${chapters(["which_input_is_the_answer", "the_missing_node"])}</p>`;
    },
    wire(app, P) {
      P.querySelector("#m-out")?.addEventListener("change", (e) => { app.ui.measureOutput = e.target.value; app.render(); });
    },
  },

  together: {
    html(app) {
      const shaped = app.state.doc.nodes.filter((n) => n.kind === "input" && n.sure === "shape").map((n) => n.name);
      const pairs = app.state.doc.correlations;
      return `<h2>Inputs that move together</h2><p class="why">Two inputs with ranges that rise and fall together widen every answer: a busier service is usually a slower one per request. Leaving a pair out says they move independently, which is a claim too. Each pair needs a reason, or the next model copies the number without knowing why. ${chapters(["correlation_and_convergence"])}</p>
        ${pairs.map((c, i) => `<div class="verdict warn"><code>${esc(c.a)}</code> and <code>${esc(c.b)}</code>, ${fmt(c.rho)}: ${esc(c.because)} <button type="button" class="link" data-remove="${i}">remove</button></div>`).join("")}
        ${shaped.length < 2 ? `<p class="note">Needs two inputs with a range. Give inputs a range first.</p>` : `
        <div class="grid2"><div class="field"><label for="c-a">This</label><select id="c-a">${shaped.map((k) => `<option>${esc(k)}</option>`)}</select></div>
        <div class="field"><label for="c-b">and this</label><select id="c-b">${shaped.map((k, i) => `<option${i === 1 ? " selected" : ""}>${esc(k)}</option>`)}</select></div>
        <div class="field"><label for="c-r">How strongly, from −1 to 1</label><input id="c-r" type="number" step="0.1" min="-1" max="1" inputmode="decimal"><span class="hint">1: they rise together exactly. 0: unrelated. −1: one rises as the other falls. Measured on their ranks.</span></div></div>
        <div class="field"><label for="c-w">Why they move together</label><textarea id="c-w"></textarea></div>
        <button type="button" class="primary" id="c-add">Add the pair</button> <span class="note" id="c-msg" aria-live="polite"></span>`}`;
    },
    wire(app, P) {
      for (const b of P.querySelectorAll("[data-remove]")) b.addEventListener("click", () => { app.state.doc.correlations.splice(Number(b.dataset.remove), 1); app.commit(); });
      P.querySelector("#c-add")?.addEventListener("click", () => {
        const a = P.querySelector("#c-a").value, b = P.querySelector("#c-b").value;
        const r = Number.parseFloat(P.querySelector("#c-r").value), why = P.querySelector("#c-w").value.trim();
        const msg = P.querySelector("#c-msg");
        if (a === b) return void (msg.textContent = "Pick two different inputs.");
        if (Number.isNaN(r) || r < -1 || r > 1) return void (msg.textContent = "The strength is between −1 and 1.");
        if (!why) return void (msg.textContent = "Say why they move together. The book does not check this; the builder asks, because a number with no reason gets copied.");
        if (app.state.doc.correlations.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) return void (msg.textContent = "That pair is already there.");
        app.state.doc.correlations.push({ a, b, rho: r, because: why });
        app.commit();
      });
    },
  },

  scenarios: {
    html(app) {
      const { state, previewed } = app;
      const inputs = state.doc.nodes.filter((n) => n.kind === "input" || n.kind === "measured").map((n) => n.name);
      const answers = (s) => {
        if (!previewed.model?.order) return "";
        try {
          const values = point(previewed.model, { overrides: new Map(Object.entries(s.overrides)) }, previewed.factors);
          return state.doc.outputs.filter((o) => values.has(o)).map((o) => `${esc(state.doc.nodes.find((n) => n.name === o)?.label || o)}: <span class="mono">${fmt(values.get(o))}</span>`).join(" · ");
        } catch (error) {
          return `<span style="color:var(--bad)">cannot be worked out: ${esc(error.message)}</span>`;
        }
      };
      return `<h2>Scenarios</h2><p class="why">A scenario is a small file beside the model that changes inputs, says why, and pins the seed so anyone can repeat the run. It never edits a formula: that would change the arithmetic while claiming to change an assumption. ${chapters(["a_tco_for_finance", "comparing_two_tcos"])}</p>
        ${state.scenarios.map((s, i) => `<div class="verdict ok"><strong>${esc(s.scenario)}</strong>${Object.keys(s.overrides).length ? `: ${Object.entries(s.overrides).map(([k, v]) => `<code>${esc(k)}</code> = ${fmt(v)}`).join(", ")}` : ""}<br><span class="note">${esc(s.because)}</span><br>${answers(s)}${i ? ` <button type="button" class="link" data-remove="${i}">remove</button>` : ""}</div>`).join("")}
        <div class="grid2">${fieldHtml("s-name", "Name", "", "twice_the_growth")}<div class="field"><label for="s-input">Input to change</label><select id="s-input">${inputs.map((k) => `<option>${esc(k)}</option>`)}</select></div>${fieldHtml("s-value", "Its value in this case", "", "", "number")}</div>
        <div class="field"><label for="s-why">Why this case matters</label><textarea id="s-why"></textarea></div>
        <button type="button" class="primary" id="s-add">Add the scenario</button> <span class="note" id="s-msg" aria-live="polite"></span>
        <p class="note">To change more than one input, add the scenario, then add it again with the same name and another input.</p>`;
    },
    wire(app, P) {
      for (const b of P.querySelectorAll("[data-remove]")) b.addEventListener("click", () => { app.state.scenarios.splice(Number(b.dataset.remove), 1); app.commit(); });
      P.querySelector("#s-add")?.addEventListener("click", () => {
        const name = P.querySelector("#s-name").value.trim(), input = P.querySelector("#s-input").value;
        const raw = P.querySelector("#s-value").value, why = P.querySelector("#s-why").value.trim();
        const msg = P.querySelector("#s-msg");
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) return void (msg.textContent = "Name it in lower case with underscores: it is the file's name.");
        if (raw.trim() === "" || Number.isNaN(Number(raw))) return void (msg.textContent = "Give the input's value in this case.");
        const existing = app.state.scenarios.find((s) => s.scenario === name);
        if (existing) {
          if (existing.scenario === "reference") return void (msg.textContent = "The reference scenario is the model as declared: it changes nothing.");
          existing.overrides[input] = Number(raw);
          if (why) existing.because = why;
        } else {
          if (!why) return void (msg.textContent = "Say why this case matters.");
          app.state.scenarios.push({ scenario: name, title: name.replaceAll("_", " "), because: why, samples: 100000, seed: 20260916, overrides: { [input]: Number(raw) } });
        }
        app.commit();
      });
    },
  },
};

function fieldHtml(id, label, value, placeholder = "", type = "text") {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" type="${type}"${type === "number" ? ' step="any" inputmode="decimal"' : ""} value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></div>`;
}

export { CAUSE_WORDS, pendingOrder, upstream };
