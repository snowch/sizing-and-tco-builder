/* Small helpers the views share. */

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* A number for reading, not for the file: the file always has the number exactly as typed. */
export function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e9 || a < 1e-3)) return v.toExponential(2).replace("e+", " × 10^").replace("e-", " × 10^-");
  if (a >= 1000) return Math.round(v).toLocaleString("en-GB");
  return String(Number(v.toPrecision(3)));
}

let OUTLINE = { site: "", chapters: [], appendices: [] };
export function useOutline(outline) {
  OUTLINE = outline;
}

function entry(slug) {
  return OUTLINE.chapters.find((c) => c.slug === slug) ?? OUTLINE.appendices.find((a) => a.slug === slug) ?? null;
}

/*
 * Further reading on a topic, by its title. Every explanation in the builder is complete without
 * it; the link is for a reader who wants the longer account the method comes from.
 */
export function chapterLink(slug) {
  const c = entry(slug);
  if (!c) return "";
  return `<a href="${esc(OUTLINE.site + c.page)}" target="_blank" rel="noopener">${esc(c.title)}</a>`;
}

export function chapters(slugs = [], appendix = null) {
  const links = [...slugs, ...(appendix ? [appendix] : [])].map((s) => chapterLink(s)).filter(Boolean);
  return links.length ? `<span class="ch">Read more: ${links.join(" · ")}</span>` : "";
}

/*
 * An engine message as the page shows it. The engine words its refusals as the rules it follows
 * do, with references to where each rule is explained; the page's own explanations stand alone,
 * so those references are taken out.
 */
export function plain(message) {
  return String(message ?? "")
    .replace(/\s*\((?:ch\d+|appendix [A-H])[^)]*\)/g, "")
    .replace(/\s*[—-]+\s*see ch\d+[^.]*\./g, ".")
    .replace(/\s*\bsee ch\d+[^.;]*/g, "")
    .replace(/\s+\./g, ".");
}

export const NAME = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(["min", "max", "ceil", "floor", "sqrt", "log", "exp", "and", "or", "not", "in", "is", "if", "else", "for", "lambda", "none", "true", "false", "yes", "no", "on", "off", "null"]);

/* Why a name will not do, or "" if it will. The book reads a name as a Python identifier. */
export function nameProblem(name) {
  if (!name) return "Give it a name: lower case, letters, digits and underscores.";
  if (!NAME.test(name)) return "The name is what formulas use: lower case, letters, digits and underscores, not starting with a digit.";
  if (RESERVED.has(name)) return `${name} is a word the formula language or the file format already uses. Pick another.`;
  return "";
}
