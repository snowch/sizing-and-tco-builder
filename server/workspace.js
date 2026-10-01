/*
 * The builder's engine with no page: the same context the v2 page builds, the same state shape
 * it keeps, held in a folder of solutions on disk so that an assistant (over MCP) and the page
 * (over HTTP) work on one record.
 *
 * Nothing here fills a number in. An assistant can only *suggest* one, with where it came from
 * and the evidence, and a suggestion sits apart from the model until an engineer confirms it in
 * the page or on the assistant's behalf through the same tool. Evaluating "provisionally" applies
 * the suggestions to a copy and says so in the result.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { registryFor } from "../engine/index.js";
import { loadPart } from "../v2/app/parts.js";
import { emptyState, newOption } from "../v2/app/state.js";
import { ORIGINS, provenanceFor, questionById } from "../v2/app/questions.js";
import { begin, rebuildDoc } from "../v2/app/journey.js";
import { byName, evaluateOption, isBlank, optionById, ours } from "../v2/app/evaluate.js";

export const ROOT = new URL("..", import.meta.url).pathname;
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/* The data and the part templates, as the page loads them. */
export function loadContext(root = ROOT) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const units = JSON.parse(read("data/units.json"));
  const results = JSON.parse(read("data/results.json"));
  const index = JSON.parse(read("v2/templates/index.json"));
  const registry = registryFor(units);
  const parts = index.parts.map((meta) => loadPart(meta, read(`v2/templates/${meta.file}`), { registry }));
  return { registry, results, units, index, parts, currency: parts[0]?.doc.currency ?? "GBP" };
}

/* What the page calls `app`, without the page: enough for the journey's pure functions. */
export function headlessApp(ctx, state) {
  const app = { ctx, state, cache: new Map() };
  app.save = () => {};
  app.redrawBuild = () => {};
  app.invalidate = () => app.cache.clear();
  app.evaluate = (option) => {
    if (!app.cache.has(option.id)) app.cache.set(option.id, evaluateOption(app.state, option, { registry: ctx.registry, results: ctx.results }));
    return app.cache.get(option.id);
  };
  return app;
}

export class Refused extends Error {}

/* The scope a tool names, resolved: "shared" for a customer figure, else an option. */
export function resolveScope(state, scope) {
  const s = String(scope ?? "").trim();
  if (!s || /^(shared|customer|customer requirements)$/i.test(s)) return { scope: "shared", option: null };
  const o = state.options.find((x) => x.id === s) ?? state.options.find((x) => x.name.toLowerCase() === s.toLowerCase()) ?? state.options.find((x) => x.role === s.toLowerCase());
  if (!o) throw new Refused(`no option called "${s}"; the options are ${state.options.map((x) => `${x.id} (${x.name})`).join(", ")}`);
  return { scope: o.id, option: o };
}

/* The input a tool names, by name or label, in the merged document. */
export function resolveInput(state, input) {
  const s = String(input ?? "").trim();
  const names = byName(state.doc);
  const nd = names.get(s) ?? state.doc.nodes.find((n) => (n.label ?? "").toLowerCase() === s.toLowerCase());
  if (!nd) throw new Refused(`no input called "${s}"`);
  if (nd.kind !== "input") throw new Refused(`"${s}" is calculated, not entered`);
  if (nd.decided === "definition") throw new Refused(`"${s}" is a definition, not a figure anyone supplies`);
  if (/(^|_)included$/.test(nd.name)) throw new Refused(`"${s}" is set by which parts an option covers; use set_option`);
  return nd;
}

/* A customer figure belongs to the customer; an option's figure to that option. */
export function checkScope(state, nd, scope) {
  if (nd.decided === "outside" && scope !== "shared") throw new Refused(`"${nd.name}" is a customer requirement, the same for every option: give it the scope "shared"`);
  if (nd.decided === "you" && scope === "shared") throw new Refused(`"${nd.name}" is an option's own figure: name the option`);
}

/* Write a confirmed value where the page would: into the model for the customer or our solution, into the option's overrides otherwise. */
export function setValue(state, scope, name, value, provenance) {
  const nd = byName(state.doc).get(name);
  if (scope === "shared" || optionById(state, scope)?.ours) {
    nd.value = value; nd.distribution = null; nd.provenance = provenance;
  } else {
    const o = optionById(state, scope);
    o.overrides[name] = value;
    o.provenance[name] = provenance;
    o.same = o.same.filter((x) => x !== name);
  }
}

/* The value an option has for an input, confirmed only; null for a blank. */
export function valueFor(state, scope, name) {
  const nd = byName(state.doc).get(name);
  if (scope === "shared") return isBlank(nd) ? null : nd.value;
  const o = optionById(state, scope);
  if (o.ours) return isBlank(nd) ? null : nd.value;
  if (Object.hasOwn(o.overrides, name)) return o.overrides[name];
  if (o.same.includes(name)) return isBlank(nd) ? null : nd.value;
  return null;
}
export function provenanceOf(state, scope, name) {
  const nd = byName(state.doc).get(name);
  if (scope === "shared") return nd.provenance;
  const o = optionById(state, scope);
  if (o.ours) return nd.provenance;
  if (Object.hasOwn(o.overrides, name)) return o.provenance[name] ?? { kind: "", source: "" };
  if (o.same.includes(name)) return nd.provenance;
  return { kind: "", source: "" };
}

/* A suggestion is refused without an origin the page knows and evidence somebody could check. */
export function checkSuggestion(s) {
  const origin = String(s.origin ?? "").trim().toLowerCase();
  if (!ORIGINS[origin]) throw new Refused(`origin must be one of ${Object.keys(ORIGINS).join(", ")}; "${s.origin ?? ""}" is not`);
  const evidence = String(s.evidence ?? "").trim();
  if (evidence.length < 8) throw new Refused("evidence is required: quote the sentence, the cell, the page or the document the figure came from");
  const value = typeof s.value === "string" ? Number(s.value.replace(/[,\s]/g, "")) : s.value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Refused(`value must be a number in the input's unit; got ${JSON.stringify(s.value)}`);
  return { origin, evidence, value };
}

/* A copy of the state with every suggestion written in as if confirmed, for a provisional answer. */
export function withSuggestions(state) {
  const copy = structuredClone(state);
  const used = [];
  for (const [key, s] of Object.entries(copy.suggestions ?? {})) {
    const [scope, name] = key.split("|");
    if (!byName(copy.doc).has(name) || (scope !== "shared" && !optionById(copy, scope))) continue;
    setValue(copy, scope, name, s.value, provenanceFor(s.origin, `${s.evidence} (suggested, unconfirmed)`));
    used.push({ scope, input: name, value: s.value, origin: s.origin });
  }
  return { state: copy, used };
}

/* A new solution's state, from the question. */
export function newSolution(ctx, { question = "competitive", title = "", notes = "" } = {}) {
  const q = questionById(question);
  if (q.id !== String(question)) throw new Refused(`no question called "${question}"; one of competitive, tco, sizing, capacity, performance, business, comparison, custom`);
  const state = emptyState();
  state.type = q.id;
  state.sentence = title || q.sentence;
  state.sentenceEdited = Boolean(title);
  state.notes = notes;
  state.mode = "build";
  const app = headlessApp(ctx, state);
  begin(app, { find: false });
  state.suggestions = {};
  state.open = ["requirements"];
  return state;
}

/* Choose the parts a solution is made of, keeping every value already entered. */
export function setParts(ctx, state, parts) {
  const known = ctx.parts.map((p) => p.id);
  const chosen = [...new Set(parts.map((p) => String(p).trim().toLowerCase()))];
  for (const p of chosen) if (!known.includes(p)) throw new Refused(`no part called "${p}"; the parts are ${known.join(", ")}`);
  if (!chosen.length) throw new Refused("a solution needs at least one part");
  state.parts = chosen;
  rebuildDoc(headlessApp(ctx, state));
  for (const o of state.options) if (o.covers) o.covers = o.covers.filter((p) => chosen.includes(p));
  // A suggestion for an input that is no longer in the model is dropped.
  const names = byName(state.doc);
  for (const key of Object.keys(state.suggestions ?? {})) if (!names.has(key.split("|")[1])) delete state.suggestions[key];
}

export function addOption(state, role, name) {
  const roles = ["current", "ours", "rival", "alt", "custom"];
  const r = String(role ?? "custom").toLowerCase();
  if (!roles.includes(r)) throw new Refused(`role must be one of ${roles.join(", ")}`);
  if (r === "ours" && state.options.some((o) => o.ours)) throw new Refused("there is already an option that is ours");
  const k = Math.max(0, ...state.options.map((o) => Number(o.id.slice(1)) + 1));
  const o = newOption(r, k, r === "ours");
  if (name) o.name = String(name).trim();
  state.options.push(o);
  return o;
}

/*
 * The solutions on disk: one folder each, holding state.json (the page's state, with the
 * suggestions) and, once written, the model and scenario files. A version number guards the
 * page and the assistant against writing over each other.
 */
export class Workspace {
  constructor(dir, ctx) {
    this.dir = dir;
    this.ctx = ctx;
    mkdirSync(dir, { recursive: true });
  }
  path(name) {
    if (!NAME.test(name)) throw new Refused(`a solution's name is lower-case letters, digits and hyphens: "${name}" is not`);
    return join(this.dir, name);
  }
  list() {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME.test(d.name) && existsSync(join(this.dir, d.name, "state.json")))
      .map((d) => { const r = this.read(d.name); return { name: d.name, title: r.state.sentence, question: r.state.type, version: r.version, updated: r.updated }; });
  }
  exists(name) { return existsSync(join(this.path(name), "state.json")); }
  read(name) {
    const file = join(this.path(name), "state.json");
    if (!existsSync(file)) throw new Refused(`no solution called "${name}"`);
    const r = JSON.parse(readFileSync(file, "utf8"));
    r.state = { ...emptyState(), suggestions: {}, ...r.state };
    return r;
  }
  write(name, state, { version = null } = {}) {
    const dir = this.path(name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");
    let was = 0;
    if (existsSync(file)) was = JSON.parse(readFileSync(file, "utf8")).version ?? 0;
    if (version !== null && version !== was) throw new Refused(`the solution changed meanwhile (version ${was}, not ${version}): read it again`);
    const record = { version: was + 1, updated: new Date().toISOString(), state };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, file);
    return record;
  }
  create(name, options) {
    if (this.exists(name)) throw new Refused(`there is already a solution called "${name}"`);
    return this.write(name, newSolution(this.ctx, options));
  }
  /* Read, change, write back: the change runs over a headless app on the solution's state. */
  update(name, change) {
    const r = this.read(name);
    const app = headlessApp(this.ctx, r.state);
    const out = change(app, r.state);
    const written = this.write(name, r.state, { version: r.version });
    return { result: out, version: written.version, state: r.state };
  }
  writeFiles(name, files) {
    const dir = this.path(name);
    for (const [path, text] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
    }
    return Object.keys(files).map((p) => join(dir, p));
  }
}

export { ours };
