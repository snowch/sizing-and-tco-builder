/*
 * The table: every node of the model in rows, as a spreadsheet shows it, over the same model the
 * graph draws. It is a view of the model, not a second copy of it.
 *
 * A given number can be typed into its cell, and everything worked out from it changes at once.
 * Nothing else can: a worked-out value is its formula's, a measured one is the measurement's, and
 * a unit or a source is changed in the wizard, where the book's rules are asked. So the table
 * cannot add terabytes to dollars, and it cannot hold a number that says nowhere where it came
 * from.
 */

import { NotExportable, workbook } from "../engine/spreadsheet.js";
import { $, esc, fmt, plain } from "./ui.js";
import { DECIDED_WORDS, PROVENANCE_WORDS } from "./words.js";
import { graph } from "./workbench.js";

const KIND_WORDS = { input: "given", derived: "worked out", measured: "measured", ceiling: "ceiling" };

/* What a row says, from the state and the values the page has already worked out. */
export function rows(app) {
  const { state, previewed, ctx } = app;
  const out = [];
  for (const entry of graph(state).values()) {
    const node = entry.node;
    const v = previewed?.values.get(entry.name);
    if (!node) {
      const p = state.pending.find((x) => x.name === entry.name);
      out.push({ name: entry.name, label: p?.label ?? "", kind: "to define", unit: p?.unit ?? "", value: null, shown: "to define", from: "", editable: false });
      continue;
    }
    const row = { name: node.name, label: node.label ?? "", kind: KIND_WORDS[node.kind], unit: node.unit, value: v?.state === "ok" ? v.value : null, shown: shownValue(v), from: "", decided: "", claim: "", vendor: false, editable: false };
    if (node.kind === "input") {
      row.decided = DECIDED_WORDS[node.decided] ?? "";
      row.claim = PROVENANCE_WORDS[node.provenance?.kind] ?? "";
      row.vendor = node.provenance?.kind === "vendor_claim";
      row.from = node.provenance?.source ?? "";
      // One number, or none yet: yours to type. A range has a shape and is changed in the wizard.
      row.editable = node.sure !== "shape";
      if (node.sure === "shape" && node.distribution) {
        row.range = `${node.distribution.shape}: ${Object.entries(node.distribution.parameters).map(([k, x]) => `${k} ${fmt(x)}`).join(", ")}`;
      }
    } else if (node.kind === "derived") row.from = node.formula;
    else if (node.kind === "measured") {
      const result = ctx.results[node.result];
      row.from = result ? `${node.result}, measured on ${result.produced_by?.stack ?? "?"}` : `${node.result}, not taken yet`;
    } else {
      const c = previewed?.ceilings?.[node.name];
      row.from = `${node.of} against ${node.limit}, keeping ${node.headroom}`;
      if (c) row.shown = `${fmt(c.value)} of ${fmt(c.allowed)} allowed: ${c.verdict}`;
    }
    out.push(row);
  }
  return out;
}

function shownValue(v) {
  if (!v) return "";
  if (v.state === "ok") return fmt(v.value);
  return { "to-define": "to define", waits: `waits on ${v.waits} to define`, "not-yet-measured": "not yet measured", unit: "unit problem", formula: "formula does not parse", "unknown-unit": "unknown unit" }[v.state] ?? "cannot be worked out";
}

const COLUMNS = [
  ["name", "Name"],
  ["value", "Value"],
  ["unit", "Unit"],
  ["kind", "Kind"],
  ["decided", "Who decides"],
  ["claim", "Claim"],
  ["from", "Where it comes from"],
];

function ordered(app, list) {
  const { sort = null, desc = false, filter = "", kind = "" } = app.ui.table ?? {};
  const words = filter.trim().toLowerCase();
  let out = list.filter((r) => (!kind || r.kind === kind) && (!words || [r.name, r.label, r.from, r.unit].some((t) => String(t).toLowerCase().includes(words))));
  if (sort) {
    const key = (r) => (sort === "value" ? (r.value ?? -Infinity) : String(r[sort] ?? "").toLowerCase());
    out = [...out].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (desc ? -1 : 1));
  }
  return out;
}

/* The rows as tab-separated text, which any spreadsheet pastes into columns. */
export function asText(list) {
  const clean = (t) => String(t ?? "").replace(/[\t\n\r]+/g, " ");
  const head = ["name", "label", "value", "unit", "kind", "who decides", "claim", "where it comes from"];
  return [head, ...list.map((r) => [r.name, r.label, r.value ?? r.shown, r.unit, r.kind, r.decided, r.claim, r.range ? `${r.from} (${r.range})` : r.from])]
    .map((cells) => cells.map(clean).join("\t"))
    .join("\n");
}

/*
 * The model as an .xlsx file with live formulas, from the files the builder writes. Returns what
 * to tell the reader; the file is refused while the model cannot be worked out.
 */
export function downloadSpreadsheet(app) {
  if (app.state.pending.length) return `Define ${app.state.pending.map((p) => p.name).join(", ")} first: a formula names them.`;
  let bytes;
  try {
    bytes = workbook(app.files, { units: app.ctx.units, results: app.ctx.results, ranges: app.ranges, chart: app.explore });
  } catch (error) {
    if (error instanceof NotExportable) return error.message;
    return `The model file cannot be read yet, so there is nothing to export: ${plain(error.message)}`;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${app.state.doc.model || "model"}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `Downloaded ${a.download}. Its given numbers are shaded; everything else is a live formula over them.`;
}

export function drawTable(app) {
  const wrap = $("table-view");
  const on = app.ui.view === "table";
  wrap.hidden = !on;
  $("graph-wrap").hidden = (app.ui.view ?? "graph") !== "graph";
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === (app.ui.view ?? "graph")));
  if (!on) return;
  // A cell being typed into is not redrawn under the reader; the change redraws it when it lands.
  const focused = document.activeElement?.closest?.("#table-view [data-cell]");
  if (focused?.dataset.dirty) return;
  const t = app.ui.table ?? (app.ui.table = {});
  const all = rows(app);
  const list = ordered(app, all);
  const kinds = [...new Set(all.map((r) => r.kind))];
  wrap.innerHTML = `<div class="tablebar">
      <input id="t-filter" type="search" placeholder="Filter by name, unit, source or formula" value="${esc(t.filter ?? "")}" aria-label="Filter the rows">
      <select id="t-kind" aria-label="Show one kind"><option value="">Every kind</option>${kinds.map((k) => `<option value="${esc(k)}"${t.kind === k ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>
      <button type="button" id="t-copy">Copy as a table</button><button type="button" id="t-xlsx">Download as a spreadsheet</button><span class="note" id="t-msg" aria-live="polite">${esc(t.msg ?? "")}</span>
    </div>
    <p class="note">Type a given number and everything worked out from it changes. Worked-out and measured values come from their formula or measurement, so they cannot be typed over; a unit, a source or a range is changed with Edit.</p>
    <div class="table-wrap"><table class="sheet">
      <thead><tr>${COLUMNS.map(([k, h]) => `<th scope="col"><button type="button" data-sort="${k}" aria-sort="${t.sort === k ? (t.desc ? "descending" : "ascending") : "none"}">${esc(h)}${t.sort === k ? (t.desc ? " ↓" : " ↑") : ""}</button></th>`).join("")}</tr></thead>
      <tbody>${list.map((r) => row(app, r)).join("")}</tbody>
    </table></div>
    ${list.length ? "" : '<p class="note">No rows match.</p>'}`;
  wire(app, wrap, list);
  // Enter moves to the next number; otherwise the cell that had the focus keeps it.
  const target = t.focus ?? focused?.dataset.cell;
  t.focus = null;
  if (target) wrap.querySelector(`[data-cell="${CSS.escape(target)}"]`)?.focus();
}

function row(app, r) {
  const selected = app.ui.selected === r.name;
  const value = r.editable
    ? `<input class="cell mono" data-cell="${esc(r.name)}" inputmode="decimal" autocomplete="off" value="${r.value === null ? "" : esc(String(r.value))}" placeholder="not known yet" aria-label="${esc(r.label || r.name)}, in ${esc(r.unit)}">`
    : `<span class="mono">${esc(r.shown)}</span>${r.range ? `<span class="note">${esc(r.range)}</span>` : ""}`;
  const from = r.kind === "worked out" || r.kind === "ceiling" ? `<code>${esc(r.from)}</code>` : esc(r.from);
  return `<tr data-row="${esc(r.name)}"${selected ? ' aria-selected="true"' : ""} class="${r.vendor ? "vendor" : ""}">
    <th scope="row"><button type="button" class="linkish" data-pick="${esc(r.name)}"><code>${esc(r.name)}</code></button>${r.label ? `<br><span class="note">${esc(r.label)}</span>` : ""}</th>
    <td class="num">${value}</td><td class="mono">${esc(r.unit === "dimensionless" ? "" : r.unit)}</td><td>${esc(r.kind)}</td><td>${esc(r.decided)}</td><td>${esc(r.claim)}</td><td class="from"><span class="clamp" title="${esc(r.from)}">${from}</span></td></tr>`;
}

function wire(app, wrap, list) {
  const t = app.ui.table;
  const msg = wrap.querySelector("#t-msg");
  wrap.querySelector("#t-filter").addEventListener("input", (e) => {
    t.filter = e.target.value;
    const at = e.target.selectionStart;
    drawTable(app);
    const again = $("t-filter");
    again.focus();
    again.setSelectionRange(at, at);
  });
  wrap.querySelector("#t-kind").addEventListener("change", (e) => { t.kind = e.target.value; drawTable(app); });
  for (const b of wrap.querySelectorAll("[data-sort]")) {
    b.addEventListener("click", () => {
      if (t.sort === b.dataset.sort) {
        if (t.desc) { t.sort = null; t.desc = false; } else t.desc = true;
      } else { t.sort = b.dataset.sort; t.desc = false; }
      drawTable(app);
    });
  }
  wrap.querySelector("#t-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(asText(list));
      t.msg = "Copied. It pastes into a spreadsheet as columns.";
      msg.textContent = t.msg;
    } catch {
      t.msg = "The browser would not copy. Select the table and copy it instead.";
      msg.textContent = t.msg;
    }
  });
  wrap.querySelector("#t-xlsx").addEventListener("click", () => {
    t.msg = downloadSpreadsheet(app);
    msg.textContent = t.msg;
  });
  for (const b of wrap.querySelectorAll("[data-pick]")) {
    b.addEventListener("click", () => {
      app.ui.selected = b.dataset.pick;
      app.ui.tab = "node";
      app.render();
    });
  }
  const cells = [...wrap.querySelectorAll("[data-cell]")];
  cells.forEach((cell, i) => {
    cell.addEventListener("input", () => { cell.dataset.dirty = "1"; });
    cell.addEventListener("focus", () => {
      if (app.ui.selected !== cell.dataset.cell) {
        app.ui.selected = cell.dataset.cell;
        for (const tr of wrap.querySelectorAll("tr[data-row]")) tr.toggleAttribute("aria-selected", tr.dataset.row === cell.dataset.cell);
      }
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        delete cell.dataset.dirty;
        drawTable(app);
      } else if (e.key === "Enter") {
        e.preventDefault();
        t.focus = cells[i + (e.shiftKey ? -1 : 1)]?.dataset.cell ?? cell.dataset.cell;
        if (cell.dataset.dirty) commitCell(app, cell);
        else drawTable(app);
      }
    });
    cell.addEventListener("change", () => commitCell(app, cell));
  });
}

/* A typed number becomes the input's one number; an emptied cell makes it not known yet. */
function commitCell(app, cell) {
  if (!cell.dataset.dirty) return;
  delete cell.dataset.dirty;
  const node = app.state.doc.nodes.find((n) => n.name === cell.dataset.cell);
  if (!node) return;
  const text = cell.value.trim().replaceAll(",", "").replaceAll("_", "");
  if (text === "") {
    node.value = null;
    node.sure = "none";
    node.range = null;
  } else {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      app.ui.table.msg = `${cell.dataset.cell}: "${cell.value}" is not a number, so it keeps what it had.`;
      drawTable(app);
      return;
    }
    node.value = value;
    node.sure = "one";
  }
  app.ui.table.msg = "";
  app.commit();
}
