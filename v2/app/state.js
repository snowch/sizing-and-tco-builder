/*
 * The page's state: the question, the notes, the model document (the writer's form, as v1
 * keeps it) with our solution's values in it, and each other option as the overrides its
 * scenario will carry. Nothing here holds a number nobody typed or confirmed.
 *
 * It lives in localStorage under its own key, apart from v1's, and every access is wrapped:
 * the page must work with nothing stored.
 */

import { ROLE_NAMES, questionById } from "./questions.js";

const KEY = "sizing-and-tco-builder:v2";

export function emptyState() {
  return {
    version: 2,
    mode: "start",
    type: "competitive",
    sentence: "",
    sentenceEdited: false,
    notes: "",
    parts: [],
    doc: null,
    map: {},
    options: [],
    candidates: [],
    written: {},
    whatIfs: [],
    open: ["customer"],
    focus: null,
    expert: false,
    nextLine: 1,
  };
}

/* An option: a role, a name, and for one that is not ours the overrides its scenario carries. */
export function newOption(role, k, ours) {
  return { id: `o${k}`, role, name: ROLE_NAMES[role] ?? "Option", ours, overrides: {}, same: [], provenance: {}, covers: null };
}

export function optionsFor(type) {
  const q = questionById(type);
  return q.roles.map((role, k) => newOption(role, k, role === "ours"));
}

export function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state?.version === 2 ? { ...emptyState(), ...state } : null;
  } catch {
    return null;
  }
}

export function save(state) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not remembered; the page still works for this visit.
  }
}

export function clear() {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
