/*
 * The builder's state: the reader's model as a document in the writer's shape (engine/write.js),
 * the names still to define, and the answers to the flow's own questions.
 *
 * Nothing here holds a number the reader did not type. A preset is a kind or a unit (the horizon
 * is an input you decide, in years), never a value.
 *
 * The state lives in the browser, in localStorage. Every access is wrapped: storage can be
 * missing, full, or refused, and the builder must still work with nothing stored.
 */

const KEY = "sizing-and-tco-builder:v1";

export function emptyState() {
  return {
    version: 1,
    goal: null,
    answer: null,
    decision: "",
    horizon: null, // a node name, "none" when the answer is for today, or null when not yet asked
    hosts: null, // "one" or "roles", once the hosts question is answered
    doc: { model: "my_model", title: "", currency: "USD", description: "", nodes: [], outputs: [], correlations: [] },
    pending: [], // { name, unit, label, suggested } for each name a formula uses and nobody has defined
    scenarios: [reference()],
    skipped: [],
    seen: [],
  };
}

export function reference() {
  return { scenario: "reference", title: "Reference", because: "The model as declared, with nothing changed.", samples: 100000, seed: 20260916, overrides: {} };
}

export function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

export function save(state) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function forget() {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing stored, or storage refused: either way there is nothing to forget.
  }
}

// -- small mutations the flow makes ---------------------------------------------------------------

export const nodeNamed = (state, name) => state.doc.nodes.find((n) => n.name === name) ?? null;
export const pendingNamed = (state, name) => state.pending.find((p) => p.name === name) ?? null;
export const exists = (state, name) => Boolean(nodeNamed(state, name) || pendingNamed(state, name));

/* A name a formula uses and nobody has defined yet. */
export function addPending(state, name, { unit = null, label = null, suggested = null } = {}) {
  const existing = pendingNamed(state, name);
  if (existing) {
    if (!existing.unit && unit) existing.unit = unit;
    return;
  }
  if (nodeNamed(state, name)) return;
  state.pending.push({ name, unit, label: label ?? name.replaceAll("_", " "), suggested });
}

/* Put a defined node in the model, in place of the pending name or the node it edits. */
export function putNode(state, node, replacing = node.name) {
  state.pending = state.pending.filter((p) => p.name !== replacing && p.name !== node.name);
  const at = state.doc.nodes.findIndex((n) => n.name === replacing);
  if (at >= 0) state.doc.nodes[at] = node;
  else state.doc.nodes.push(node);
  if (replacing !== node.name) rename(state, replacing, node.name);
}

/* Rename everywhere a name appears: formulas, outputs, pairs, scenarios, the flow's own fields. */
export function rename(state, from, to) {
  if (from === to) return;
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "gu");
  for (const n of state.doc.nodes) {
    for (const field of ["formula", "of", "limit", "headroom"]) if (typeof n[field] === "string") n[field] = n[field].replace(word, to);
  }
  state.doc.outputs = state.doc.outputs.map((o) => (o === from ? to : o));
  for (const pair of state.doc.correlations) {
    if (pair.a === from) pair.a = to;
    if (pair.b === from) pair.b = to;
  }
  for (const s of state.scenarios) {
    if (from in s.overrides) {
      s.overrides[to] = s.overrides[from];
      delete s.overrides[from];
    }
  }
  if (state.answer === from) state.answer = to;
  if (state.horizon === from) state.horizon = to;
  for (const p of state.pending) if (p.name === from) p.name = to;
}

/* Remove a node. Names its formulas used that nothing else uses stay as names to define. */
export function removeNode(state, name) {
  state.doc.nodes = state.doc.nodes.filter((n) => n.name !== name);
  state.pending = state.pending.filter((p) => p.name !== name);
  state.doc.outputs = state.doc.outputs.filter((o) => o !== name);
  state.doc.correlations = state.doc.correlations.filter((c) => c.a !== name && c.b !== name);
  for (const s of state.scenarios) delete s.overrides[name];
  if (state.answer === name) state.answer = null;
  if (state.horizon === name) state.horizon = null;
}
