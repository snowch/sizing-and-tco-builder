/*
 * Suggestions: figures an assistant proposed over the server, each with an origin and the
 * evidence it read the figure from. A suggestion sits in `state.suggestions` under
 * "<scope>|<input>", apart from the model, until the engineer confirms it here or rejects it.
 * Confirming writes the value and its provenance exactly where a typed figure would go.
 *
 * Shared by the page and the server, so the two agree on what confirming means.
 */

import { provenanceFor } from "./questions.js";
import { byName, isBlank, optionById } from "./evaluate.js";

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

/* The suggestions that still point at something in the model, as [key, suggestion, scope, name]. */
export function suggestions(state) {
  const names = byName(state.doc);
  return Object.entries(state.suggestions ?? {}).map(([key, s]) => { const [scope, name] = key.split("|"); return { key, scope, name, s }; })
    .filter(({ scope, name }) => names.has(name) && (scope === "shared" || optionById(state, scope)));
}
export const suggestionFor = (state, scope, name) => state.suggestions?.[`${scope}|${name}`] ?? null;

/* Confirm: the value enters the model with the suggestion's origin and evidence, and a note of who confirmed it. */
export function confirmSuggestion(state, key, how = "confirmed in the page") {
  const s = state.suggestions?.[key];
  if (!s) return false;
  const [scope, name] = key.split("|");
  if (!byName(state.doc).has(name) || (scope !== "shared" && !optionById(state, scope))) { delete state.suggestions[key]; return false; }
  setValue(state, scope, name, s.value, provenanceFor(s.origin, `${s.evidence} (suggested by the assistant, ${how})`));
  delete state.suggestions[key];
  return true;
}
export function rejectSuggestion(state, key) {
  if (!state.suggestions?.[key]) return false;
  delete state.suggestions[key];
  return true;
}
