/*
 * Read a model file as the book's PyYAML reads it.
 *
 * The book loads model files with `yaml.safe_load`, a YAML 1.1 reader, and then calls str() and
 * float() on what it gets. So the type of every scalar matters, and YAML 1.1's rules are not the
 * ones most JavaScript readers use: `yes` is true, `1e3` is a string (a float needs a dot), `010`
 * is eight, `1:30` is ninety, and a key written twice keeps its last value without complaint.
 *
 * The `yaml` package (vendored) reads the structure, with every scalar left as text and marked
 * plain or quoted. This file then applies PyYAML's own implicit resolvers and constructors
 * (yaml/resolver.py and yaml/constructor.py), in PyYAML's order, to decide what each scalar is.
 */

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "../vendor/yaml/index.js";

import { PyError, pyInt } from "./python.js";

export class YamlError extends Error {}

// yaml/resolver.py, as regular expressions over the scalar's text, in the order PyYAML tries them.
const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const MERGE = /^(?:<<)$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const TIMESTAMP = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;
const VALUE = /^(?:=)$/;

/* Each resolver is tried only for the first characters PyYAML registered it under. */
const RESOLVERS = [
  ["bool", BOOL, "yYnNtTfFoO"],
  ["float", FLOAT, "-+0123456789."],
  ["int", INT, "-+0123456789"],
  ["merge", MERGE, "<"],
  ["null", NULL, "~nN"],
  ["timestamp", TIMESTAMP, "0123456789"],
  ["value", VALUE, "="],
];

function resolve(text) {
  if (text === "") return "null";
  for (const [tag, pattern, first] of RESOLVERS) {
    if (first.includes(text[0]) && pattern.test(text)) return tag;
  }
  return "str";
}

function sexagesimal(text, parse) {
  let value = 0;
  let base = 1;
  for (const digit of text.split(":").reverse()) {
    value += parse(digit) * base;
    base *= 60;
  }
  return value;
}

/* yaml/constructor.py SafeConstructor, for the scalar tags. */
function construct(tag, text) {
  switch (tag) {
    case "null":
      return null;
    case "bool":
      return ["yes", "true", "on"].includes(text.toLowerCase());
    case "int": {
      let v = text.replaceAll("_", "");
      let sign = 1n;
      if (v[0] === "-") sign = -1n;
      if ("+-".includes(v[0])) v = v.slice(1);
      let value;
      if (v === "0") value = 0n;
      else if (v.startsWith("0b")) value = BigInt(`0b${v.slice(2)}`);
      else if (v.startsWith("0x")) value = BigInt(`0x${v.slice(2)}`);
      else if (v[0] === "0") value = BigInt(`0o${v.slice(1)}`);
      else if (v.includes(":")) value = BigInt(sexagesimal(v, Number));
      else value = BigInt(v);
      return pyInt(sign * value);
    }
    case "float": {
      let v = text.replaceAll("_", "").toLowerCase();
      let sign = 1;
      if (v[0] === "-") sign = -1;
      if ("+-".includes(v[0])) v = v.slice(1);
      if (v === ".inf") return sign * Infinity;
      if (v === ".nan") return NaN;
      if (v.includes(":")) return sign * sexagesimal(v, Number);
      return sign * Number(v);
    }
    case "timestamp":
      return { py: "date", text: text.length === 10 ? text : text.replace(/[Tt]/, " ") };
    case "str":
      return text;
    default:
      throw new YamlError(`could not determine a constructor for the tag '${tag}'`);
  }
}

const EXPLICIT = {
  "tag:yaml.org,2002:str": "str",
  "tag:yaml.org,2002:int": "int",
  "tag:yaml.org,2002:float": "float",
  "tag:yaml.org,2002:bool": "bool",
  "tag:yaml.org,2002:null": "null",
  "tag:yaml.org,2002:timestamp": "timestamp",
};

/* A hashable key, for a Map: PyYAML refuses a list or a dict as a key. */
function key(value) {
  if (Array.isArray(value) || value instanceof Map) {
    throw new YamlError("found unhashable key while constructing a mapping");
  }
  // Python's dict treats 1, 1.0 and True as the same key. Rare enough in a model file to leave.
  return value;
}

function build(node, doc, seen = new Set()) {
  if (node === null || node === undefined) return null;
  if (isAlias(node)) {
    const target = node.resolve(doc);
    if (!target) throw new YamlError(`found undefined alias ${node.source}`);
    if (seen.has(target)) throw new YamlError("found a recursive alias");
    return build(target, doc, new Set([...seen, target]));
  }
  if (isScalar(node)) {
    const text = String(node.value ?? "");
    if (node.tag && node.tag !== "!") {
      if (!(node.tag in EXPLICIT)) throw new YamlError(`could not determine a constructor for the tag '${node.tag}'`);
      return construct(EXPLICIT[node.tag], text);
    }
    if (node.type === "PLAIN") return construct(resolve(text), text);
    return text;
  }
  if (isSeq(node)) return node.items.map((item) => build(item, doc, seen));
  if (isMap(node)) {
    const out = new Map();
    const merged = [];
    for (const pair of node.items) {
      const k = pair.key;
      const plainMerge = isScalar(k) && k.type === "PLAIN" && !k.tag && k.value === "<<";
      if (plainMerge) {
        const value = pair.value === null ? null : build(pair.value, doc, seen);
        const sources = Array.isArray(value) ? value : [value];
        for (const source of sources) {
          if (!(source instanceof Map)) throw new YamlError("expected a mapping for merging");
          merged.push(source);
        }
        continue;
      }
      out.set(key(build(k, doc, seen)), build(pair.value, doc, seen));
    }
    if (!merged.length) return out;
    // PyYAML's flatten_mapping: the merged mappings go first, the last source first, so an
    // earlier source overrides a later one; then the mapping's own keys override them all. A
    // Python dict keeps a key where it was first set, and so does a Map.
    const result = new Map();
    for (const source of [...merged].reverse()) for (const [k, v] of source) result.set(k, v);
    for (const [k, v] of out) result.set(k, v);
    return result;
  }
  throw new YamlError("unsupported YAML node");
}

/* yaml.safe_load: one document, or None for an empty stream. */
export function safeLoad(text) {
  const docs = parseAllDocuments(String(text), {
    version: "1.1",
    schema: "failsafe",
    uniqueKeys: false,
    merge: false,
  });
  if (!docs.length) return null;
  if (docs.length > 1) throw new YamlError("expected a single document in the stream");
  const [doc] = docs;
  if (doc.errors.length) throw new YamlError(doc.errors[0].message);
  try {
    return build(doc.contents, doc);
  } catch (error) {
    if (error instanceof YamlError || error instanceof PyError) throw error;
    throw new YamlError(String(error?.message ?? error));
  }
}
