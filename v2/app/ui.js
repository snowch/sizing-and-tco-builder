/* Small helpers for the page: escaping, number and unit formatting, element lookup. */

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : "");
export const upper = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

const SYMBOLS = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", INR: "₹", CHF: "CHF ", CAD: "C$", AUD: "A$", SEK: "kr ", NOK: "kr ", DKK: "kr " };
export const symbol = (currency) => SYMBOLS[currency] ?? `${currency} `;

export const n = (v, d = 0) => Number(v).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
export const places = (v) => (Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0);

/* Money in full: £1,234,567. */
export function money(v, currency) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}${symbol(currency)}${n(a, a < 100 && !Number.isInteger(a) ? 2 : 0)}`;
}
/* Money for a headline: £1.23m, £457k. */
export function big(v, currency) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}${symbol(currency)}${(a / 1e6).toFixed(2)}m`;
  if (a >= 1e4) return `${s}${symbol(currency)}${n(Math.round(a / 1e3))}k`;
  return money(v, currency);
}

/* A value with its unit, in the words the page uses for that unit. */
export function fmt(v, unit, currency) {
  if (!Number.isFinite(v)) return "—";
  const u = String(unit ?? "");
  if (u === currency) return money(v, currency);
  if (u.startsWith(`${currency}/`)) return `${money(v, currency)}${u.slice(currency.length).replace(/\/count/g, " each").replace(/\//g, " a ")}`;
  if (u === "dimensionless") return n(v, places(v) || (Number.isInteger(v) ? 0 : 2));
  if (u === "1/year") return `${n(v * 100, places(v * 100))}% a year`;
  return `${n(v, places(v))} ${unitWords(u)}`.trim();
}
export function unitWords(u) {
  return String(u ?? "").replace(/\bcount\b/g, "").replace(/GiB/g, "GiB").replace(/\s*\*\s*/g, "·").replace(/\//g, " a ").replace(/\bhost\b/g, "unit").trim();
}

/* Download some text as a file. */
export function download(name, text, type = "text/yaml") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
