/*
 * A solution is one or more parts, each a model file of its own (v2/templates/*.yaml) with
 * every customer and option figure blank. Choosing several merges them into one model: each
 * part's names take the part's id as a prefix, the inputs every part shares (the period and the
 * definitions) are kept once, and a grand total adds the parts' totals. The result is an
 * ordinary model document in the writer's form, so nothing downstream knows it was assembled.
 *
 * Pure: no page, no storage. Loaded templates are passed in, so this runs in node too.
 */

import { loadModel } from "../../engine/model.js";
import { documentFrom } from "../../engine/write.js";
import { parse, refs } from "../../engine/formula.js";

/* A part's template as a document, plus its metadata from index.json. */
export function loadPart(meta, yamlText, { registry }) {
  const model = loadModel(yamlText, { registry, where: meta.file });
  const doc = documentFrom(model);
  for (const n of doc.nodes) if (n.kind === "input" && !n.provenance) n.provenance = { kind: "", source: "" };
  return { ...meta, doc };
}

/* Rewrite every name in a formula text with the part's prefix, leaving shared names alone. */
function prefixFormula(text, rename) {
  return text.replace(/[A-Za-z_]\w*/g, (word) => rename.get(word) ?? word);
}

/*
 * The merged document. `parts` are loaded parts in the order chosen; `index` is index.json.
 * With one part, its document is returned unprefixed, so a single-part solution reads as the
 * template does.
 */
export function merge(parts, index, { model = "solution", title = "" } = {}) {
  if (!parts.length) throw new Error("a solution needs at least one part");
  const shared = new Set(index.shared);
  if (parts.length === 1) {
    const doc = structuredClone(parts[0].doc);
    doc.model = model;
    if (title) doc.title = title;
    return { doc, map: new Map(doc.nodes.map((n) => [n.name, { part: parts[0].id, local: n.name }])), totals: ["total_cost"] };
  }
  const nodes = [];
  const seen = new Set();
  const map = new Map();
  const totals = [];
  const outputs = [];
  for (const part of parts) {
    const rename = new Map();
    for (const n of part.doc.nodes) rename.set(n.name, shared.has(n.name) ? n.name : `${part.id}_${n.name}`);
    for (const n of part.doc.nodes) {
      const name = rename.get(n.name);
      if (seen.has(name)) continue;
      seen.add(name);
      const out = structuredClone(n);
      out.name = name;
      if (!shared.has(n.name)) out.label = `${n.label ?? n.name.replaceAll("_", " ")} (${part.domain.toLowerCase()})`;
      if (out.formula) out.formula = prefixFormula(out.formula, rename);
      if (out.of) out.of = prefixFormula(out.of, rename);
      if (out.limit) out.limit = prefixFormula(String(out.limit), rename);
      if (out.headroom) out.headroom = prefixFormula(out.headroom, rename);
      nodes.push(out);
      map.set(name, { part: part.id, local: n.name });
    }
    totals.push(rename.get("total_cost"));
    for (const o of part.doc.outputs) outputs.push(rename.get(o));
  }
  nodes.push({ name: "total_cost", kind: "derived", unit: parts[0].doc.currency, label: "cost of the whole solution over the period", note: null, formula: totals.join(" + ") });
  map.set("total_cost", { part: "all", local: "total_cost" });
  const doc = {
    dsl: parts[0].doc.dsl,
    model,
    title: title || `A solution of ${parts.map((p) => p.domain.toLowerCase()).join(", ")}`,
    currency: parts[0].doc.currency,
    description: parts.map((p) => p.doc.description).join("\n\n"),
    nodes,
    outputs: ["total_cost", ...outputs],
    correlations: [],
  };
  return { doc, map, totals };
}

/* The inputs a node rests on, by walking formulas in the document. */
export function inputsBehind(doc, names) {
  const byName = new Map(doc.nodes.map((n) => [n.name, n]));
  const out = new Set();
  const seen = new Set();
  const stack = [...names];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || !byName.has(name)) continue;
    seen.add(name);
    const n = byName.get(name);
    if (n.kind === "input") { out.add(name); continue; }
    const texts = n.kind === "derived" ? [n.formula] : n.kind === "ceiling" ? [n.of, String(n.limit), n.headroom] : [];
    for (const t of texts) {
      try { for (const r of refs(parse(t))) stack.push(r); } catch { /* an unparsable formula rests on nothing knowable */ }
    }
  }
  return out;
}
