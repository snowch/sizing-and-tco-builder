/*
 * Explore: charts of the reader's own model, the kind the book draws of its own (ch23's seller's
 * TCO is the worked example). Three of them:
 *
 *   - Sweep one input: answers across the input's range, one line per case, with each crossing
 *     of a target (a break-even, a payback) found on the model and marked.
 *   - Two inputs: the line where an answer meets its target across a plane of two inputs, the
 *     side above it shaded, and each case marked where it sits.
 *   - Compare cases: the answers side by side, and an answer that is a sum split into its terms.
 *
 * Every number is the engine's (engine/explore.js), from the model the page has worked out.
 * Nothing is chosen for the reader: a range is the one the input declares or one the reader
 * types (and may save into the file); a case is a scenario, or a value the reader gives.
 */

import { at, boundary, breakdown, crossings, sides, spaced } from "../engine/explore.js";
import { $, chapters, esc, fmt } from "./ui.js";

const SERIES = 8; // the palette's categorical slots, in order; a ninth case is not drawn
const W = 720;
const H = 380;
const M = { top: 26, right: 150, bottom: 46, left: 70 };

// -- what the reader can pick -------------------------------------------------------------------------

function nodeOf(app, name) {
  return app.state.doc.nodes.find((n) => n.name === name) ?? null;
}
const labelOf = (app, name) => nodeOf(app, name)?.label || name;
const unitOf = (app, name) => {
  const u = nodeOf(app, name)?.unit ?? "";
  return u === "dimensionless" ? "" : u;
};

/* Inputs a chart can move: given numbers and measured constants the model has a value for. */
function movable(app) {
  return app.state.doc.nodes.filter((n) => (n.kind === "input" || n.kind === "measured") && app.previewed.values.get(n.name)?.state === "ok").map((n) => n.name);
}

/* Answers a chart can draw: the model's outputs, then every other worked-out node. */
function drawable(app) {
  const ok = (n) => app.previewed.values.get(n)?.state === "ok";
  const outs = app.state.doc.outputs.filter(ok);
  const rest = app.state.doc.nodes.filter((n) => n.kind === "derived" && !outs.includes(n.name) && ok(n.name)).map((n) => n.name);
  return [...outs, ...rest];
}

/* The cases a chart draws: each scenario, or values of one input on top of a scenario. */
function casesOf(app, e) {
  const scenario = (name) => app.state.scenarios.find((s) => s.scenario === name);
  if (e.cases === "written") {
    const base = new Map(Object.entries(scenario(e.base)?.overrides ?? {}));
    const { cases } = parseCases(e.written, movable(app));
    return { base, heading: "case", list: cases.slice(0, SERIES) };
  }
  if (e.cases === "values" && e.caseInput) {
    const base = new Map(Object.entries(scenario(e.base)?.overrides ?? {}));
    return {
      base,
      heading: labelOf(app, e.caseInput),
      list: parseValues(e.values).slice(0, SERIES).map((v) => ({ key: `${e.caseInput} = ${v}`, label: fmt(v), overrides: new Map([[e.caseInput, v]]) })),
    };
  }
  return {
    base: new Map(),
    heading: "scenario",
    list: app.state.scenarios.slice(0, SERIES).map((s) => ({ key: s.scenario, label: s.title || s.scenario, overrides: new Map(Object.entries(s.overrides ?? {})) })),
  };
}

/*
 * Cases the reader writes, one a line: a label, a colon, and the inputs it changes, each
 * "name = number", separated by commas. A line with no changes is the scenario as it stands.
 * A name the model has not got, or a value that is not a number, is reported, not guessed at.
 */
export function parseCases(text, known) {
  const cases = [];
  const problems = [];
  String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    const colon = line.indexOf(":");
    const label = colon >= 0 ? line.slice(0, colon).trim() : "";
    const rest = colon >= 0 ? line.slice(colon + 1) : line;
    const overrides = new Map();
    let ok = true;
    for (const part of rest.split(",").map((p) => p.trim()).filter(Boolean)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)$/.exec(part);
      const value = m ? Number(m[2]) : NaN;
      if (!m) { problems.push(`line ${i + 1}: "${part}" is not name = number`); ok = false; continue; }
      if (!known.includes(m[1])) { problems.push(`line ${i + 1}: the model has no input called ${m[1]}`); ok = false; continue; }
      if (!Number.isFinite(value)) { problems.push(`line ${i + 1}: ${m[2]} is not a number`); ok = false; continue; }
      overrides.set(m[1], value);
    }
    if (ok) cases.push({ key: `case ${i + 1}: ${label}`, label: label || `case ${i + 1}`, overrides });
  });
  return { cases, problems };
}

function parseValues(text) {
  return String(text ?? "").split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

/* The values an input takes across the scenarios, and its own: a starting list, all from the files. */
function valuesInFiles(app, name) {
  const own = app.previewed.values.get(name);
  const all = [own?.state === "ok" ? own.value : null, ...app.state.scenarios.map((s) => s.overrides?.[name])];
  return [...new Set(all.filter((v) => typeof v === "number"))];
}

/* An input's range: the one its file declares, or the one the reader typed for this chart. */
function rangeOf(app, e, name, key) {
  const typed = e.typed?.[`${key}:${name}`];
  if (typed && Number.isFinite(typed[0]) && Number.isFinite(typed[1]) && typed[0] !== typed[1]) return { lo: typed[0], hi: typed[1], typed: true };
  const declared = nodeOf(app, name)?.range;
  if (Array.isArray(declared) && Number.isFinite(declared[0]) && Number.isFinite(declared[1]) && declared[0] !== declared[1]) return { lo: declared[0], hi: declared[1], typed: false };
  return null;
}

// -- axes ---------------------------------------------------------------------------------------------

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function extent(values, include = []) {
  const vs = [...values, ...include].filter(Number.isFinite);
  if (!vs.length) return [0, 1];
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

/* A tick's number, short: 2,500,000 is 2.5M, so the axis title is not crowded out. */
function tick(v) {
  const a = Math.abs(v);
  const short = (n, unit) => `${Number((v / n).toPrecision(3))}${unit}`;
  if (a >= 1e9) return short(1e9, "bn");
  if (a >= 1e6) return short(1e6, "M");
  if (a >= 1e4) return short(1e3, "k");
  return fmt(v);
}

function axes(xs, ys, sx, sy, xLabel, yLabel) {
  const grid = ys.map((v) => `<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${sy(v)}" y2="${sy(v)}"/><text class="tick" x="${M.left - 8}" y="${sy(v) + 4}" text-anchor="end">${esc(tick(v))}</text>`).join("");
  const xt = xs.map((v) => `<text class="tick" x="${sx(v)}" y="${H - M.bottom + 18}" text-anchor="middle">${esc(tick(v))}</text>`).join("");
  return `${grid}${xt}<line class="axis" x1="${M.left}" x2="${W - M.right}" y1="${H - M.bottom}" y2="${H - M.bottom}"/>
    <text class="axis-label" x="${(M.left + W - M.right) / 2}" y="${H - 8}" text-anchor="middle">${esc(clip(xLabel, 80))}</text>
    <text class="axis-label" transform="translate(16 ${(M.top + H - M.bottom) / 2}) rotate(-90)" text-anchor="middle">${esc(clip(yLabel, 46))}</text>`;
}

const svgOpen = (label) => `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`;

// -- the three charts ------------------------------------------------------------------------------------

function sweepChart(app, e) {
  const x = e.x;
  const r = rangeOf(app, e, x, "x");
  if (!r) return { needsRange: x };
  const outputs = e.outputs.filter((o) => drawable(app).includes(o));
  const { base, list, heading } = casesOf(app, e);
  const { model, factors } = app.previewed;
  const xs = spaced(r.lo, r.hi, 61);
  const cases = list.length ? list : [{ key: "model", label: "the model", overrides: new Map() }];
  const series = [];
  for (const c of cases) {
    for (const output of outputs) {
      const ys = xs.map((v) => at(model, factors, new Map([...base, ...c.overrides, [x, v]]), [output]).get(output) ?? null);
      const cross = e.target === null ? [] : crossings(model, factors, { base: new Map([...base, ...c.overrides]), x, output, target: e.target, low: r.lo, high: r.hi });
      const here = at(model, factors, new Map([...base, ...c.overrides]), [output, x]);
      series.push({ c, output, ys, cross, now: { x: here.get(x), y: here.get(output) } });
    }
  }
  const [x0, x1] = [r.lo, r.hi];
  const [y0, y1] = extent(series.flatMap((s) => s.ys), e.target === null ? [] : [e.target]);
  const sx = (v) => M.left + ((v - x0) / (x1 - x0)) * (W - M.left - M.right);
  const sy = (v) => H - M.bottom - ((v - y0) / (y1 - y0)) * (H - M.top - M.bottom);
  const caseIndex = new Map(cases.map((c, i) => [c.key, i]));
  const outIndex = new Map(outputs.map((o, i) => [o, i]));
  const dashes = ["", "6 4", "2 3"];
  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    s.ys.forEach((y, i) => {
      if (y === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
    });
    return `<path class="line s${caseIndex.get(s.c.key) + 1}" d="${d}" stroke-dasharray="${dashes[outIndex.get(s.output)] ?? ""}"/>`;
  }).join("");
  const target = e.target !== null && e.target >= y0 && e.target <= y1 ? `<line class="target" x1="${M.left}" x2="${W - M.right}" y1="${sy(e.target)}" y2="${sy(e.target)}"/>` : "";
  const marks = series.flatMap((s) => s.cross.map((cx) => `<circle class="cross" cx="${sx(cx)}" cy="${sy(e.target)}" r="5"><title>${esc(`${s.c.label}: ${labelOf(app, s.output)} meets ${fmt(e.target)} at ${labelOf(app, x)} ${fmt(cx)}`)}</title></circle>`)).join("");
  const nows = series.filter((s) => Number.isFinite(s.now.x) && Number.isFinite(s.now.y) && s.now.x >= x0 && s.now.x <= x1)
    .map((s) => `<circle class="now s${caseIndex.get(s.c.key) + 1}" cx="${sx(s.now.x)}" cy="${sy(s.now.y)}" r="5"><title>${esc(`${s.c.label}: as the case has it, ${labelOf(app, x)} ${fmt(s.now.x)} gives ${fmt(s.now.y)}`)}</title></circle>`).join("");
  // Direct labels at the right-hand end of each line, text in ink, with a key mark in the line's colour.
  const ends = series.map((s) => {
    const last = [...s.ys].reverse().find((y) => y !== null);
    return { s, y: last === undefined ? null : sy(last) };
  }).filter((l) => l.y !== null).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const head = list.length ? `<text class="tick" x="${W - M.right + 6}" y="${M.top - 10}">${esc(clip(heading, 24))}</text>` : "";
  const labels = head + ends.map(({ s, y }) => `<line class="key s${caseIndex.get(s.c.key) + 1}" x1="${W - M.right + 6}" x2="${W - M.right + 20}" y1="${y}" y2="${y}" stroke-dasharray="${dashes[outIndex.get(s.output)] ?? ""}"/><text class="direct" x="${W - M.right + 24}" y="${y + 4}">${esc(clip(`${s.c.label}${outputs.length > 1 ? `, ${labelOf(app, s.output)}` : ""}`, 20))}</text>`).join("");
  const title = `${outputs.map((o) => labelOf(app, o)).join(" and ")} against ${labelOf(app, x)}`;
  const yUnit = unitOf(app, outputs[0]);
  const svg = `${svgOpen(title)}${axes(niceTicks(x0, x1), niceTicks(y0, y1), sx, sy, `${labelOf(app, x)}${unitOf(app, x) ? ` (${unitOf(app, x)})` : ""}`, `${outputs.map((o) => labelOf(app, o)).join(", ")}${yUnit ? ` (${yUnit})` : ""}`)}${target}${paths}${marks}${nows}${labels}<rect class="hit" x="${M.left}" y="${M.top}" width="${W - M.left - M.right}" height="${H - M.top - M.bottom}"/><line class="crosshair" x1="0" x2="0" y1="${M.top}" y2="${H - M.bottom}" visibility="hidden"/></svg>`;
  const rows = [[labelOf(app, x), ...series.map((s) => `${s.c.label}: ${labelOf(app, s.output)}`)], ...xs.map((v, i) => [v, ...series.map((s) => s.ys[i])])];
  const found = series.filter((s) => e.target !== null).map((s) => `${esc(s.c.label)}${outputs.length > 1 ? `, ${esc(labelOf(app, s.output))}` : ""}: ${s.cross.length ? s.cross.map((v) => `<strong class="mono">${esc(fmt(v))}</strong>`).join(", ") : "does not meet it in this range"}`);
  return {
    title,
    svg,
    rows,
    notes: e.target === null ? "" : `<p class="note">Where ${esc(outputs.map((o) => labelOf(app, o)).join(" or "))} meets ${esc(fmt(e.target))}, as ${esc(labelOf(app, x))}: ${found.join(" · ")}. Found on the model to a part in a trillion, not read off the line.</p>`,
    hover: { xs, series: series.map((s) => ({ label: `${s.c.label}${outputs.length > 1 ? `, ${labelOf(app, s.output)}` : ""}`, ys: s.ys })), sx, x0, x1, xLabel: labelOf(app, x) },
    range: r,
  };
}

function planeChart(app, e) {
  const [x, y, output] = [e.x, e.y, e.outputs[0]];
  const rx = rangeOf(app, e, x, "x");
  const ry = rangeOf(app, e, y, "y");
  if (!rx) return { needsRange: x };
  if (!ry) return { needsRange: y, axis: "y" };
  const { model, factors } = app.previewed;
  const { base, list, heading } = casesOf(app, e);
  const target = e.target ?? 0;
  const gx = spaced(rx.lo, rx.hi, 48);
  const gy = spaced(ry.lo, ry.hi, 32);
  const grid = sides(model, factors, { base, x, y, output, target, xs: gx, ys: gy });
  const line = boundary(model, factors, { base, x, y, output, target, xLow: rx.lo, xHigh: rx.hi, ys: spaced(ry.lo, ry.hi, 41), samples: 121 });
  const sx = (v) => M.left + ((v - rx.lo) / (rx.hi - rx.lo)) * (W - M.left - M.right);
  const sy = (v) => H - M.bottom - ((v - ry.lo) / (ry.hi - ry.lo)) * (H - M.top - M.bottom);
  const cw = (W - M.left - M.right) / (gx.length - 1);
  const ch = (H - M.top - M.bottom) / (gy.length - 1);
  const cells = grid.flatMap((row, j) => row.map((s, i) => (s === 1 ? `<rect class="above" x="${sx(gx[i]) - cw / 2}" y="${sy(gy[j]) - ch / 2}" width="${cw}" height="${ch}"/>` : ""))).join("");
  const pts = line.flatMap((row) => row.xs.map((v) => [sx(v), sy(row.y)]));
  const boundaryPath = pts.length ? `<path class="boundary" d="${pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("")}"/>` : "";
  const here = list.map((c, i) => {
    const v = at(model, factors, new Map([...base, ...c.overrides]), [x, y, output]);
    return { c, i, vx: v.get(x), vy: v.get(y), vz: v.get(output) };
  }).filter((p) => Number.isFinite(p.vx) && Number.isFinite(p.vy));
  const marks = here.map((p) => {
    const inside = p.vx >= rx.lo && p.vx <= rx.hi && p.vy >= ry.lo && p.vy <= ry.hi;
    if (!inside) return "";
    return `<circle class="point s${p.i + 1}" cx="${sx(p.vx)}" cy="${sy(p.vy)}" r="6"><title>${esc(`${heading} ${p.c.label}: ${labelOf(app, output)} ${fmt(p.vz)}`)}</title></circle><text class="direct" x="${sx(p.vx) + 9}" y="${sy(p.vy) - 8}">${esc(clip(p.c.label, 22))}</text>`;
  }).join("");
  const title = `Where ${labelOf(app, output)} is ${fmt(target)}, across ${labelOf(app, x)} and ${labelOf(app, y)}`;
  const above = grid.flat().filter((s) => s === 1).length / Math.max(1, grid.flat().filter((s) => s !== null).length);
  const key = `<rect class="above" x="${W - M.right + 8}" y="${M.top}" width="14" height="14"/><text class="direct" x="${W - M.right + 28}" y="${M.top + 11}">${esc(clip(`above ${fmt(target)}`, 20))}</text><line class="boundary" x1="${W - M.right + 8}" x2="${W - M.right + 22}" y1="${M.top + 30}" y2="${M.top + 30}"/><text class="direct" x="${W - M.right + 28}" y="${M.top + 34}">${esc(clip(`exactly ${fmt(target)}`, 20))}</text>`;
  const svg = `${svgOpen(title)}${cells}${axes(niceTicks(rx.lo, rx.hi), niceTicks(ry.lo, ry.hi), sx, sy, `${labelOf(app, x)}${unitOf(app, x) ? ` (${unitOf(app, x)})` : ""}`, `${labelOf(app, y)}${unitOf(app, y) ? ` (${unitOf(app, y)})` : ""}`)}${boundaryPath}${marks}${key}</svg>`;
  const rows = [[labelOf(app, y), `${labelOf(app, x)} where ${labelOf(app, output)} is ${fmt(target)}`], ...line.map((row) => [row.y, row.xs.length ? row.xs.join("; ") : "not in this range"])];
  return {
    title,
    svg,
    rows,
    notes: `<p class="note">The shaded side is where ${esc(labelOf(app, output))} is above ${esc(fmt(target))}: ${esc(fmt(100 * above))}% of this plane. The line is found on the model for each value of ${esc(labelOf(app, y))}. ${here.length ? `The dots are the cases, by ${esc(heading)}: ${here.map((p) => `${esc(p.c.label)} gives ${esc(fmt(p.vz))}`).join(" · ")}.` : ""}</p>`,
  };
}

function compareChart(app, e) {
  const { model, factors } = app.previewed;
  const { base, list, heading } = casesOf(app, e);
  const cases = list.length ? list : [{ key: "model", label: "the model", overrides: new Map() }];
  const answers = app.state.doc.outputs.filter((o) => drawable(app).includes(o));
  const table = cases.map((c) => {
    const v = at(model, factors, new Map([...base, ...c.overrides]), answers);
    return [c.label, ...answers.map((a) => v.get(a) ?? null)];
  });
  const rows = [[heading[0].toUpperCase() + heading.slice(1), ...answers.map((a) => `${labelOf(app, a)}${unitOf(app, a) ? ` (${unitOf(app, a)})` : ""}`)], ...table];
  const sum = e.outputs[0];
  const split = sum ? breakdown(model, factors, { base, output: sum, cases }) : null;
  let svg = "";
  let title = "The answers in each case";
  let notes = "";
  let legendHtml = "";
  if (split && split.parts.length > 1) {
    const against = e.against && drawable(app).includes(e.against) ? e.against : null;
    const againstValues = against ? cases.map((c) => at(model, factors, new Map([...base, ...c.overrides]), [against]).get(against) ?? null) : [];
    const tops = split.cases.map((c) => (c.values ?? []).filter((v) => v > 0).reduce((a, b) => a + b, 0));
    const bottoms = split.cases.map((c) => (c.values ?? []).filter((v) => v < 0).reduce((a, b) => a + b, 0));
    const [y0, y1] = extent([...tops, ...bottoms, 0, ...againstValues.filter(Number.isFinite)]);
    const band = (W - M.left - M.right) / cases.length;
    const bw = Math.min(40, band * 0.5);
    const sy = (v) => H - M.bottom - ((v - y0) / (y1 - y0)) * (H - M.top - M.bottom);
    const cx = (i) => M.left + band * (i + 0.5);
    const partText = (p) => app.state.doc.nodes.find((n) => n.name === sum)?.formula && p.tree ? treeText(p.tree) : "";
    const bars = split.cases.map((c, i) => {
      if (!c.values) return "";
      let up = 0;
      let down = 0;
      const segs = c.values.map((v, j) => {
        if (!Number.isFinite(v) || v === 0) return "";
        const from = v > 0 ? up : down;
        const to = from + v;
        if (v > 0) up = to; else down = to;
        const top = sy(Math.max(from, to));
        const height = Math.max(0, Math.abs(sy(from) - sy(to)) - 2);
        return `<rect class="seg s${j + 1}" x="${cx(i) - bw / 2}" y="${top + 1}" width="${bw}" height="${height}" rx="2"><title>${esc(`${c.label}: ${partText(split.parts[j])} = ${fmt(v)}`)}</title></rect>`;
      }).join("");
      const ref = against && Number.isFinite(againstValues[i]) ? `<line class="against" x1="${cx(i) - bw}" x2="${cx(i) + bw}" y1="${sy(againstValues[i])}" y2="${sy(againstValues[i])}"><title>${esc(`${labelOf(app, against)}: ${fmt(againstValues[i])}`)}</title></line>` : "";
      const gap = against && Number.isFinite(againstValues[i]) && Number.isFinite(c.total) ? againstValues[i] - c.total : null;
      const note = gap === null ? `<text class="direct" x="${cx(i)}" y="${sy(up) - 8}" text-anchor="middle">${esc(fmt(c.total))}</text>` : `<text class="direct" x="${cx(i)}" y="${Math.min(sy(up), sy(againstValues[i])) - 8}" text-anchor="middle">${esc(`${gap >= 0 ? "under by" : "over by"} ${fmt(Math.abs(gap))}`)}</text>`;
      return `${segs}${ref}${note}<text class="tick" x="${cx(i)}" y="${H - M.bottom + 18}" text-anchor="middle">${esc(clip(c.label, Math.max(8, Math.floor(band / 7))))}</text>`;
    }).join("");
    const grid = niceTicks(y0, y1).map((v) => `<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${sy(v)}" y2="${sy(v)}"/><text class="tick" x="${M.left - 8}" y="${sy(v) + 4}" text-anchor="end">${esc(tick(v))}</text>`).join("");
    legendHtml = `<ul class="chart-legend">${split.parts.map((p, j) => `<li><i class="sw s${j + 1}"></i><code>${esc(`${p.sign < 0 ? "less " : ""}${treeText(p.tree)}`)}</code></li>`).join("")}${against ? `<li><i class="sw against"></i>${esc(labelOf(app, against))}</li>` : ""}<li class="note">Along the bottom: ${esc(heading)}.</li></ul>`;
    title = `${labelOf(app, sum)}, in its parts${against ? `, against ${labelOf(app, against)}` : ""}`;
    svg = `${svgOpen(title)}${grid}<line class="axis" x1="${M.left}" x2="${W - M.right}" y1="${sy(0)}" y2="${sy(0)}"/><text class="axis-label" transform="translate(16 ${(M.top + H - M.bottom) / 2}) rotate(-90)" text-anchor="middle">${esc(clip(`${labelOf(app, sum)}${unitOf(app, sum) ? ` (${unitOf(app, sum)})` : ""}`, 46))}</text>${bars}</svg>`;
    rows.push([], [`${labelOf(app, sum)}, in its parts`, ...split.parts.map((p) => `${p.sign < 0 ? "less " : ""}${treeText(p.tree)}`), ...(against ? [labelOf(app, against)] : [])], ...split.cases.map((c, i) => [c.label, ...(c.values ?? []), ...(against ? [againstValues[i]] : [])]));
  } else if (sum) {
    notes = `<p class="note"><code>${esc(sum)}</code> is not a sum of terms, so it has no parts to show. Pick an answer whose formula adds things up, such as a total.</p>`;
  }
  const legendItems = split && split.parts.length > 1
    ? [...split.parts.map((p, j) => ({ slot: j + 1, text: `${p.sign < 0 ? "less " : ""}${treeText(p.tree)}` })), ...(e.against ? [{ against: true, text: labelOf(app, e.against) }] : [])]
    : [];
  return { title, svg, rows, notes, legendHtml, legendItems, table: rows.slice(0, cases.length + 1) };
}

/* A formula term, written back as text for a legend. */
function treeText(t) {
  switch (t.op) {
    case "const": return String(t.value);
    case "ref": return t.name;
    case "neg": return `-${treeText(t.args[0])}`;
    case "call": return `${t.fn}(${t.args.map(treeText).join(", ")})`;
    default: {
      const wrap = (a) => (a.op === "+" || a.op === "-" ? `(${treeText(a)})` : treeText(a));
      return `${wrap(t.args[0])} ${t.op} ${wrap(t.args[1])}`;
    }
  }
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// -- the view --------------------------------------------------------------------------------------

export function drawExplore(app) {
  const wrap = $("explore-view");
  const on = app.ui.view === "explore";
  wrap.hidden = !on;
  if (!on) return;
  if (app.state.pending.length || !app.previewed?.model?.order) {
    wrap.innerHTML = `<p class="note">Define everything the answers rest on first: a chart needs every number the model uses.</p>`;
    return;
  }
  const inputs = movable(app);
  const answers = drawable(app);
  if (!inputs.length || !answers.length) {
    wrap.innerHTML = `<p class="note">A chart needs a given number to move and an answer to draw.</p>`;
    return;
  }
  const e = (app.ui.explore ??= { kind: "sweep", cases: "scenarios", target: 0, typed: {} });
  if (!inputs.includes(e.x)) e.x = inputs.find((n) => rangeOf(app, e, n, "x")) ?? inputs[0];
  if (!inputs.includes(e.y) || e.y === e.x) e.y = inputs.find((n) => n !== e.x && rangeOf(app, e, n, "y")) ?? inputs.find((n) => n !== e.x) ?? null;
  e.outputs = (e.outputs ?? []).filter((o) => answers.includes(o));
  if (!e.outputs.length) e.outputs = [answers[0]];
  if (!e.base || !app.state.scenarios.some((s) => s.scenario === e.base)) e.base = app.state.scenarios[0]?.scenario ?? "reference";
  if (e.caseInput && !inputs.includes(e.caseInput)) e.caseInput = null;

  const chart = e.kind === "plane" ? (e.y ? planeChart(app, e) : { error: "A plane needs two inputs to move." }) : e.kind === "compare" ? compareChart(app, e) : sweepChart(app, e);
  app.explore = chart.rows ? { title: chart.title, rows: chart.rows } : null;

  const option = (v, text, sel) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(text)}</option>`;
  const pick = (id, label, list, sel, extra = "") => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${extra}${list.map((n) => option(n, `${labelOf(app, n)}${unitOf(app, n) ? ` (${unitOf(app, n)})` : ""}`, sel)).join("")}</select></div>`;
  const sameUnit = answers.filter((a) => nodeOf(app, a)?.unit === nodeOf(app, e.outputs[0])?.unit && a !== e.outputs[0]);
  const controls = [
    pick("x-out", e.kind === "compare" ? "Split this answer into its parts" : "Answer", answers, e.outputs[0]),
    e.kind === "sweep" ? `<div class="field"><label for="x-also">And draw beside it</label><select id="x-also">${option("", "nothing else", e.outputs[1] ?? "")}${sameUnit.map((a) => option(a, labelOf(app, a), e.outputs[1] ?? "")).join("")}</select></div>` : "",
    e.kind === "compare" ? `<div class="field"><label for="x-against">Against</label><select id="x-against">${option("", "nothing", e.against ?? "")}${sameUnit.map((a) => option(a, labelOf(app, a), e.against ?? "")).join("")}</select></div>` : "",
    e.kind !== "compare" ? pick("x-x", e.kind === "plane" ? "Across" : "Moving", inputs, e.x) : "",
    e.kind === "plane" ? pick("x-y", "And up", inputs.filter((n) => n !== e.x), e.y) : "",
    e.kind !== "compare" ? `<div class="field"><label for="x-target">${e.kind === "plane" ? "The line is where the answer is" : "Mark where it meets"}</label><input id="x-target" inputmode="decimal" value="${e.target === null ? "" : esc(String(e.target))}" placeholder="nothing"></div>` : "",
  ].join("");
  const caseControls = `<div class="field"><label for="x-cases">${{ plane: "A dot for each", compare: "A bar for each", sweep: "A line for each" }[e.kind]}</label><select id="x-cases">${option("scenarios", "scenario", e.cases)}${option("values", "value of an input", e.cases)}${option("written", "case you write", e.cases)}</select></div>
    ${e.cases === "written" ? `<div class="field wide"><label for="x-written">The cases, one a line</label><textarea id="x-written" class="mono" rows="4" placeholder="${esc(`brochure: ${inputs.slice(0, 2).map((n) => `${n} = …`).join(", ")}`)}">${esc(e.written ?? "")}</textarea><span class="hint">A label, a colon, then what the case changes: <code>name = number</code>, separated by commas. Each is on top of the scenario beside. A line with nothing after its colon is that scenario as it stands.${(() => { const { problems } = parseCases(e.written, inputs); return problems.length ? ` <span style="color:var(--bad)">${esc(problems.join("; "))}.</span>` : ""; })()}</span></div>
      <div class="field"><label for="x-base">On top of the scenario</label><select id="x-base">${app.state.scenarios.map((s) => option(s.scenario, s.scenario, e.base)).join("")}</select></div>` : ""}
    ${e.cases === "values" ? `${pick("x-case-input", "Input", inputs, e.caseInput ?? "", e.caseInput ? "" : option("", "choose one", ""))}
      <div class="field"><label for="x-values">Its values</label><input id="x-values" class="mono" value="${esc(e.values ?? "")}" placeholder="${esc(e.caseInput ? valuesInFiles(app, e.caseInput).map(fmt).join(", ") : "")}"><span class="hint">Separated by commas. ${e.caseInput ? `The files give it ${esc(valuesInFiles(app, e.caseInput).map(fmt).join(", ") || "no value")}.` : ""}</span></div>
      <div class="field"><label for="x-base">On top of the scenario</label><select id="x-base">${app.state.scenarios.map((s) => option(s.scenario, s.scenario, e.base)).join("")}</select></div>` : ""}`;
  const need = chart.needsRange;
  const rangeAsk = need ? `<div class="verdict warn">${esc(labelOf(app, need))} declares no range, so there is nothing to draw it across. Give the two ends; the builder will not choose them.
      <div class="grid2" style="margin-top:8px"><div class="field"><label for="x-lo">From</label><input id="x-lo" inputmode="decimal"></div><div class="field"><label for="x-hi">To</label><input id="x-hi" inputmode="decimal"></div></div>
      <label class="row" style="width:auto"><input type="checkbox" id="x-save" style="width:auto"> Save it as the input's <code>range:</code> in the file, so the chart can be drawn again from it</label>
      <button type="button" id="x-range">Draw it</button></div>` : "";
  const tableRows = chart.rows ?? [];
  const numbers = tableRows.length ? `<details class="numbers"><summary>The numbers</summary><div class="table-wrap"><table class="sheet">${tableRows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th scope="col">${esc(c)}</th>` : `<td class="${typeof c === "number" ? "num mono" : ""}">${esc(typeof c === "number" ? fmt(c) : c ?? "—")}</td>`)).join("")}</tr>`).join("")}</table></div></details>` : "";
  wrap.innerHTML = `<div class="kinds" role="group" aria-label="Which chart">
      ${[["sweep", "Sweep one input"], ["plane", "Two inputs"], ["compare", "Compare cases"]].map(([k, t]) => `<button type="button" data-kind="${k}" aria-pressed="${e.kind === k}">${t}</button>`).join("")}
    </div>
    <p class="why">${e.kind === "sweep" ? "One input moved across its range, everything else as the case has it: where a line crosses the mark is a break-even." : e.kind === "plane" ? "Two inputs at once: the line is where the answer meets its mark, and the shaded side is above it. A dot is where each case sits." : "The answers in each case, and an answer that adds things up, split into what it adds."} ${chapters(["which_input_is_the_answer", "the_sellers_tco"])}</p>
    <div class="explore-controls">${controls}${caseControls}</div>
    ${rangeAsk}
    ${chart.error ? `<p class="note">${esc(chart.error)}</p>` : ""}
    ${chart.range?.typed ? `<p class="note">Drawn across the range you gave: ${esc(fmt(chart.range.lo))} to ${esc(fmt(chart.range.hi))}. <button type="button" class="link" id="x-forget">Forget it</button></p>` : ""}
    ${chart.svg ? `<figure class="chartbox"><figcaption>${esc(chart.title)}</figcaption><div class="plot">${chart.svg}<div class="tip" hidden></div></div>${chart.legendHtml ?? ""}</figure>` : ""}
    ${chart.notes ?? ""}
    ${e.kind === "compare" && chart.table ? `<div class="table-wrap"><table class="sheet">${chart.table.map((r, i) => `<tr>${r.map((c, j) => (i === 0 ? `<th scope="col">${esc(c)}</th>` : j === 0 ? `<th scope="row">${esc(c)}</th>` : `<td class="num mono">${esc(fmt(c))}</td>`)).join("")}</tr>`).join("")}</table></div>` : ""}
    ${chart.svg ? `<div class="row"><button type="button" id="x-svg">Download the chart (SVG)</button><button type="button" id="x-copy">Copy the numbers</button><span class="note" id="x-msg" aria-live="polite"></span></div>` : ""}
    ${e.kind === "compare" ? "" : numbers}`;
  wire(app, wrap, e, chart);
}

function wire(app, wrap, e, chart) {
  const redraw = () => drawExplore(app);
  for (const b of wrap.querySelectorAll("[data-kind]")) b.addEventListener("click", () => { e.kind = b.dataset.kind; redraw(); });
  const on = (id, fn) => wrap.querySelector(`#${id}`)?.addEventListener("change", (ev) => { fn(ev.target.value, ev.target); redraw(); });
  on("x-out", (v) => { e.outputs = [v, ...(e.outputs.slice(1).filter((o) => o !== v))]; });
  on("x-also", (v) => { e.outputs = v ? [e.outputs[0], v] : [e.outputs[0]]; });
  on("x-against", (v) => { e.against = v || null; });
  on("x-x", (v) => { e.x = v; });
  on("x-y", (v) => { e.y = v; });
  on("x-target", (v) => { const t = v.trim() === "" ? null : Number(v); e.target = t === null || Number.isFinite(t) ? t : e.target; });
  on("x-cases", (v) => { e.cases = v; });
  on("x-case-input", (v) => { e.caseInput = v || null; if (!e.values && v) e.values = valuesInFiles(app, v).join(", "); });
  on("x-values", (v) => { e.values = v; });
  on("x-written", (v) => { e.written = v; });
  on("x-base", (v) => { e.base = v; });
  wrap.querySelector("#x-forget")?.addEventListener("click", () => { e.typed = {}; redraw(); });
  wrap.querySelector("#x-range")?.addEventListener("click", () => {
    const lo = Number(wrap.querySelector("#x-lo").value);
    const hi = Number(wrap.querySelector("#x-hi").value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return;
    const name = chart.needsRange;
    const axis = chart.axis ?? "x";
    if (wrap.querySelector("#x-save").checked) {
      const node = nodeOf(app, name);
      if (node) {
        node.range = [Math.min(lo, hi), Math.max(lo, hi)];
        app.commit();
        return;
      }
    }
    e.typed = { ...(e.typed ?? {}), [`${axis}:${name}`]: [Math.min(lo, hi), Math.max(lo, hi)] };
    redraw();
  });
  const msg = wrap.querySelector("#x-msg");
  wrap.querySelector("#x-svg")?.addEventListener("click", () => {
    const svg = wrap.querySelector("svg.chart");
    const url = URL.createObjectURL(new Blob([standalone(svg, chart.legendItems ?? [])], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${app.state.doc.model || "model"}-${e.kind}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg.textContent = `Downloaded ${a.download}.`;
  });
  wrap.querySelector("#x-copy")?.addEventListener("click", async () => {
    const text = (chart.rows ?? []).map((r) => r.map((c) => String(c ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = "Copied. It pastes into a spreadsheet as columns.";
    } catch {
      msg.textContent = "The browser would not copy. Open “The numbers” and copy the table instead.";
    }
  });
  if (chart.hover) hover(wrap, chart.hover);
}

/* The sweep's crosshair: the nearest drawn x, and every line's value there. */
function hover(wrap, h) {
  const svg = wrap.querySelector("svg.chart");
  const hit = svg?.querySelector(".hit");
  const line = svg?.querySelector(".crosshair");
  const tip = wrap.querySelector(".tip");
  if (!hit || !line || !tip) return;
  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * W;
    let best = 0;
    h.xs.forEach((v, i) => { if (Math.abs(h.sx(v) - vx) < Math.abs(h.sx(h.xs[best]) - vx)) best = i; });
    const px = h.sx(h.xs[best]);
    line.setAttribute("x1", px);
    line.setAttribute("x2", px);
    line.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tip-head";
    head.textContent = `${h.xLabel} ${fmt(h.xs[best])}`;
    tip.append(head);
    for (const s of h.series) {
      const row = document.createElement("div");
      const value = document.createElement("strong");
      value.textContent = fmt(s.ys[best]);
      row.append(value, ` ${s.label}`);
      tip.append(row);
    }
    const left = (px / W) * box.width;
    tip.style.left = `${Math.min(Math.max(8, left + 12), box.width - tip.offsetWidth - 8)}px`;
  };
  hit.addEventListener("pointermove", (ev) => show(ev.clientX));
  hit.addEventListener("pointerleave", () => { line.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

/* The chart as a file of its own: its colours written in, since the page's style sheet stays behind,
 * and its key, where the page shows the key beside it, written in below. */
function standalone(svg, legend) {
  const copy = svg.cloneNode(true);
  copy.querySelector(".hit")?.remove();
  copy.querySelector(".crosshair")?.remove();
  const live = [...svg.querySelectorAll("*")].filter((el) => !el.classList.contains("hit") && !el.classList.contains("crosshair"));
  [...copy.querySelectorAll("*")].forEach((el, i) => {
    const cs = getComputedStyle(live[i]);
    for (const prop of ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-family", "font-weight"]) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== "none" || prop === "fill") el.setAttribute(prop, v);
    }
  });
  const root = getComputedStyle(document.documentElement);
  const ink = root.getPropertyValue("--ink").trim();
  const extra = legend.length * 18 + (legend.length ? 12 : 0);
  copy.setAttribute("viewBox", `0 0 ${W} ${H + extra}`);
  legend.forEach((item, i) => {
    const y = H + 8 + i * 18;
    const mark = item.against
      ? `<line x1="${M.left}" x2="${M.left + 14}" y1="${y + 6}" y2="${y + 6}" stroke="${ink}" stroke-width="2" stroke-dasharray="5 3"/>`
      : `<rect x="${M.left}" y="${y}" width="12" height="12" rx="2" fill="${root.getPropertyValue(`--s${item.slot}`).trim()}"/>`;
    copy.insertAdjacentHTML("beforeend", `${mark}<text x="${M.left + 20}" y="${y + 10}" font-size="12" font-family="${root.getPropertyValue("--sans").trim()}" fill="${ink}">${esc(item.text)}</text>`);
  });
  const bg = getComputedStyle(document.body).backgroundColor;
  copy.insertAdjacentHTML("afterbegin", `<rect width="${W}" height="${H + extra}" fill="${bg}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${copy.outerHTML}`;
}
