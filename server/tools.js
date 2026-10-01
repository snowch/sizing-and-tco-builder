/*
 * The tools an assistant gets over MCP. Each reads a solution, does one thing, and returns plain
 * data. The rules the page keeps, the tools keep:
 *
 *   - no tool writes a figure into the model: suggest_inputs records a suggestion with its origin
 *     and evidence, and refuses one without them; the engineer confirms it (confirm_suggestions
 *     is the engineer acting through the assistant, and says so in the provenance);
 *   - every option is costed for the same customer requirements;
 *   - a what-if leaves the original unchanged;
 *   - the files are the model, and the book's own checks pass judgement on them.
 */

import { judge } from "../app/judge.js";
import { ORIGINS, QUESTIONS, ROLE_NAMES, evidenceOf, originOf, provenanceFor, questionById } from "../v2/app/questions.js";
import { answerLabel, answerNode, atOption, blocker, byName, coversPart, files, missing, neededFor, optionById, ours, partOf, refsOf, valueOf } from "../v2/app/evaluate.js";
import { categories, catTotal } from "../v2/app/results.js";
import { questionText, questions } from "../v2/app/interview.js";
import { Refused, addOption, checkScope, checkSuggestion, headlessApp, provenanceOf, resolveInput, resolveScope, setParts, setValue, valueFor, withSuggestions } from "./workspace.js";

const label = (nd) => nd.label ?? nd.name.replaceAll("_", " ");
const str = (v, what) => { const s = String(v ?? "").trim(); if (!s) throw new Refused(`${what} is required`); return s; };
const FUNC_WORDS = { ceil: "round up", floor: "round down", max: "largest of", min: "smallest of", sqrt: "square root of", exp: "e to the", log: "log of" };

/* An input as a tool reports it, for one scope. */
function inputReport(state, scope, nd) {
  const value = valueFor(state, scope, nd.name);
  const prov = provenanceOf(state, scope, nd.name);
  const key = `${scope}|${nd.name}`;
  const s = state.suggestions?.[key];
  const o = scope === "shared" ? null : optionById(state, scope);
  return {
    scope, input: nd.name, label: label(nd), unit: nd.unit, note: nd.note ?? undefined,
    value, origin: value === null ? null : originOf(prov) || null, evidence: value === null ? null : evidenceOf(prov) || prov.source || null,
    same_as_ours: o && !o.ours && o.same.includes(nd.name) ? true : undefined,
    suggestion: s ? { value: s.value, origin: s.origin, evidence: s.evidence, by: s.by, at: s.at } : undefined,
  };
}

function solutionSummary(ws, name, state) {
  const q = questionById(state.type);
  const m = missing(state);
  return {
    name, title: state.sentence, question: { id: q.id, label: q.label, kind: q.kind },
    parts: state.parts.map((p) => { const part = ws.ctx.parts.find((x) => x.id === p); return { id: p, domain: part?.domain, title: part?.title }; }),
    parts_available: ws.ctx.parts.map((p) => ({ id: p.id, domain: p.domain, title: p.title, text: p.text })),
    options: state.options.map((o) => ({ id: o.id, name: o.name, role: o.role, ours: o.ours, covers: o.covers ?? "every part", same_as_ours: o.ours ? undefined : o.same })),
    answer: { node: answerNode(state), label: answerLabel(state) },
    blocker: blocker(state) || null,
    missing: { required: m.req.length, optional: m.opt.length },
    suggestions_unconfirmed: Object.keys(state.suggestions ?? {}).length,
    requirement_notes: state.written,
    notes: state.notes || undefined,
  };
}

/* A number's story, as plain data: the formula in words and with this option's numbers in it. */
function explainNode(app, o, ev, name, depth, seen = new Set()) {
  const { state } = app;
  const nd = byName(state.doc).get(name);
  if (!nd) return null;
  const cur = state.doc.currency;
  if (nd.kind === "input") {
    const scope = nd.decided === "outside" ? "shared" : o.id;
    const r = inputReport(state, scope, nd);
    return { input: nd.name, label: label(nd), value: nd.decided === "definition" ? nd.value : r.value, unit: nd.unit, origin: nd.decided === "definition" ? "definition" : r.origin, evidence: nd.decided === "definition" ? nd.provenance?.source : r.evidence, whose: nd.decided === "outside" ? "customer" : nd.decided === "definition" ? "definition" : o.name };
  }
  const text = nd.kind === "derived" ? nd.formula : String(nd.of);
  const names = byName(state.doc);
  const words = text.replace(/[A-Za-z_]\w*/g, (t) => FUNC_WORDS[t] ?? (names.get(t) ? label(names.get(t)) : t));
  const numbers = text.replace(/[A-Za-z_]\w*/g, (t) => FUNC_WORDS[t] ?? (names.get(t) ? (names.get(t).kind === "input" ? String(explainNode(app, o, ev, t, 0).value) : String(valueOf(ev, t))) : t));
  const out = { node: nd.name, label: label(nd), kind: nd.kind, value: valueOf(ev, name), unit: nd.unit, formula: text, in_words: words, with_numbers: numbers, currency: cur };
  if (nd.kind === "ceiling") out.limit = String(nd.limit), out.headroom = nd.headroom, out.because = nd.because;
  if (/(^|_)total_cost$/.test(name) && !coversPart(state, o, partOf(state, name))) out.not_in_this_option = true;
  if (depth > 0 && !seen.has(name)) {
    seen.add(name);
    out.made_of = refsOf(text).map((r) => explainNode(app, o, ev, r, depth - 1, seen)).filter(Boolean);
  }
  return out;
}

const SCOPE_WORDS = 'The scope is "shared" for a customer requirement (the same for every option), or an option\'s id or name for a figure that option supplies.';

export const TOOLS = [
  {
    name: "list_questions",
    description: "The questions the builder can answer, the roles each starts with, and the parts (areas of a solution) a solution can be made of.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (ws) => ({
      questions: QUESTIONS.map((q) => ({ id: q.id, label: q.label, kind: q.kind, note: q.note, roles: q.roles.map((r) => ({ role: r, name: ROLE_NAMES[r] })) })),
      parts: ws.ctx.parts.map((p) => ({ id: p.id, domain: p.domain, title: p.title, text: p.text })),
      origins: Object.fromEntries(Object.entries(ORIGINS).map(([k, v]) => [k, `${v.label}: ${v.note}`])),
    }),
  },
  {
    name: "start_solution",
    description: "Start a new solution: the question, a title, and the customer notes as you were given them. Returns what the model needs. No figure is read from the notes here: read them yourself and call suggest_inputs with each figure, its origin and the sentence it came from.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Lower-case letters, digits and hyphens: the folder the solution lives in." },
      question: { type: "string", description: "One of competitive, tco, sizing, capacity, performance, business, comparison, custom (see list_questions)." },
      title: { type: "string", description: "The question in the engineer's words, optional." },
      notes: { type: "string", description: "What is known about the customer, as given, optional." },
      parts: { type: "array", items: { type: "string" }, description: "The parts the solution is made of (infra, software, services). The question's default is used if left out." },
    }, required: ["name", "question"], additionalProperties: false },
    run: (ws, a) => {
      const name = str(a.name, "name");
      const r = ws.create(name, { question: str(a.question, "question"), title: a.title ?? "", notes: a.notes ?? "" });
      if (a.parts?.length) ws.update(name, (app, state) => setParts(ws.ctx, state, a.parts));
      const { state, version } = ws.read(name);
      const s = solutionSummary(ws, name, state);
      return { ...s, version, next: "Call missing_inputs to see what the answer needs, then suggest_inputs for each figure you can find, with its origin and evidence." };
    },
  },
  {
    name: "list_solutions",
    description: "The solutions in the workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (ws) => ({ solutions: ws.list() }),
  },
  {
    name: "describe_solution",
    description: "A solution as it stands: question, parts, options, what blocks the answer, how many figures are missing or suggested but unconfirmed.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => { const { state, version } = ws.read(str(a.name, "name")); return { ...solutionSummary(ws, a.name, state), version }; },
  },
  {
    name: "set_parts",
    description: "Choose the parts a solution is made of: infra (servers, storage or cloud), software (business software), services (run it or buy it as a service). Values already entered are kept.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, parts: { type: "array", items: { type: "string" } } }, required: ["name", "parts"], additionalProperties: false },
    run: (ws, a) => { const { state, version } = ws.update(str(a.name, "name"), (app, st) => setParts(ws.ctx, st, a.parts ?? [])); return { parts: state.parts, inputs: state.doc.nodes.filter((n) => n.kind === "input" && n.decided !== "definition").length, version }; },
  },
  {
    name: "describe_inputs",
    description: "Every input the model has, per scope: the customer's requirements (shared by every option) and each option's own figures, with unit, value so far, origin, evidence, and any unconfirmed suggestion. Use it to learn the exact input names before suggesting.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, scope: { type: "string", description: `Optional: only this scope. ${SCOPE_WORDS}` } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => {
      const { state, version } = ws.read(str(a.name, "name"));
      const only = a.scope ? resolveScope(state, a.scope).scope : null;
      const needed = new Map(state.options.map((o) => [o.id, neededFor(state, o)]));
      const scopes = [];
      if (!only || only === "shared") scopes.push({ scope: "shared", who: "Customer requirements", inputs: state.doc.nodes.filter((n) => n.kind === "input" && n.decided === "outside").map((n) => ({ ...inputReport(state, "shared", n), needed: [...needed.values()].some((s) => s.has(n.name)) })) });
      for (const o of state.options) {
        if (only && only !== o.id) continue;
        scopes.push({ scope: o.id, who: o.name, role: o.role, ours: o.ours, inputs: state.doc.nodes.filter((n) => n.kind === "input" && n.decided === "you" && !/(^|_)included$/.test(n.name) && coversPart(state, o, partOf(state, n.name))).map((n) => ({ ...inputReport(state, o.id, n), needed: needed.get(o.id).has(n.name) })) });
      }
      return { name: a.name, currency: state.doc.currency, scopes, version };
    },
  },
  {
    name: "missing_inputs",
    description: "What the answer still needs: required figures first (the answer cannot be worked out without them), then optional ones, each with the question the page would ask, its unit and scope. A figure with an unconfirmed suggestion still counts as missing.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => {
      const { state, version } = ws.read(str(a.name, "name"));
      const app = headlessApp(ws.ctx, state);
      const list = questions(app).map((q) => { const t = questionText(app, q); const s = state.suggestions?.[q.key]; return { scope: q.scope, option: q.option?.name, input: q.node.name, label: label(q.node), unit: q.node.unit, required: q.required, ask: t.ask, why: t.why, note: q.node.note ?? undefined, suggested: s ? { value: s.value, origin: s.origin } : undefined }; });
      return { name: a.name, blocker: blocker(state) || null, required: list.filter((x) => x.required), optional: list.filter((x) => !x.required), version };
    },
  },
  {
    name: "suggest_inputs",
    description: `Suggest figures for inputs, each with its origin and evidence. A suggestion does not enter the model: the page shows it as "suggested, unconfirmed" until the engineer confirms it. A suggestion with no origin, no evidence, or a value that is not a number in the input's unit is refused. Origins: customer (what the customer said or wrote), quote (a supplier's quote), published (a price list or spec sheet), assumption (yours: say why), fact (a document, email, invoice or URL you can cite). ${SCOPE_WORDS}`,
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      suggestions: { type: "array", items: { type: "object", properties: {
        scope: { type: "string" }, input: { type: "string", description: "The input's name from describe_inputs or missing_inputs." },
        value: { type: "number", description: "In the input's unit. Convert first: 3 PB into an input in TB is 3000; 30% into a fraction is 0.3." },
        origin: { type: "string", enum: Object.keys(ORIGINS) },
        evidence: { type: "string", description: "The sentence, cell, page or document the figure came from, quoted so an engineer can check it." },
      }, required: ["scope", "input", "value", "origin", "evidence"], additionalProperties: false } },
    }, required: ["name", "suggestions"], additionalProperties: false },
    run: (ws, a) => {
      const accepted = [], refused = [];
      const { version } = ws.update(str(a.name, "name"), (app, state) => {
        state.suggestions ??= {};
        for (const s of a.suggestions ?? []) {
          try {
            const { scope } = resolveScope(state, s.scope);
            const nd = resolveInput(state, s.input);
            checkScope(state, nd, scope);
            const ok = checkSuggestion(s);
            const key = `${scope}|${nd.name}`;
            state.suggestions[key] = { value: ok.value, origin: ok.origin, evidence: ok.evidence, by: "assistant", at: new Date().toISOString() };
            accepted.push({ scope, input: nd.name, value: ok.value, unit: nd.unit, origin: ok.origin, replaces: valueFor(state, scope, nd.name) });
          } catch (e) {
            if (!(e instanceof Refused)) throw e;
            refused.push({ scope: s.scope, input: s.input, reason: e.message });
          }
        }
      });
      return { accepted, refused, unconfirmed: accepted.length, version, note: "Suggestions wait for the engineer's confirmation in the page (or confirm_suggestions on their say-so). evaluate with provisional: true shows what the answer would be if they were all confirmed." };
    },
  },
  {
    name: "withdraw_suggestions",
    description: "Take back suggestions that have not been confirmed.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, inputs: { type: "array", items: { type: "object", properties: { scope: { type: "string" }, input: { type: "string" } }, required: ["scope", "input"] } } }, required: ["name", "inputs"], additionalProperties: false },
    run: (ws, a) => {
      let removed = 0;
      const { version } = ws.update(str(a.name, "name"), (app, state) => { for (const x of a.inputs ?? []) { const { scope } = resolveScope(state, x.scope); const nd = resolveInput(state, x.input); if (delete state.suggestions?.[`${scope}|${nd.name}`]) removed += 1; } });
      return { removed, version };
    },
  },
  {
    name: "confirm_suggestions",
    description: "Confirm suggestions on the engineer's behalf: only when they have told you to, naming which. The value enters the model with the suggestion's origin and evidence, marked as confirmed through the assistant. Leave `inputs` out to confirm every suggestion.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, inputs: { type: "array", items: { type: "object", properties: { scope: { type: "string" }, input: { type: "string" } }, required: ["scope", "input"] } }, confirmed_by: { type: "string", description: "Who said so, in their words: required." } }, required: ["name", "confirmed_by"], additionalProperties: false },
    run: (ws, a) => {
      const who = str(a.confirmed_by, "confirmed_by");
      const done = [];
      const { version, state } = ws.update(str(a.name, "name"), (app, state) => {
        const keys = a.inputs?.length ? a.inputs.map((x) => `${resolveScope(state, x.scope).scope}|${resolveInput(state, x.input).name}`) : Object.keys(state.suggestions ?? {});
        for (const key of keys) {
          const s = state.suggestions?.[key];
          if (!s) throw new Refused(`no suggestion for ${key}`);
          const [scope, name] = key.split("|");
          setValue(state, scope, name, s.value, provenanceFor(s.origin, `${s.evidence} (confirmed by ${who} through the assistant)`));
          delete state.suggestions[key];
          done.push({ scope, input: name, value: s.value });
        }
      });
      return { confirmed: done, blocker: blocker(state) || null, version };
    },
  },
  {
    name: "set_option",
    description: "Rename an option, say which parts it covers, or mark inputs it shares with our solution (same_as_ours: the figure is ours, used for it too, so a change moves both).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, option: { type: "string", description: "The option's id or name." }, rename: { type: "string" }, covers: { type: "array", items: { type: "string" }, description: "Part ids this option covers; an empty list means every part." }, same_as_ours: { type: "array", items: { type: "string" }, description: "Inputs this option takes from our solution." }, not_same_as_ours: { type: "array", items: { type: "string" } } }, required: ["name", "option"], additionalProperties: false },
    run: (ws, a) => {
      const { version, result } = ws.update(str(a.name, "name"), (app, state) => {
        const { option: o } = resolveScope(state, a.option);
        if (!o) throw new Refused("name an option, not the customer");
        if (a.rename) o.name = str(a.rename, "rename");
        if (a.covers) { for (const p of a.covers) if (!state.parts.includes(p)) throw new Refused(`"${p}" is not one of this solution's parts (${state.parts.join(", ")})`); o.covers = a.covers.length ? a.covers : null; }
        for (const x of a.same_as_ours ?? []) { if (o.ours) throw new Refused("our solution cannot be the same as itself"); const nd = resolveInput(state, x); checkScope(state, nd, o.id); o.same = [...new Set([...o.same, nd.name])]; delete o.overrides[nd.name]; delete o.provenance[nd.name]; }
        for (const x of a.not_same_as_ours ?? []) { const nd = resolveInput(state, x); o.same = o.same.filter((y) => y !== nd.name); }
        return { id: o.id, name: o.name, role: o.role, covers: o.covers ?? "every part", same_as_ours: o.same };
      });
      return { option: result, version };
    },
  },
  {
    name: "add_option",
    description: "Add an option to compare: role current (what the customer runs today), rival (a competitor), alt (another solution of ours) or custom.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, role: { type: "string", enum: ["current", "rival", "alt", "custom"] }, option_name: { type: "string" } }, required: ["name", "role"], additionalProperties: false },
    run: (ws, a) => { const { version, result } = ws.update(str(a.name, "name"), (app, state) => addOption(state, a.role, a.option_name)); return { option: { id: result.id, name: result.name, role: result.role }, version }; },
  },
  {
    name: "remove_option",
    description: "Remove an option that is not ours, with its figures.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, option: { type: "string" } }, required: ["name", "option"], additionalProperties: false },
    run: (ws, a) => { const { version } = ws.update(str(a.name, "name"), (app, state) => { const { option: o } = resolveScope(state, a.option); if (!o || o.ours) throw new Refused("name an option that is not ours"); state.options = state.options.filter((x) => x !== o); for (const k of Object.keys(state.suggestions ?? {})) if (k.startsWith(`${o.id}|`)) delete state.suggestions[k]; }); return { removed: true, version }; },
  },
  {
    name: "set_requirement_note",
    description: "Record a written requirement with no number (availability, retention, workloads, a constraint) under a category, so it is kept with the answer.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, category: { type: "string" }, text: { type: "string" } }, required: ["name", "category", "text"], additionalProperties: false },
    run: (ws, a) => { const { version, state } = ws.update(str(a.name, "name"), (app, st) => { const c = str(a.category, "category"); const t = str(a.text, "text"); st.written[c] = st.written[c] ? `${st.written[c]} ${t}` : t; }); return { requirement_notes: state.written, version }; },
  },
  {
    name: "set_notes",
    description: "Replace the customer notes kept with the solution (the text as given, for the engineer to read).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, notes: { type: "string" } }, required: ["name", "notes"], additionalProperties: false },
    run: (ws, a) => { const { version } = ws.update(str(a.name, "name"), (app, st) => { st.notes = String(a.notes ?? ""); }); return { ok: true, version }; },
  },
  {
    name: "evaluate",
    description: "The answer for every option from confirmed figures, with the cost lines by category. If required figures are missing the blocker is returned instead. With provisional: true the unconfirmed suggestions are applied to a copy and the result says which, so you can show the engineer what the answer would be.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, provisional: { type: "boolean" } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => {
      const r = ws.read(str(a.name, "name"));
      const prov = a.provisional ? withSuggestions(r.state) : { state: r.state, used: [] };
      const state = prov.state;
      const app = headlessApp(ws.ctx, state);
      const b = blocker(state);
      const out = { name: a.name, provisional: Boolean(a.provisional), suggestions_applied: prov.used, version: r.version };
      if (b) return { ...out, blocker: b, answer: null, hint: "Call missing_inputs for what is needed." };
      const q = questionById(state.type);
      const node = answerNode(state), unit = byName(state.doc).get(node)?.unit;
      const us = ours(state);
      out.answer = { label: answerLabel(state), node, unit, currency: state.doc.currency };
      out.options = state.options.map((o) => {
        const ev = app.evaluate(o);
        const v = valueOf(ev, node);
        const row = { id: o.id, name: o.name, ours: o.ours, value: v };
        if (!o.ours) { const mu = valueOf(app.evaluate(us), node); row.against_ours = v - mu; }
        if (q.kind === "cost") row.by_category = Object.fromEntries(categories(app).map((c) => [c.name, catTotal(app, ev, o, c)]));
        const ceilings = state.doc.nodes.filter((n) => n.kind === "ceiling").map((n) => ({ node: n.name, label: label(n), value: valueOf(ev, n.name), limit: String(n.limit), headroom: n.headroom }));
        if (ceilings.length) row.ceilings = ceilings;
        return row;
      });
      return out;
    },
  },
  {
    name: "explain",
    description: "Why a number is what it is, for one option: the node's formula in words and with the numbers in, and what it is made of down to the inputs with their origins and evidence. Defaults to the answer.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, option: { type: "string" }, node: { type: "string", description: "A node's name (see evaluate or describe_inputs); the answer if left out." }, depth: { type: "integer", description: "How many levels down, default 3." } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => {
      const { state, version } = ws.read(str(a.name, "name"));
      const app = headlessApp(ws.ctx, state);
      const o = a.option ? resolveScope(state, a.option).option ?? ours(state) : ours(state);
      const node = a.node ?? answerNode(state);
      if (!byName(state.doc).has(node)) throw new Refused(`no node called "${node}"`);
      const ev = app.evaluate(o);
      return { name: a.name, option: { id: o.id, name: o.name }, tree: explainNode(app, o, ev, node, a.depth ?? 3), version };
    },
  },
  {
    name: "what_if",
    description: "Every option's answer with some figures changed, next to the answer as it stands. The solution is not changed: a what-if is a copy. A shared change applies to every option; an option's change to it alone.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, changes: { type: "array", items: { type: "object", properties: { scope: { type: "string" }, input: { type: "string" }, value: { type: "number" } }, required: ["scope", "input", "value"] } }, provisional: { type: "boolean", description: "Apply unconfirmed suggestions first." } }, required: ["name", "changes"], additionalProperties: false },
    run: (ws, a) => {
      const r = ws.read(str(a.name, "name"));
      const state = a.provisional ? withSuggestions(r.state).state : r.state;
      const app = headlessApp(ws.ctx, state);
      const b = blocker(state);
      if (b) return { name: a.name, blocker: b };
      const node = answerNode(state);
      const changes = (a.changes ?? []).map((c) => { const { scope } = resolveScope(state, c.scope); const nd = resolveInput(state, c.input); checkScope(state, nd, scope); if (typeof c.value !== "number" || !Number.isFinite(c.value)) throw new Refused(`value for ${nd.name} must be a number`); return { scope, input: nd.name, value: c.value, was: valueFor(state, scope, nd.name) }; });
      const options = state.options.map((o) => {
        const overrides = {};
        for (const c of changes) if (c.scope === "shared" || c.scope === o.id) overrides[c.input] = c.value;
        const ev = app.evaluate(o);
        const base = valueOf(ev, node);
        const changed = Object.keys(overrides).length ? atOption(ev, overrides, [node]).get(node) ?? NaN : base;
        return { id: o.id, name: o.name, ours: o.ours, as_it_stands: base, what_if: changed, difference: changed - base };
      });
      return { name: a.name, answer: { label: answerLabel(state), node, unit: byName(state.doc).get(node)?.unit }, changes, options, version: r.version };
    },
  },
  {
    name: "write_files",
    description: "Write the model file and one scenario file per option into the solution's folder, from confirmed figures only, and return the book's toolkit's verdict on them (the same checks verify-models.py makes) with the reference ranges.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => {
      const { state, version } = ws.read(str(a.name, "name"));
      const b = blocker(state);
      if (b) return { name: a.name, blocker: b, written: [] };
      const out = files(state);
      const paths = ws.writeFiles(a.name, out);
      const { report, ranges } = judge(out, { results: ws.ctx.results, units: ws.ctx.units });
      const verdict = report.load.ok ? { ok: report.verify.ok, problems: report.verify.problems.map((p) => ({ code: p.code, node: p.node, scenario: p.scenario, detail: p.detail })), classification: report.model.classification } : { ok: false, load_error: report.load.message };
      return { name: a.name, written: paths, files: out, verdict, ranges, version };
    },
  },
  {
    name: "open_in_page",
    description: "Where the engineer sees this solution in the builder's page, with every suggestion waiting for their confirmation.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run: (ws, a) => { ws.read(str(a.name, "name")); const base = ws.pageUrl; return base ? { url: `${base}v2/?solution=${encodeURIComponent(a.name)}` } : { url: null, note: "The page is not being served: run `npx sizing-and-tco-builder serve` and open /v2/?solution=" + encodeURIComponent(a.name) }; },
  },
];

export const toolByName = (name) => TOOLS.find((t) => t.name === name);

/* Run one tool: a refusal is a result the assistant can read, not a crash. */
export function runTool(ws, name, args = {}) {
  const t = toolByName(name);
  if (!t) throw new Refused(`no tool called "${name}"`);
  try {
    return { ok: true, result: t.run(ws, args ?? {}) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/* What tools/list reports: the tools without their code. */
export const toolList = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
