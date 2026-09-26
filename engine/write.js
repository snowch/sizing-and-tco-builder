/*
 * Writing a model file: the book's format, laid out as the book lays its models out.
 *
 * The builder keeps a model as a plain document (below) and writes it as YAML the book's PyYAML
 * reads back to the same values. That is stricter than it sounds, because PyYAML is a YAML 1.1
 * reader: `1e-07` is a string to it (a float needs a dot), `yes` is true, `010` is eight. So a
 * number is always written in a form PyYAML reads as a float, and a string is left plain only when
 * PyYAML's own resolvers would read it back as a string.
 *
 * A document:
 *
 *   { model, title, currency, description,
 *     nodes: [{ name, kind, unit, label, note,
 *               decided, value, distribution: { shape, parameters } | null,
 *               provenance: { kind, source }, range: [low, high] | null,     (input)
 *               formula,                                                    (derived)
 *               result,                                                     (measured)
 *               of, limit, headroom, because }],                            (ceiling)
 *     outputs: [name], correlations: [{ a, b, rho, because }] }
 *
 * A scenario: { scenario, title, because, samples, seed, overrides: { name: number } }.
 */

import { oneShape } from "./evaluate.js";
import { floatRepr, isDict, isInt, str } from "./python.js";

const WIDTH = 96;

/* A model the document cannot hold, so the builder cannot write it: it offers nothing it cannot write. */
export class Unwritable extends Error {}

// PyYAML's implicit resolvers, the ones a plain string could be mistaken for (yaml.js has them all).
const LOOKS_TYPED = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:<<)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?/,
  /^(?:=)$/,
];

/* A string as a YAML scalar PyYAML reads back as exactly this string. */
export function scalar(text) {
  const s = String(text);
  const safe =
    /^[A-Za-z_][A-Za-z0-9_ .,/()*+\-'’—–;]*$/u.test(s) &&
    !/\s$/.test(s) &&
    !s.includes(": ") &&
    !s.includes(" #") &&
    !LOOKS_TYPED.some((pattern) => pattern.test(s));
  return safe ? s : quoted(s);
}

/* A double-quoted scalar. JSON's escapes are YAML's, for everything JSON.stringify produces. */
export function quoted(text) {
  // JSON leaves these three unescaped; YAML reads each as a line break inside quotes.
  return JSON.stringify(String(text)).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/* A number PyYAML reads back as this float: always with a dot, and a signed exponent. */
export function number(x) {
  if (typeof x !== "number") throw new TypeError(`not a number: ${x}`);
  if (Number.isNaN(x)) return ".nan";
  if (x === Infinity) return ".inf";
  if (x === -Infinity) return "-.inf";
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  const repr = floatRepr(x);
  const [mantissa, exponent] = repr.split("e");
  if (exponent === undefined) return repr;
  return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}e${exponent}`;
}

/*
 * Prose that reads well folded, and folds back to exactly itself; else one quoted line.
 *
 * In a folded block a single line break becomes a space and a blank line becomes a line break,
 * so each paragraph is wrapped at single spaces and paragraphs are separated by a blank line.
 * Anything that would not fold back exactly (leading or trailing space, a run of spaces, a tab,
 * a character YAML treats as a line break) is written quoted instead.
 */
function prose(text, indent) {
  const s = String(text);
  const pad = " ".repeat(indent);
  const paragraphs = s.split("\n");
  const foldable =
    s.length > 0 &&
    !/^\s|\s$/.test(s) &&
    !/[\r\t]/.test(s) &&
    paragraphs.every((p) => p === "" || (!/^ | $| {2}/.test(p) && /^[\p{L}\p{N}\p{P}\p{S} ]*$/u.test(p))) &&
    ![...s].some((c) => (c.charCodeAt(0) < 0x20 && c !== "\n") || "\u0085\u2028\u2029\ufeff".includes(c));
  if (!foldable) return quoted(s);
  if (paragraphs.length === 1 && s.length + indent <= WIDTH && scalar(s) === s) return s;
  const blocks = paragraphs.map((paragraph) => {
    if (!paragraph) return [];
    const lines = [];
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + 1 + word.length + indent > WIDTH) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines.map((l) => pad + l);
  });
  const body = [];
  blocks.forEach((lines, i) => {
    if (i) body.push("");
    body.push(...lines);
  });
  return `>-\n${body.join("\n")}`;
}

function flowNumbers(values) {
  return `[${values.map(number).join(", ")}]`;
}

function distribution(d) {
  const inner = Object.entries(d.parameters)
    .map(([k, v]) => `${k}: ${number(v)}`)
    .join(", ");
  return `{${d.shape}: {${inner}}}`;
}

/* The document as the book's model file. */
export function writeModel(doc) {
  const out = [];
  if (doc.dsl !== undefined && doc.dsl !== null) out.push(`dsl: ${scalar(doc.dsl)}`);
  out.push(`model: ${scalar(doc.model)}`);
  if (doc.title !== undefined && doc.title !== null) out.push(`title: ${prose(doc.title, 2)}`);
  out.push(`currency: ${scalar(doc.currency ?? "USD")}`);
  if (doc.description) out.push("", `description: ${prose(doc.description, 2)}`);
  out.push("", "nodes:");
  for (const node of doc.nodes) {
    out.push("", `  ${scalar(node.name)}:`, `    kind: ${node.kind}`);
    if (node.kind === "input") out.push(`    decided: ${scalar(node.decided)}`);
    out.push(`    unit: ${scalar(node.unit)}`);
    if (node.label !== undefined && node.label !== null) out.push(`    label: ${prose(node.label, 6)}`);
    if (node.kind === "input") {
      if (node.value !== null && node.value !== undefined) out.push(`    value: ${number(node.value)}`);
      if (node.distribution) out.push(`    distribution: ${distribution(node.distribution)}`);
    }
    if (node.note !== undefined && node.note !== null) out.push(`    note: ${prose(node.note, 6)}`);
    if (node.kind === "input") {
      out.push("    provenance:", `      kind: ${scalar(node.provenance.kind)}`, `      source: ${prose(node.provenance.source, 8)}`);
      if (node.range) out.push(`    range: ${flowNumbers(node.range)}`);
    } else if (node.kind === "derived") {
      out.push(`    formula: ${scalar(node.formula)}`);
    } else if (node.kind === "measured") {
      out.push(`    result: ${scalar(node.result)}`);
    } else {
      out.push(`    of: ${scalar(node.of)}`, `    limit: ${scalar(node.limit)}`);
      if (node.headroom !== null && node.headroom !== undefined && node.headroom !== "") out.push(`    headroom: ${scalar(node.headroom)}`);
      out.push(`    because: ${prose(node.because, 6)}`);
    }
  }
  if (!doc.outputs.length) out.push("", "outputs: []");
  else out.push("", "outputs:", ...doc.outputs.map((name) => `  - ${scalar(name)}`));
  if (doc.correlations?.length) {
    out.push("", "correlations:");
    for (const pair of doc.correlations) {
      out.push(`  - a: ${scalar(pair.a)}`, `    b: ${scalar(pair.b)}`, `    rho: ${number(pair.rho)}`);
      if (pair.because !== undefined && pair.because !== null) out.push(`    because: ${prose(pair.because, 6)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/* A scenario document as the book's scenario file. */
export function writeScenario(doc) {
  const out = [`scenario: ${scalar(doc.scenario)}`, `title: ${prose(doc.title ?? doc.scenario, 2)}`];
  if (doc.because) out.push(`because: ${prose(doc.because, 2)}`);
  out.push(`samples: ${doc.samples ?? 100000}`, `seed: ${doc.seed ?? 20260916}`);
  const overrides = Object.entries(doc.overrides ?? {});
  if (!overrides.length) out.push("overrides: {}");
  else out.push("overrides:", ...overrides.map(([name, value]) => `  ${scalar(name)}: ${number(value)}`));
  return `${out.join("\n")}\n`;
}

// -- from a loaded model back to a document --------------------------------------------------------

/* A text field as the loaded model holds it: the book str()s most fields, not the label or note. */
function text(value) {
  return value === null || value === undefined ? null : str(value);
}

function numberOf(value) {
  if (isInt(value)) return Number(value.value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/*
 * A loaded model (model.js) as a document. What the book's loader keeps, this keeps; what it
 * ignores (comments, fields it does not read) is not kept, because it is not part of the model.
 */
export function documentFrom(model) {
  const nodes = [];
  for (const [name, node] of model.nodes) {
    const common = { name, kind: node.kind, unit: node.unit, label: text(node.label), note: text(node.note) };
    if (node.kind === "input") {
      let dist = null;
      if (node.distribution !== null) {
        let shape;
        try {
          [shape] = oneShape(node.distribution);
        } catch (error) {
          throw new Unwritable(`input '${name}': ${error.message}`);
        }
        const params = node.distribution.get(shape);
        dist = { shape, parameters: Object.fromEntries([...params].map(([k, v]) => [k, numberOf(v)])) };
      }
      nodes.push({
        ...common,
        decided: node.decided,
        value: node.value,
        distribution: dist,
        provenance: { ...node.provenance },
        range: node.slider,
      });
    } else if (node.kind === "derived") nodes.push({ ...common, formula: node.formulaText });
    else if (node.kind === "measured") nodes.push({ ...common, result: node.result });
    else {
      nodes.push({ ...common, of: node.ofText, limit: node.limitText, headroom: node.headroomText, because: node.because });
    }
  }
  const correlations = model.correlations.map((pair) => {
    if (!isDict(pair) || !["a", "b", "rho"].every((k) => pair.has(k)) || typeof numberOf(pair.get("rho")) !== "number") {
      throw new Unwritable("a correlation needs a, b and a number rho");
    }
    const out = { a: str(pair.get("a")), b: str(pair.get("b")), rho: numberOf(pair.get("rho")) };
    if (pair.has("because")) out.because = text(pair.get("because"));
    return out;
  });
  return {
    model: model.name,
    title: model.title,
    currency: model.currency,
    description: model.description,
    nodes,
    outputs: [...model.outputs],
    correlations,
  };
}

export function scenarioDocumentFrom(scenario) {
  return {
    scenario: scenario.name,
    title: scenario.title,
    because: scenario.because,
    samples: scenario.samples,
    seed: scenario.seed,
    overrides: Object.fromEntries(scenario.overrides),
  };
}
