/*
 * A small .xlsx writer: enough of Office Open XML (ECMA-376) for a workbook of plain sheets with
 * numbers, text, formulas, workbook-level names, column widths and a few styles, zipped with no
 * compression. No library and no network, so the builder stays static files that work offline.
 *
 * A sheet is { name, cols: [widths], rows: [[cell]] }, a cell null, a number, a string, or
 * { v, f, s }: v a cached value (number or string), f a formula without its "=", s a style name.
 * The workbook asks the application to recalculate every formula when it opens.
 */

export const STYLES = ["plain", "head", "title", "note", "given", "vendor", "answer", "code", "wrap"];

const STYLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="General"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF5A6570"/><name val="Calibri"/></font>
<font><sz val="10"/><name val="Consolas"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3EEFB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1E6F8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF9DB7D5"/></left><right style="thin"><color rgb="FF9DB7D5"/></right><top style="thin"><color rgb="FF9DB7D5"/></top><bottom style="thin"><color rgb="FF9DB7D5"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const xml = (s) =>
  String(s)
    // Characters XML 1.0 cannot hold at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/* A1-style column letters for a 0-based index. */
export function column(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/* A number as a spreadsheet writes it: finite, with an upper-case exponent. */
export function number(x) {
  return String(x).toUpperCase();
}

function cellXml(cell, ref) {
  if (cell === null || cell === undefined || cell === "") return "";
  const c = typeof cell === "object" ? cell : { v: cell };
  const s = c.s ? ` s="${Math.max(0, STYLES.indexOf(c.s))}"` : "";
  if (c.f !== undefined) {
    const f = `<f>${xml(c.f)}</f>`;
    if (typeof c.v === "number" && Number.isFinite(c.v)) return `<c r="${ref}"${s}>${f}<v>${number(c.v)}</v></c>`;
    if (typeof c.v === "string") return `<c r="${ref}"${s} t="str">${f}<v>${xml(c.v)}</v></c>`;
    return `<c r="${ref}"${s}>${f}</c>`;
  }
  if (typeof c.v === "number") return Number.isFinite(c.v) ? `<c r="${ref}"${s}><v>${number(c.v)}</v></c>` : "";
  if (c.v === null || c.v === undefined) return s ? `<c r="${ref}"${s}/>` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
}

function sheetXml(sheet) {
  const cols = (sheet.cols ?? []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = sheet.rows
    .map((row, r) => {
      const cells = (row ?? []).map((cell, c) => cellXml(cell, `${column(c)}${r + 1}`)).join("");
      return cells ? `<row r="${r + 1}">${cells}</row>` : "";
    })
    .join("");
  const frozen = sheet.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
}

/* Sheet names: at most 31 characters, none of []:*?/\ , unique. */
function sheetName(name, taken) {
  let base = String(name).replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i += 1) out = `${base.slice(0, 28)} ${i}`;
  taken.add(out.toLowerCase());
  return out;
}

/* The workbook's parts. names: [{ name, ref }] with ref like "'Model'!$C$5". */
export function workbookParts(sheets, names = []) {
  const taken = new Set();
  const titled = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const parts = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${titled.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${titled.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${names.length ? `<definedNames>${names.map((n) => `<definedName name="${xml(n.name)}">${xml(n.ref)}</definedName>`).join("")}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${titled.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${titled.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLE_XML,
  };
  titled.forEach((s, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s); });
  return { parts, sheetNames: titled.map((s) => s.name) };
}

// -- zip, stored (no compression) --------------------------------------------------------------------

let CRC_TABLE = null;
function crc32(bytes) {
  CRC_TABLE ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* A zip of { path: text } in the order given, every entry stored, dated 1 January 1980. */
export function zip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = typeof text === "string" ? encoder.encode(text) : text;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...locals, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function xlsx(sheets, names = []) {
  return zip(workbookParts(sheets, names).parts);
}
