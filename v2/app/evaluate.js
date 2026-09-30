/*
 * Everything the page works out from the state: each option as a model of its own, evaluated
 * by the engine; which inputs an answer rests on; what is still missing; and the files.
 *
 * An option that is not ours is the model document with its overrides written in as values.
 * Evaluating it that way, rather than as a scenario over the base model, lets a figure our
 * solution does not have yet still be worked out for an option that does have it. The files
 * are the other way round: one model file with our values, one scenario per other option.
 */

import { at } from "../../engine/explore.js";
import { parse, refs } from "../../engine/formula.js";
import { writeModel, writeScenario } from "../../engine/write.js";
import { preview } from "../../app/workbench.js";
import { inputsBehind } from "./parts.js";
import { questionById } from "./questions.js";

export const byName = (doc) => new Map(doc.nodes.map((n) => [n.name, n]));
export const isBlank = (n) => n.kind === "input" && typeof n.value !== "number" && !n.distribution;
export const ours = (state) => state.options.find((o) => o.ours) ?? state.options[0];
export const optionById = (state, id) => state.options.find((o) => o.id === id);

/* The part a node belongs to, and the switch that leaves that part out of an option. */
export const partOf = (state, name) => state.map[name]?.part ?? "all";
export const includedSwitch = (state, part) => (state.parts.length === 1 ? "included" : `${part}_included`);
export const coversPart = (state, option, part) => part === "all" || part === "other" || !(option.covers ?? []).length || option.covers.includes(part);

/* The document as this option has it: our values, or the option's own overrides. */
export function docFor(state, option) {
  const doc = structuredClone(state.doc);
  if (!option.ours) {
    for (const n of doc.nodes) {
      if (n.kind !== "input" || n.decided !== "you") continue;
      if (Object.hasOwn(option.overrides, n.name)) {
        n.value = option.overrides[n.name];
        n.distribution = null;
        n.provenance = option.provenance[n.name] ?? { kind: "", source: "" };
      } else if (!option.same.includes(n.name) && !/(^|_)included$/.test(n.name)) {
        n.value = null;
        n.distribution = null;
      }
    }
  }
  for (const part of state.parts) {
    if (!coversPart(state, option, part)) {
      const sw = doc.nodes.find((n) => n.name === includedSwitch(state, part));
      if (sw) sw.value = 0;
    }
  }
  for (const n of doc.nodes) if (n.kind === "input") n.sure = isBlank(n) ? "none" : n.distribution ? "shape" : "value";
  return doc;
}

/* The engine's view of one option: values with states, the model, its unit factors. */
export function evaluateOption(state, option, ctx) {
  const doc = docFor(state, option);
  const previewed = preview({ doc, pending: [] }, ctx);
  return { doc, ...previewed };
}
export const valueOf = (ev, name) => (ev.values.get(name)?.state === "ok" ? ev.values.get(name).value : NaN);
/* The same option with some inputs changed, for what-ifs, flips and sensitivity. */
export function atOption(ev, overrides, wanted) {
  return at(ev.model, ev.factors, new Map(Object.entries(overrides)), wanted);
}

/* The node that answers the question, for one option. */
export function answerNode(state) {
  const q = questionById(state.type);
  if (q.kind === "cost") return "total_cost";
  const infra = state.parts.includes("infra") ? (state.parts.length === 1 ? "" : "infra_") : null;
  if (infra === null) return null;
  return `${infra}${state.metrics?.[q.metric] ?? { sizing: "units", capacity: "raw_capacity", performance: "cores_fill" }[q.metric]}`;
}
export function answerLabel(state) {
  const q = questionById(state.type);
  if (q.kind === "cost") {
    const h = byName(state.doc).get("horizon");
    return typeof h?.value === "number" ? `${h.value}-year TCO` : "TCO over the period";
  }
  return byName(state.doc).get(answerNode(state))?.label ?? "the answer";
}

/* The inputs the answer rests on, for one option: what it must have before it can be worked out. */
export function neededFor(state, option) {
  const name = answerNode(state);
  if (!name) return new Set();
  const doc = docFor(state, option);
  const all = inputsBehind(doc, [name]);
  // An input behind an included switch that is nought is not needed by this option.
  const names = byName(doc);
  for (const n of all) if (n.endsWith("included") || (names.get(n)?.decided === "definition")) all.delete(n);
  return all;
}

/* What is still missing, required (the answer cannot be worked out without it) and optional. */
export function missing(state) {
  const req = [], opt = [];
  const names = byName(state.doc);
  const needed = new Map(state.options.map((o) => [o.id, neededFor(state, o)]));
  const anyNeeds = (name) => [...needed.values()].some((s) => s.has(name));
  for (const n of state.doc.nodes) {
    if (n.kind !== "input" || n.decided === "definition" || /(^|_)included$/.test(n.name)) continue;
    if (n.decided === "outside") {
      if (!isBlank(n)) continue;
      (anyNeeds(n.name) ? req : opt).push({ scope: "shared", name: n.name, node: n });
      continue;
    }
    for (const o of state.options) {
      if (!coversPart(state, o, partOf(state, n.name))) continue;
      const has = o.ours ? !isBlank(n) : Object.hasOwn(o.overrides, n.name) || (o.same.includes(n.name) && !isBlank(names.get(n.name)));
      if (has) continue;
      (needed.get(o.id).has(n.name) ? req : opt).push({ scope: o.id, option: o, name: n.name, node: n });
    }
  }
  return { req, opt };
}

/* Why the answer cannot be shown yet, or an empty string. */
export function blocker(state) {
  if (!state.doc) return "Choose a question and describe the customer first.";
  if (!answerNode(state)) return "This question needs infrastructure among the requirements.";
  if (!state.options.length) return "Add an option to compare.";
  const r = missing(state).req.length;
  if (r) return `${r} needed ${r === 1 ? "value" : "values"} still missing`;
  return "";
}

/* The files: one model with our values, one scenario per other option. */
export function files(state) {
  const doc = docFor(state, ours(state));
  for (const n of doc.nodes) delete n.sure;
  const out = { "model.yaml": writeModel(doc) };
  out["scenarios/reference.yaml"] = writeScenario({ scenario: "reference", title: ours(state).name, because: "Our solution: the model as declared.", samples: 10000, seed: 1, overrides: {} });
  for (const o of state.options) {
    if (o.ours) continue;
    const overrides = { ...o.overrides };
    for (const part of state.parts) if (!coversPart(state, o, part)) overrides[includedSwitch(state, part)] = 0;
    const said = Object.entries(o.provenance).map(([k, p]) => `${k}: ${p.source}`).join("; ");
    out[`scenarios/${o.id}.yaml`] = writeScenario({ scenario: o.id, title: o.name, because: said || `${o.name}, as entered.`, samples: 10000, seed: 1, overrides });
  }
  return out;
}

/* The nodes a formula refers to, or none for a formula that does not parse. */
export function refsOf(text) {
  try { return [...refs(parse(String(text)))]; } catch { return []; }
}
