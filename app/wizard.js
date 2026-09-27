/*
 * The wizard: one question per screen, each with the chapter that teaches it.
 *
 * It asks the book's questions in the order that builds a sound model (the answer, the decision
 * it feeds, the horizon, then each name to define), offers no default numbers, and does not move
 * on from an answer the book's build would refuse: a fact that cites nothing, a shape its source
 * does not name, a ceiling with no margin.
 */

import { CITATION_MARKERS } from "../engine/verify.js";
import { checkShape } from "../engine/evaluate.js";
import { writeModel } from "../engine/write.js";
import { addPending, exists, nodeNamed, pendingNamed, putNode } from "./state.js";
import { $, chapters, esc, fmt, nameProblem } from "./ui.js";
import {
  ANSWERS, CURRENCY_WHY, DECIDED, KIND_CHOICES, PROVENANCE, QUANTITY, QUESTIONS, SHAPES, SURE, money,
} from "./words.js";
import { graph, patternsFor, readFormula, unitWords, upstream } from "./workbench.js";

let W = null;
let APP = null;

const STEP_TITLES = {
  answer: "The answer", decision: "The decision", horizon: "The horizon", hosts: "The hosts",
  kind: "Given or worked out", name: "Name", unit: "Unit", decided: "Who decides", source: "Source",
  sure: "How sure", formula: "Formula", measured: "Measurement", ceiling: "The limit", review: "Review",
};

function stepsOf(w) {
  const d = w.draft;
  switch (w.type) {
    case "answer":
      return ["answer", "decision"];
    case "output":
      return ["answer"];
    case "decision":
      return ["decision"];
    case "horizon":
      return d.today || d.today === undefined ? ["horizon"] : ["horizon", "source", "sure", "review"];
    case "hosts":
      return ["hosts"];
    case "ceiling":
      return ["name", "ceiling", "review"];
    default: {
      const first = w.type === "define" ? ["kind"] : [];
      // A unit the formula already fixes is not asked again (design, "Nodes to define").
      const unit = d.fixedUnit ? [] : ["unit"];
      if (d.kind === "input") return [...first, "name", ...unit, "decided", "source", "sure", "review"];
      if (d.kind === "derived") return [...first, "name", ...unit, "formula", "review"];
      if (d.kind === "measured") return [...first, "measured", ...(d.untaken ? ["unit"] : []), "name", "review"];
      if (d.kind === "ceiling") return ["name", "ceiling", "review"];
      return first;
    }
  }
}

/* Open the wizard. spec: { type: answer|decision|horizon|hosts|define|edit|ceiling, name? } */
export function openWizard(app, spec) {
  APP = app;
  const { state } = app;
  const draft = { kind: null };
  if (spec.type === "answer") {
    const goal = ANSWERS[state.goal] ?? ANSWERS.other;
    const unit = (nodeNamed(state, state.answer) ?? pendingNamed(state, state.answer))?.unit ?? money(goal.unit, state.doc.currency);
    Object.assign(draft, { name: state.answer ?? "", label: "", unit, decision: state.decision, currency: state.doc.currency });
    if (!draft.name) draft.name = { hosts: "hosts", storage: "storage_to_buy", cost: "total_cost" }[state.goal] ?? "";
  } else if (spec.type === "output") {
    Object.assign(draft, { name: "", label: "", unit: "" });
  } else if (spec.type === "decision") {
    draft.decision = state.decision;
  } else if (spec.type === "horizon") {
    Object.assign(draft, { kind: "input", name: "horizon", label: "horizon", unit: "year", decided: "you", provenance: { kind: "assumption", source: "" }, sure: "one" });
  } else if (spec.type === "define") {
    const p = pendingNamed(state, spec.name);
    Object.assign(draft, { name: spec.name, label: p?.label ?? "", unit: p?.unit ?? "", fixedUnit: p?.unit ?? null, suggested: p?.suggested ?? null });
  } else if (spec.type === "edit") {
    Object.assign(draft, structuredClone(nodeNamed(state, spec.name)));
    draft.fixedUnit = null;
  } else if (spec.type === "ceiling") {
    Object.assign(draft, { kind: "ceiling", name: "", label: "", headroom: "" });
  }
  W = { type: spec.type, original: spec.name ?? null, step: 0, draft };
  $("wizard").hidden = false;
  draw();
}

export function closeWizard() {
  $("wizard").hidden = true;
  W = null;
}

// -- pieces ----------------------------------------------------------------------------------------

const choice = (group, value, title, desc, pressed, swatch = "") =>
  `<button type="button" class="choice" data-${group}="${esc(value)}" aria-pressed="${pressed}">${swatch ? `<i class="swatch ${swatch}"></i>` : "<span></span>"}<strong>${esc(title)}</strong><span class="d">${desc}</span></button>`;

const question = (key, extra = "") => {
  const q = QUESTIONS[key];
  return `<p class="q" id="wq">${esc(q.q)}</p><p class="why">${esc(q.why)}${extra} ${chapters(q.chapters, q.appendix)}</p>`;
};

const field = (id, label, value, { hint = "", mono = false, type = "text", placeholder = "", area = false } = {}) =>
  `<div class="field"><label for="${id}">${label}</label>${
    area
      ? `<textarea id="${id}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input id="${id}" type="${type}"${type === "number" ? ' step="any" inputmode="decimal"' : ""} class="${mono ? "mono" : ""}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="${mono ? "false" : "true"}">`
  }${hint ? `<span class="hint" id="${id}-hint">${hint}</span>` : ""}</div>`;

function unitHint(text) {
  if (!text) return "";
  const u = unitWords(APP.ctx.registry, text);
  return u.ok ? `The book's registry reads this as ${esc(u.words)}` : `<span style="color:var(--bad)">This is ${esc(u.words)}</span>`;
}

// -- the steps ----------------------------------------------------------------------------------

const VIEWS = {
  answer(d) {
    const goal = ANSWERS[APP.state.goal] ?? ANSWERS.other;
    return `${question("answer")}
      ${field("w-name", "Name in formulas", d.name, { mono: true, placeholder: "hosts", hint: "Lower case, letters, digits and underscores. Formulas use it." })}
      ${field("w-label", "Label", d.label, { placeholder: goal.title === "Something else" ? "peak request rate at the horizon" : "hosts to buy", hint: "The words a table shows." })}
      ${field("w-unit", "Unit", d.unit, { mono: true, placeholder: "host", hint: unitHint(d.unit) })}
      <div class="chips">${["host", "TB", d.currency, "request/second", "MB/s"].map((c) => `<button type="button" data-unit="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="field" style="margin-top:12px"><label for="w-currency">The currency the model prices in</label><select id="w-currency">${APP.ctx.registry.currencies.map((c) => `<option value="${esc(c)}"${c === d.currency ? " selected" : ""}>${esc(c)}</option>`).join("")}</select><span class="hint">${esc(CURRENCY_WHY)} ${chapters(["unit_economics"])}</span></div>`;
  },
  decision(d) {
    return `${question("decision")}${field("w-decision", "The decision", d.decision, { area: true, placeholder: QUESTIONS.decision.placeholder })}`;
  },
  horizon(d) {
    return `${question("horizon")}
      <div class="choices">${choice("today", "no", "Set a horizon", "An input you decide, in years or months. Growth figures are carried to it.", d.today === false, "input")}
      ${choice("today", "yes", "The answer is for today", "Nothing grows in this model. You can add a horizon later.", d.today === true)}</div>
      ${d.today === false ? `<div class="grid2" style="margin-top:12px">${field("w-name", "Name in formulas", d.name, { mono: true })}${field("w-unit", "Unit", d.unit, { mono: true, hint: unitHint(d.unit) })}</div><div class="chips">${["year", "month"].map((c) => `<button type="button" data-unit="${c}">${c}</button>`).join("")}</div>` : ""}`;
  },
  kind(d) {
    const p = pendingNamed(APP.state, d.name);
    const parents = [...graph(APP.state).values()].filter((e) => e.depends.has(d.name)).map((e) => e.name);
    const extra = `${parents.length ? ` It is used by ${esc(parents.join(", "))}.` : ""}${p?.unit ? ` Whatever it is, it is in <code>${esc(p.unit)}</code>: the formula that uses it fixes that.` : ""}`;
    return `<p class="q" id="wq">Is ${esc(d.label || d.name)} given, worked out, or measured?</p><p class="why">${esc(QUESTIONS.kind.why)}${extra} ${chapters(QUESTIONS.kind.chapters)}</p>
      <div class="choices">${KIND_CHOICES.map(([k, t, desc]) => choice("kind", k, t, esc(desc), d.kind === k, k)).join("")}</div>`;
  },
  name(d) {
    const note = d.kind === "input" || d.kind === "ceiling" || d.kind === "derived" || d.kind === "measured";
    return `${question("name")}
      ${field("w-name", "Name in formulas", d.name, { mono: true, placeholder: "peak_request_rate_t0", hint: "Renaming it renames it everywhere it is used." })}
      ${field("w-label", "Label", d.label, { placeholder: "peak request rate, day one" })}
      ${note ? field("w-note", "Note (optional)", d.note ?? "", { area: true, placeholder: "Whatever a reader of the file would otherwise have to ask you." }) : ""}`;
  },
  unit(d) {
    const fixed = d.fixedUnit ? ` The formula that uses it fixes its unit: <code>${esc(d.fixedUnit)}</code>. Another unit of the same kind works; a different kind breaks that formula.` : "";
    const qkind = d.qkind ?? guessKind(d.unit);
    const chips = (QUANTITY.find((q) => q[0] === qkind)?.[3] ?? []).map((c) => money(c, APP.state.doc.currency));
    return `${question("unit", fixed)}
      <div class="choices">${QUANTITY.map(([k, t, desc]) => choice("qkind", k, t, esc(desc), qkind === k)).join("")}</div>
      <div style="margin-top:12px">${field("w-unit", "Unit", d.unit, { mono: true, placeholder: "request/second", hint: unitHint(d.unit) })}</div>
      <div class="chips">${[...new Set([...(d.fixedUnit ? [d.fixedUnit] : []), ...(d.suggested ? [d.suggested] : []), ...chips])].map((c) => `<button type="button" data-unit="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      ${d.suggested && !d.fixedUnit ? `<p class="note">The book's own model uses <code>${esc(d.suggested)}</code> for a quantity by this name.</p>` : ""}`;
  },
  decided(d) {
    return `${question("decided")}<div class="choices">${DECIDED.map(([k, t, desc]) => choice("decided", k, t, esc(desc), d.decided === k, "input")).join("")}</div>`;
  },
  source(d) {
    const p = d.provenance ?? {};
    const hint = PROVENANCE.find((x) => x[0] === p.kind)?.[3] ?? "";
    return `${question("source")}<div class="choices">${PROVENANCE.map(([k, t, desc]) => choice("prov", k, t, esc(desc), p.kind === k, k === "vendor_claim" ? "vendor" : "")).join("")}</div>
      <div style="margin-top:12px">${field("w-source", "Source", p.source ?? "", { area: true, placeholder: hint })}</div>`;
  },
  sure(d) {
    const outside = d.decided === "outside";
    const shape = d.distribution?.shape ?? null;
    const params = d.distribution?.parameters ?? {};
    let body = "";
    if (d.sure === "one") body = field("w-value", `The number, in ${esc(d.unit)}`, d.value ?? "", { type: "number" });
    if (d.sure === "shape") {
      body = `<div class="field"><span class="field-label"><strong>Shape</strong></span><div class="chips">${Object.keys(SHAPES).map((s) => `<button type="button" data-shape="${s}" aria-pressed="${shape === s}"${shape === s ? ' style="border-color:var(--accent)"' : ""}>${s}</button>`).join("")}</div>${shape ? `<span class="hint">${esc(SHAPES[shape].words)}</span>` : ""}</div>`;
      if (shape) {
        body += `<div class="grid2">${SHAPES[shape].fields.map((f) => field(`w-p-${f}`, esc(SHAPES[shape].labels[f]), params[f] ?? "", { type: "number" })).join("")}</div>`;
        body += field("w-value", `The number at the point, in ${esc(d.unit)} (optional)`, d.value ?? "", { type: "number", hint: "Left blank, the book uses the middle of the range. Give one only if there is a figure you would quote on its own." });
        const named = (d.provenance?.source ?? "").toLowerCase().includes(shape);
        body += `<div class="verdict ${named ? "ok" : "warn"}">${named ? `The source names the shape.` : `The source must name the shape and say why it is ${esc(shape)}: the book's build checks for the word. Go back to the source to add it.`}</div>`;
      }
    }
    if (d.sure === "none") {
      body = `<div class="verdict warn">It and everything downstream will show as not yet measured. The book cannot work out a scenario with an input that has no number, so its checks will ask you for one before the file builds: give it a number, or make it a measurement nobody has taken yet.</div>`;
    }
    const range = d.sure === "one" || d.sure === "shape"
      ? `<div class="grid2">${field("w-r0", "Slider from (optional)", d.range?.[0] ?? "", { type: "number" })}${field("w-r1", "to", d.range?.[1] ?? "", { type: "number" })}</div><p class="note">Where the book's viewer lets a reader drag it. Not a claim about the range.</p>`
      : "";
    return `${question("sure", outside ? " This one is outside your control." : "")}
      <div class="choices">${SURE.map(([k, t, desc]) => choice("sure", k, t, esc(desc), d.sure === k)).join("")}</div>
      <div style="margin-top:12px">${body}</div>${range}`;
  },
  formula(d) {
    const patterns = patternsFor(APP.state, APP.ctx, d.name, d.unit);
    const names = APP.state.doc.nodes.map((n) => n.name).filter((n) => n !== W.original);
    return `${question("formula")}
      ${field("w-formula", `Formula, giving ${esc(d.unit)}`, d.formula ?? "", { mono: true, placeholder: "stored_data_t0 * annual_growth ** horizon_periods" })}
      <div id="w-live" aria-live="polite">${liveFormula(d)}</div>
      ${patterns.length ? `<p class="note" style="margin:0 0 4px">Patterns from the book's models that give ${esc(d.unit)}:</p><div class="sugs">${patterns.map((p) => `<button type="button" class="sug" data-formula="${esc(p.formula)}"><code>${esc(p.formula)}</code><span>${esc(p.words)} ${chapters(p.chapters)}</span></button>`).join("")}</div>` : ""}
      ${names.length ? `<p class="note" style="margin:8px 0 4px">Names already in the model:</p><div class="chips">${names.map((n) => `<button type="button" data-insert="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}
      <p class="note">Functions: min, max, ceil, floor, sqrt, log, exp. Arithmetic: + − * / and ** for a power.</p>`;
  },
  measured(d) {
    const results = APP.ctx.results;
    const rows = Object.entries(results).map(([k, r]) => {
      const unit = r.units?.value ?? "dimensionless";
      return choice("result", k, k, `${fmt(r.summary.value)} ± ${fmt(r.summary.sd)} ${esc(unit)} · measured on ${esc(r.produced_by?.stack ?? "")} · ${esc(r.target ?? "")} target`, d.result === k && !d.untaken, "measured");
    });
    rows.push(choice("result", "", "Not taken yet", "A measurement nobody has taken. Name the result that will hold it: the node, and everything downstream, shows as not yet measured until it exists.", Boolean(d.untaken), "unknown"));
    return `${question("measured")}<div class="choices">${rows.join("")}</div>
      ${d.untaken ? `<div style="margin-top:12px">${field("w-result", "Name of the result that will hold it", d.result ?? "", { mono: true, placeholder: "spans-per-request", hint: "Lower case, with hyphens, as the book names its results." })}</div>` : ""}`;
  },
  ceiling(d) {
    return `${question("ceiling")}
      ${field("w-of", "What is checked", d.of ?? "", { mono: true, placeholder: "busy_cores / cores", hint: "A name or a formula over names that exist. The ceiling's unit is what this gives." })}
      <div class="grid2">${field("w-limit", "The limit", d.limit ?? "", { mono: true, placeholder: "1" })}${field("w-headroom", "The margin kept free", d.headroom ?? "", { mono: true, placeholder: "queueing_margin", hint: "A fraction of the limit. Name a node, so the sizing and the check use the same margin." })}</div>
      <div id="w-live" aria-live="polite">${liveCeiling(d)}</div>
      ${field("w-because", "Why this is a limit", d.because ?? "", { area: true, placeholder: "What happens past it, and who pays." })}`;
  },
  review(d) {
    const node = nodeForFile(d);
    const text = writeModel({ model: "x", title: "x", currency: "USD", nodes: [node], outputs: [], correlations: [] });
    const block = text.split("\nnodes:\n\n")[1].split("\n\noutputs:")[0];
    const conditional = ["measured", "ceiling"].includes(d.kind) || APP.state.doc.nodes.some((n) => ["measured", "ceiling"].includes(n.kind));
    return `${question("review", ` With it, the model is <strong>${conditional ? "conditional" : "definitional"}</strong>.`)}<pre class="yaml">${esc(block)}</pre>`;
  },
  hosts(d) {
    const chains = d.hosts === "one" || d.hosts === "generations";
    return `${question("hosts")}
      <div class="choices">${choice("hosts", "one", "One kind of host, doing several jobs", "Each resource (processor, memory, storage) is a chain that ends in a count of hosts, and the fleet is the largest of them.", d.hosts === "one", "derived")}
      ${choice("hosts", "roles", "Several roles", "Separate pools of machines, each sized by its own chains. The fleet is the sum of the pools.", d.hosts === "roles", "derived")}
      ${choice("hosts", "generations", "Several generations in one role", "Hosts you already own stay in service beside the ones you buy. The answer is how many new hosts to buy: for each resource, what the load needs less what the old hosts give, and the largest of those.", d.hosts === "generations", "derived")}</div>
      ${chains ? `<fieldset style="margin-top:12px"><legend>Which resources could bind?</legend>${[["requests", "Processor time for the requests"], ["memory", "Memory for what must stay in it"], ["storage", "Disk for what is stored"]].map(([k, t]) => `<label class="row"><input type="checkbox" data-chain="${k}" ${d.chains?.includes(k) ? "checked" : ""} style="width:auto"> ${t}</label>`).join("")}</fieldset>` : ""}
      ${d.hosts === "generations" && d.chains?.includes("requests") ? `<p class="q" style="margin-top:16px">${esc(QUESTIONS.routing.q)}</p><p class="why">${esc(QUESTIONS.routing.why)} ${chapters(QUESTIONS.routing.chapters)}</p>
        <div class="choices">${choice("routing", "capacity", "By capacity", "Each host gets requests in proportion to its cores. The generations' capacity adds.", d.routing === "capacity")}
        ${choice("routing", "equal", "The same share to every host", "Every host gets as many requests as any other, so the smallest host sets the pace for the pool.", d.routing === "equal")}</div>` : ""}
      ${d.hosts === "roles" ? field("w-roles", "The roles, separated by commas", d.roles ?? "", { placeholder: "collectors, store, query", hint: "Each becomes a pool to define, in hosts." }) : ""}`;
  },
};

function guessKind(unit) {
  if (!unit) return null;
  const u = unitWords(APP.ctx.registry, unit);
  return u.ok ? u.kind : null;
}

function liveFormula(d) {
  if (!(d.formula ?? "").trim()) return "";
  const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, d.formula, d.unit, W.original ?? d.name);
  if (r.error) return `<div class="verdict bad">${esc(r.error)}</div>`;
  const fresh = r.newNames.filter((n) => !exists(APP.state, n));
  const pending = r.newNames.filter((n) => pendingNamed(APP.state, n));
  let out = "";
  if (r.complete && r.matches === false) {
    out += `<div class="verdict bad">It gives <code>${esc(r.producedText)}</code>: ${esc(unitWords(APP.ctx.registry, r.producedText).words)} The node is in <code>${esc(d.unit)}</code>, so the formula is wrong, not imprecise.</div>`;
  } else if (r.complete) {
    out += `<div class="verdict ok">It gives <code>${esc(r.producedText)}</code>, the node's kind of quantity.${fresh.length ? " The new names are checked again as you define them." : ""}</div>`;
  } else {
    out += `<div class="verdict ok">The units work so far. The rest is checked as you define the new names.</div>`;
  }
  if (fresh.length || pending.length) {
    const say = (n) => `<code>${esc(n)}</code>${r.inferred.get(n) ? ` in <code>${esc(r.inferred.get(n).text)}</code>` : pendingNamed(APP.state, n)?.unit ? ` in <code>${esc(pendingNamed(APP.state, n).unit)}</code>` : ""}`;
    if (fresh.length) out += `<div class="verdict warn">This adds ${fresh.length === 1 ? "a name" : `${fresh.length} names`} to define next: ${fresh.map(say).join(", ")}.</div>`;
    if (pending.length) out += `<p class="note">Still to define, already on the list: ${pending.map(say).join(", ")}.</p>`;
  }
  return out;
}

function ceilingUnit(d) {
  if (!(d.of ?? "").trim()) return { error: "" };
  const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, d.of, null, W.original ?? d.name);
  if (r.error) return { error: r.error };
  if (!r.complete) return { error: `What is checked must use names that exist; ${r.newNames.filter((n) => !nodeNamed(APP.state, n)).join(", ")} ${r.newNames.length === 1 ? "does" : "do"} not yet.` };
  const single = /^[a-z_][a-z0-9_]*$/.test(d.of.trim()) ? nodeNamed(APP.state, d.of.trim()) : null;
  return { unit: single ? single.unit : r.producedText };
}

function liveCeiling(d) {
  const u = ceilingUnit(d);
  if (u.error) return u.error ? `<div class="verdict bad">${esc(u.error)}</div>` : "";
  let out = `<div class="verdict ok">It checks a quantity in <code>${esc(u.unit)}</code>, so the limit must be in that kind of unit, and the margin a pure number.</div>`;
  for (const [label, text, target] of [["The limit", d.limit, u.unit], ["The margin", d.headroom, "dimensionless"]]) {
    if (!(text ?? "").trim()) continue;
    const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, text, target, W.original ?? d.name);
    if (r.error) out += `<div class="verdict bad">${label}: ${esc(r.error)}</div>`;
    else if (r.complete && r.matches === false) out += `<div class="verdict bad">${label} gives <code>${esc(r.producedText)}</code>, not <code>${esc(target)}</code>.</div>`;
    else if (r.newNames.some((n) => !exists(APP.state, n))) out += `<div class="verdict warn">${label} adds ${r.newNames.filter((n) => !exists(APP.state, n)).map((n) => `<code>${esc(n)}</code>`).join(", ")} to define next.</div>`;
  }
  return out;
}

// -- checks before moving on ------------------------------------------------------------------------

function nameTaken(d) {
  const original = W.original;
  if (d.name === original) return false;
  return exists(APP.state, d.name);
}

const CHECKS = {
  answer(d) {
    const mine = W.type === "answer" ? APP.state.answer : null;
    return nameProblem(d.name) || (exists(APP.state, d.name) && d.name !== mine ? `There is already something called ${d.name}. To make it an answer, tick "an answer" on it.` : "") ||
      (!(d.label ?? "").trim() ? "Give it a label: the words a table will show." : "") || unitProblem(d.unit);
  },
  decision(d) {
    return (d.decision ?? "").trim() ? "" : "Say what decision the answer feeds. It is how you will know the answer is precise enough.";
  },
  horizon(d) {
    if (d.today === undefined) return "Choose one.";
    if (d.today) return "";
    const dims = unitWords(APP.ctx.registry, d.unit);
    return nameProblem(d.name) || (nameTaken(d) ? `There is already something called ${d.name}.` : "") || unitProblem(d.unit) || (dims.kind !== "duration" ? "A horizon is a length of time." : "");
  },
  hosts(d) {
    if (!d.hosts) return "Choose one.";
    if ((d.hosts === "one" || d.hosts === "generations") && !(d.chains ?? []).length) return "Tick at least one resource.";
    if (d.hosts === "generations" && d.chains.includes("requests") && !d.routing) return "Say how requests are spread across old and new hosts.";
    if (d.hosts === "roles") {
      const roles = splitRoles(d.roles);
      if (roles.length < 2) return "Name at least two roles.";
      const bad = roles.find((r) => nameProblem(`${r}_hosts`));
      if (bad) return `${bad}: a role's name becomes part of a node name, so letters, digits and spaces only.`;
    }
    return "";
  },
  kind(d) {
    return d.kind ? "" : "Say whether it is given, worked out or measured.";
  },
  name(d) {
    return nameProblem(d.name) || (nameTaken(d) ? `There is already something called ${d.name}.` : "");
  },
  unit(d) {
    const problem = unitProblem(d.unit);
    if (problem) return problem;
    if (d.fixedUnit) {
      const reg = APP.ctx.registry;
      const a = reg.describe(reg.parse(d.unit)).dimensionality;
      const b = reg.describe(reg.parse(d.fixedUnit)).dimensionality;
      if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) {
        return `The formula that uses it needs ${d.fixedUnit} (${unitWords(reg, d.fixedUnit).words.replace(/\.$/, "")}). ${d.unit} is a different kind of quantity.`;
      }
    }
    return "";
  },
  decided(d) {
    return d.decided ? "" : "Say who decides it. The book's build refuses an input that does not.";
  },
  source(d) {
    const p = d.provenance ?? {};
    if (!p.kind) return "Say what kind of claim this is.";
    if (!(p.source ?? "").trim()) return "Write the source. An input with no source does not build.";
    if (p.kind === "fact" && !CITATION_MARKERS.some((m) => p.source.includes(m))) {
      return "A fact has to cite something the book can recognise: a link (http…), a file (.json or .yaml), an invoice, a result under bench/results/, or the word definition.";
    }
    return "";
  },
  sure(d) {
    if (!d.sure) return "Choose how sure you are.";
    if (d.sure === "one" && typeof d.value !== "number") return "Give the number, or choose not known yet.";
    if (d.sure === "shape") {
      const shape = d.distribution?.shape;
      if (!shape) return "Pick a shape.";
      const p = d.distribution.parameters;
      if (SHAPES[shape].fields.some((f) => typeof p[f] !== "number")) return "Fill in every number the shape needs.";
      try {
        checkShape(shape, p);
      } catch {
        return { triangular: "The least, the likely and the most must be in that order.", lognormal: "The low figure must be above zero and below the high one.", normal: "The standard error cannot be negative." }[shape] ?? "Those numbers do not make a shape.";
      }
      if (!(d.provenance?.source ?? "").toLowerCase().includes(shape)) return `Name the shape in the source and say why it is ${shape}: the book's build checks for the word. Go back to the source to add it.`;
    }
    if (d.range && (typeof d.range[0] !== "number" || typeof d.range[1] !== "number" || d.range[0] >= d.range[1])) {
      return "The slider needs a low end below its high end, or neither.";
    }
    return "";
  },
  formula(d) {
    if (!(d.formula ?? "").trim()) return "Write the formula, or pick a pattern.";
    const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, d.formula, d.unit, W.original ?? d.name);
    if (r.error) return r.error;
    if (r.complete && r.matches === false) return `It gives ${r.producedText}, and the node is in ${d.unit}.`;
    const self = W.original ?? d.name;
    const nodes = graph(APP.state);
    for (const name of nodes.keys()) {
      if (!formulaUses(r.tree, name)) continue;
      if (name === self || upstream(nodes, name).has(self)) return `${name} is worked out from ${self}, so ${self} cannot be worked out from it.`;
    }
    return "";
  },
  measured(d) {
    if (d.untaken) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(d.result ?? "")) return "Name the result: lower case, digits and hyphens.";
      if (APP.ctx.results[d.result]) return "The book has a result by that name. Pick it from the list instead.";
      return "";
    }
    if (!d.result) return "Pick the measurement, or say it is not taken yet.";
    if (d.fixedUnit) {
      const reg = APP.ctx.registry;
      const want = reg.describe(reg.parse(d.fixedUnit)).dimensionality;
      const got = reg.describe(reg.parse(d.unit)).dimensionality;
      if (JSON.stringify(Object.entries(want).sort()) !== JSON.stringify(Object.entries(got).sort())) {
        return `The formula that uses it needs ${d.fixedUnit}; this measurement is in ${d.unit}.`;
      }
    }
    return "";
  },
  ceiling(d) {
    const u = ceilingUnit(d);
    if (u.error !== undefined) return u.error || "Say what is checked.";
    if (!(d.limit ?? "").trim()) return "Give the limit.";
    if (!(d.headroom ?? "").trim()) return "Give the margin kept free. A limit with no margin is a comparison, not a sizing rule.";
    for (const [text, target] of [[d.limit, u.unit], [d.headroom, "dimensionless"]]) {
      const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, text, target, W.original ?? d.name);
      if (r.error) return r.error;
      if (r.complete && r.matches === false) return `${text} gives ${r.producedText}, not ${target}.`;
    }
    if (!(d.because ?? "").trim()) return "Say why this is a limit. A ceiling with no reason does not build.";
    return "";
  },
  review() {
    return "";
  },
};

function formulaUses(tree, name) {
  if (!tree) return false;
  if (tree.op === "ref") return tree.name === name;
  return (tree.args ?? []).some((a) => formulaUses(a, name));
}

function unitProblem(text) {
  if (!(text ?? "").trim()) return "Every node declares a unit. For a pure number, dimensionless.";
  const u = unitWords(APP.ctx.registry, text);
  return u.ok ? "" : `${text} is ${u.words}`;
}

function splitRoles(text) {
  return (text ?? "").split(",").map((r) => r.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean);
}

// -- finishing -------------------------------------------------------------------------------------

function nodeForFile(d) {
  const common = { name: d.name, kind: d.kind, unit: d.unit, label: (d.label ?? "").trim() || null, note: (d.note ?? "").trim() || null };
  if (d.kind === "input") {
    return {
      ...common,
      decided: d.decided,
      sure: d.sure,
      value: d.sure === "none" ? null : typeof d.value === "number" ? d.value : null,
      distribution: d.sure === "shape" ? d.distribution : null,
      provenance: { kind: d.provenance.kind, source: d.provenance.source.trim() },
      range: d.sure !== "none" && d.range ? d.range : null,
    };
  }
  if (d.kind === "derived") return { ...common, formula: d.formula.trim() };
  if (d.kind === "measured") return { ...common, result: d.result };
  return { ...common, of: d.of.trim(), limit: d.limit.trim(), headroom: d.headroom.trim(), because: d.because.trim() };
}

function addNewNames(text, target, self) {
  const r = readFormula(APP.state, { ...APP.ctx, previewed: APP.previewed }, text, target, self);
  for (const name of r.newNames ?? []) {
    if (exists(APP.state, name)) continue;
    const inferred = r.inferred?.get(name);
    const suggested = suggestedUnit(name);
    addPending(APP.state, name, { unit: inferred ? inferred.text : null, suggested });
  }
}

/* The unit the book's own pattern uses for a name, offered as a suggestion only. */
function suggestedUnit(name) {
  for (const p of APP.ctx.patterns) {
    for (const [k, v] of Object.entries(p.units)) {
      const unit = money(v, APP.state.doc.currency);
      if (k === name && !unit.includes("{")) return unit;
    }
  }
  return null;
}

function finish() {
  const { state } = APP;
  const d = W.draft;
  switch (W.type) {
    case "answer": {
      if (state.answer && state.answer !== d.name) {
        const had = nodeNamed(state, state.answer) || pendingNamed(state, state.answer);
        if (had) had.name = d.name;
        state.doc.outputs = state.doc.outputs.map((o) => (o === state.answer ? d.name : o));
      }
      state.answer = d.name;
      const node = nodeNamed(state, d.name);
      if (node) Object.assign(node, { label: d.label, unit: d.unit });
      else {
        const p = pendingNamed(state, d.name);
        if (p) Object.assign(p, { label: d.label, unit: d.unit });
        else addPending(state, d.name, { unit: d.unit, label: d.label });
      }
      if (!state.doc.outputs.includes(d.name)) state.doc.outputs.unshift(d.name);
      if (state.doc.model === "my_model") state.doc.model = d.name;
      state.doc.title = d.label.charAt(0).toUpperCase() + d.label.slice(1);
      state.doc.currency = d.currency;
      state.decision = d.decision;
      break;
    }
    case "decision":
      state.decision = d.decision;
      break;
    case "output":
      addPending(state, d.name, { unit: d.unit, label: d.label });
      state.doc.outputs.push(d.name);
      APP.ui.selected = d.name;
      break;
    case "horizon":
      if (d.today) state.horizon = "none";
      else {
        putNode(state, nodeForFile(d), d.name);
        state.horizon = d.name;
      }
      break;
    case "hosts":
      finishHosts(d);
      break;
    default: {
      const node = nodeForFile(d);
      putNode(state, node, W.original ?? d.name);
      if (d.kind === "derived") addNewNames(d.formula, d.unit, d.name);
      if (d.kind === "ceiling") {
        const u = ceilingUnit(d).unit;
        node.unit = u;
        addNewNames(d.limit, u, d.name);
        addNewNames(d.headroom, "dimensionless", d.name);
        if (!state.doc.outputs.includes(d.name)) state.doc.outputs.push(d.name);
      }
      APP.ui.selected = node.name;
    }
  }
  closeWizard();
  APP.commit();
}

/*
 * The hosts question's answer, as structure: a formula for the answer and the names it needs.
 * Kinds and units only: the builder presets what a pool is made of, never a number.
 */
function finishHosts(d) {
  const { state } = APP;
  state.hosts = d.hosts;
  state.routing = d.hosts === "generations" && d.chains.includes("requests") ? d.routing : null;
  const answer = state.answer;
  if (d.hosts === "one" || d.hosts === "generations") {
    // models/web_service names its chains hosts_for_*; models/mixed_pool, new_for_*.
    const prefix = d.hosts === "one" ? "hosts_for" : "new_for";
    const chains = { requests: `${prefix}_requests`, memory: `${prefix}_memory`, storage: `${prefix}_storage` };
    const names = d.chains.map((c) => chains[c]);
    const formula = names.length === 1 ? names[0] : `max(${names.join(", ")})`;
    putNode(state, { name: answer, kind: "derived", unit: pendingNamed(state, answer)?.unit ?? "host", label: pendingNamed(state, answer)?.label ?? null, note: null, formula }, answer);
    for (const n of names) addPending(state, n, { unit: "host", label: n.replaceAll("_", " ") });
  } else {
    const pools = splitRoles(d.roles).map((r) => `${r}_hosts`);
    putNode(state, { name: answer, kind: "derived", unit: pendingNamed(state, answer)?.unit ?? "host", label: pendingNamed(state, answer)?.label ?? null, note: null, formula: pools.join(" + ") }, answer);
    for (const n of pools) addPending(state, n, { unit: "host", label: n.replaceAll("_", " ") });
  }
}

// -- drawing and wiring ------------------------------------------------------------------------------

function draw() {
  const steps = stepsOf(W);
  if (W.step >= steps.length) W.step = steps.length - 1;
  const step = steps[W.step];
  $("wsteps").innerHTML = steps.map((s, i) => `<span class="${i === W.step ? "on" : i < W.step ? "done" : ""}">${i + 1} ${STEP_TITLES[s]}</span>`).join("");
  $("wback").disabled = W.step === 0;
  const last = W.step === steps.length - 1;
  $("wnext").textContent = last ? (W.type === "edit" ? "Save the changes" : ["define", "ceiling", "horizon", "output"].includes(W.type) ? "Add to the model" : "Done") : "Next";
  $("wbody").innerHTML = VIEWS[step](W.draft) + `<div id="wmsg" aria-live="assertive"></div>`;
  wire(step);
  const first = $("wbody").querySelector("input, textarea, .choice");
  first?.focus({ preventScroll: true });
}

function redrawLive(step) {
  const live = $("w-live");
  if (!live) return;
  if (step === "formula") live.innerHTML = liveFormula(W.draft);
  if (step === "ceiling") live.innerHTML = liveCeiling(W.draft);
}

function wire(step) {
  const d = W.draft;
  const B = $("wbody");
  const click = (sel, fn) => {
    for (const el of B.querySelectorAll(sel)) el.addEventListener("click", () => { fn(el); draw(); });
  };
  const input = (id, fn, after) => {
    const el = $(id);
    if (el) el.addEventListener("input", () => { fn(el.value); after?.(); });
  };
  const num = (v) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));

  click("[data-kind]", (el) => {
    const keep = { name: d.name, label: d.label, unit: d.unit, fixedUnit: d.fixedUnit, suggested: d.suggested };
    W.draft = { ...keep, kind: el.dataset.kind };
    if (el.dataset.kind === "input" && d.fixedUnit) W.draft.qkind = guessKind(d.fixedUnit);
  });
  click("[data-qkind]", (el) => { d.qkind = el.dataset.qkind; });
  click("[data-unit]", (el) => { d.unit = el.dataset.unit; });
  click("[data-decided]", (el) => { d.decided = el.dataset.decided; });
  click("[data-prov]", (el) => { d.provenance = { ...(d.provenance ?? { source: "" }), kind: el.dataset.prov }; });
  click("[data-sure]", (el) => {
    d.sure = el.dataset.sure;
    if (d.sure !== "shape") d.distribution = null;
    if (d.sure === "none") { d.value = null; d.range = null; }
  });
  click("[data-shape]", (el) => { d.distribution = { shape: el.dataset.shape, parameters: {} }; });
  click("[data-today]", (el) => { d.today = el.dataset.today === "yes"; });
  click("[data-hosts]", (el) => { d.hosts = el.dataset.hosts; });
  click("[data-routing]", (el) => { d.routing = el.dataset.routing; });
  click("[data-result]", (el) => {
    const key = el.dataset.result;
    if (!key) {
      d.untaken = true;
      d.result = "";
      d.unit = d.fixedUnit ?? "";
    } else {
      d.untaken = false;
      d.result = key;
      d.unit = APP.ctx.results[key].units?.value ?? "dimensionless";
    }
  });
  click("[data-formula]", (el) => { d.formula = el.dataset.formula; });
  click("[data-insert]", (el) => { d.formula = `${(d.formula ?? "").trim()} ${el.dataset.insert}`.trim(); });
  for (const el of B.querySelectorAll("[data-chain]")) {
    el.addEventListener("change", () => {
      d.chains = [...B.querySelectorAll("[data-chain]:checked")].map((x) => x.dataset.chain);
      if (d.hosts === "generations") draw(); // the routing question follows the requests chain
    });
  }

  input("w-name", (v) => { d.name = v.trim(); });
  input("w-label", (v) => { d.label = v; });
  input("w-note", (v) => { d.note = v; });
  input("w-decision", (v) => { d.decision = v; });
  input("w-unit", (v) => { d.unit = v.trim(); }, () => { const h = $("w-unit-hint"); if (h) h.innerHTML = unitHint(d.unit); });
  input("w-source", (v) => { d.provenance = { ...(d.provenance ?? {}), source: v }; });
  input("w-value", (v) => { d.value = num(v); });
  input("w-result", (v) => { d.result = v.trim(); });
  input("w-roles", (v) => { d.roles = v; });
  $("w-currency")?.addEventListener("change", (e) => {
    // An answer already in the old currency moves with it; any other unit is the reader's.
    const was = new RegExp(`(?<![A-Za-z_])${d.currency}(?![A-Za-z_])`, "g");
    d.unit = (d.unit ?? "").replace(was, e.target.value);
    d.currency = e.target.value;
    draw();
  });
  const range = () => {
    const a = num($("w-r0")?.value ?? ""), b = num($("w-r1")?.value ?? "");
    d.range = a === null && b === null ? null : [a, b];
  };
  input("w-r0", range);
  input("w-r1", range);
  for (const el of B.querySelectorAll("[id^='w-p-']")) {
    el.addEventListener("input", () => { d.distribution.parameters[el.id.slice(4)] = num(el.value); });
  }
  input("w-formula", (v) => { d.formula = v; }, () => redrawLive(step));
  for (const f of ["of", "limit", "headroom", "because"]) input(`w-${f}`, (v) => { d[f] = v; }, () => redrawLive(step));
}

export function wireWizardButtons() {
  $("wcancel").addEventListener("click", closeWizard);
  $("wizard").addEventListener("keydown", (e) => { if (e.key === "Escape") closeWizard(); });
  $("wback").addEventListener("click", () => { if (W && W.step > 0) { W.step -= 1; draw(); } });
  $("wnext").addEventListener("click", () => {
    if (!W) return;
    const steps = stepsOf(W);
    const step = steps[W.step];
    const problem = CHECKS[step](W.draft);
    if (problem) {
      const m = $("wmsg");
      m.className = "verdict bad";
      m.textContent = problem;
      return;
    }
    const after = stepsOf(W);
    if (W.step >= after.length - 1) finish();
    else {
      W.step += 1;
      draw();
    }
  });
}
