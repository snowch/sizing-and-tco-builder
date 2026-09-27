/*
 * Units, read exactly as the book's Pint registry reads them.
 *
 * The book declares every node's unit as a string and parses it with Pint (sizing/units.py). The
 * builder has to accept and refuse the same strings and give each the same dimensions and the
 * same factor to base units, or it will write files the book refuses. So this is a port of the
 * parts of Pint that decide those three things, and nothing else:
 *
 *   - the registry's preprocessors and Pint's string preprocessor (`per`, `^`, `squared`, a space
 *     meaning multiply, a number stuck to a letter);
 *   - Python's tokenizer, as far as a unit string needs it;
 *   - Pint's tree builder (pint_eval._build_eval_tree), line for line, quirks included;
 *   - its name lookup: an exact key, else every prefix + name + plural reading, the first one
 *     kept, in the order of Pint's own tables.
 *
 * The table is not typed in here. conformance/generate.py reduces the book's pinned registry to
 * conformance/fixtures/units.json, and the unit probes there hold this file to Pint.
 */

import { PyError } from "./python.js";

export class UnitError extends Error {}

/* Python's `\w`, near enough for unit strings: letters, digits and underscore in any script. */
const W = "[\\p{L}\\p{N}_]";
const IDENT = "[_a-zA-Z][_a-zA-Z0-9]*";

/* pint.util._subs_re_list, in order. */
const SUBSTITUTIONS = [
  [/°/gu, "degree"],
  [new RegExp(`(${W}|[.\\-+*\\\\^])\\s+`, "gu"), "$1 "],
  [new RegExp(`(${IDENT}) squared`, "gu"), "$1**2"],
  [new RegExp(`(${IDENT}) cubed`, "gu"), "$1**3"],
  [new RegExp(`cubic (${IDENT})`, "gu"), "$1**3"],
  [new RegExp(`square (${IDENT})`, "gu"), "$1**2"],
  [new RegExp(`sq (${IDENT})`, "gu"), "$1**2"],
  // Python's \b before a digit: the character before is not a word character.
  [new RegExp(`(?<!${W})([0-9]+\\.?[0-9]*)(?=[e|E][a-zA-Z]|[a-df-zA-DF-Z])`, "gu"), "$1*"],
  [new RegExp(`(${W}|[.)])\\s+(?=${W}|\\()`, "gu"), "$1*"],
];

const PRETTY_EXPONENT = /(⁻?[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\.[⁰¹²³⁴⁵⁶⁷⁸⁹]*)?)/gu;
const PRETTY = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "·": "*", "⁻": "-" };

/* pint.util.string_preprocessor */
export function preprocess(text) {
  let s = text.replaceAll(",", "").replaceAll(" per ", "/");
  for (const [pattern, replacement] of SUBSTITUTIONS) s = s.replace(pattern, replacement);
  s = s.replace(PRETTY_EXPONENT, "**($1)");
  s = [...s].map((c) => PRETTY[c] ?? c).join("");
  return s.replaceAll("^", "**");
}

// -- Python's tokenizer, for the tokens a unit string can hold -----------------------------------

const DIGITS = "[0-9](?:_?[0-9])*";
const EXPONENT = `[eE][-+]?${DIGITS}`;
const POINT_FLOAT = `(?:${DIGITS})?\\.${DIGITS}(?:${EXPONENT})?|${DIGITS}\\.(?:${EXPONENT})?`;
const FLOAT = `(?:${POINT_FLOAT}|${DIGITS}${EXPONENT})`;
const IMAGINARY = `(?:${FLOAT}|${DIGITS})[jJ]`;
const INTEGER = "0[xX](?:_?[0-9a-fA-F])+|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|(?:0(?:_?0)*|[1-9](?:_?[0-9])*)";
/* tokenize.Number: imaginary first, then float, then integer, as Python's alternation tries them. */
const NUMBER = new RegExp(`^(?:${IMAGINARY}|${FLOAT}|${INTEGER})`, "u");
const NAME = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/u;
/* tokenize's operators, longest first. */
const OPERATORS = [
  "**=", "//=", ">>=", "<<=", "...", "->", "**", "//", ">>", "<<", "<=", ">=", "==", "!=", ":=",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@=",
  "+", "-", "*", "/", "%", "@", "&", "|", "^", "~", "<", ">", "(", ")", "[", "]", "{", "}",
  ",", ":", ";", ".", "=",
];

export function tokenize(text) {
  const tokens = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const space = /^[ \t\f]+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    // A number must be tried before a name, and before "." is taken as an operator.
    const number = NUMBER.exec(rest);
    if (number && !(number[0] === "." )) {
      tokens.push({ type: "NUMBER", string: number[0] });
      i += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ type: "NAME", string: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      if ("([{".includes(op)) depth += 1;
      if (")]}".includes(op)) depth -= 1;
      tokens.push({ type: "OP", string: op });
      i += op.length;
      continue;
    }
    if (rest[0] === "\n" || rest[0] === "\r") {
      i += 1;
      continue;
    }
    // Anything else is an ERRORTOKEN, which Pint's tree builder steps over.
    tokens.push({ type: "ERRORTOKEN", string: rest[0] });
    i += 1;
  }
  if (depth > 0) throw new UnitError("EOF in multi-line statement");
  tokens.push({ type: "NEWLINE", string: "" }, { type: "ENDMARKER", string: "" });
  return tokens;
}

// -- pint_eval._build_eval_tree, line for line ----------------------------------------------------

const PRIORITY = { "+/-": 4, "**": 3, "^": 3, unary: 2, "*": 1, "": 1, "//": 1, "/": 1, "%": 1, "+": 0, "-": 0 };

function buildTree(tokens, index = 0, depth = 0, prevOp = "<none>") {
  let result = null;
  for (;;) {
    const token = tokens[index];
    if (token.type === "OP") {
      if (token.string === ")") {
        if (prevOp === "<none>") throw new UnitError("unopened parentheses");
        if (prevOp === "(") return [need(result), index];
        return [need(result), index - 1];
      } else if (token.string === "(") {
        let right;
        [right, index] = buildTree(tokens, index + 1, 0, "(");
        if (tokens[index].string !== ")") throw new UnitError("weird exit from parentheses");
        result = result ? { left: result, right } : right;
      } else if (token.string in PRIORITY) {
        if (result) {
          if (PRIORITY[token.string] <= (PRIORITY[prevOp] ?? -1) && token.string !== "**" && token.string !== "^") {
            return [result, index - 1];
          }
          let right;
          [right, index] = buildTree(tokens, index + 1, depth + 1, token.string);
          result = { left: result, operator: token.string, right };
        } else {
          let right;
          [right, index] = buildTree(tokens, index + 1, depth + 1, "unary");
          result = { left: right, operator: token.string, unary: true };
        }
      }
    } else if (token.type === "NUMBER" || token.type === "NAME") {
      if (result) {
        if (PRIORITY[""] <= (PRIORITY[prevOp] ?? -1)) return [result, index - 1];
        let right;
        [right, index] = buildTree(tokens, index, depth + 1, "");
        result = { left: result, right };
      } else {
        result = { token };
      }
    }
    if (tokens[index].type === "ENDMARKER") {
      if (prevOp === "(") throw new UnitError("unclosed parentheses");
      if (depth > 0 || prevOp) return [need(result), index];
      return [need(result), -1];
    }
    if (index + 1 >= tokens.length) throw new UnitError("unexpected end to tokens");
    index += 1;
  }
}

function need(result) {
  if (!result) throw new UnitError("incomplete expression");
  return result;
}

// -- evaluating the tree: numbers, and ParserHelper's products of names ---------------------------

/* A ParserHelper: a scale and a product of names, each to a power. Insertion order kept. */
class Helper {
  constructor(scale = 1, terms = new Map()) {
    this.scale = scale;
    this.terms = terms;
  }
  static word(name) {
    return new Helper(1, new Map([[name, 1]]));
  }
  combine(other, sign) {
    const terms = new Map(this.terms);
    for (const [k, v] of other.terms) {
      const next = (terms.get(k) ?? 0) + sign * v;
      if (next === 0) terms.delete(k);
      else terms.set(k, next);
    }
    return terms;
  }
}

const isHelper = (x) => x instanceof Helper;

function pyNumber(text) {
  const plain = text.replaceAll("_", "");
  if (/^[0-9]+$/.test(plain) && !/^_|_$|__/.test(text)) return Number(plain);
  // float(): decimal forms only; hex, octal, binary and imaginary literals are refused.
  if (/^(?:[0-9](?:_?[0-9])*)?(?:\.(?:[0-9](?:_?[0-9])*)?)?(?:[eE][-+]?[0-9](?:_?[0-9])*)?$/.test(text) && /[0-9]/.test(text)) {
    return Number(plain);
  }
  throw new UnitError(`could not convert ${text}`);
}

function multiply(a, b) {
  if (isHelper(a) && isHelper(b)) return new Helper(a.scale * b.scale, a.combine(b, 1));
  if (isHelper(a)) return new Helper(a.scale * b, new Map(a.terms));
  if (isHelper(b)) return new Helper(b.scale * a, new Map(b.terms));
  return a * b;
}

function divide(a, b) {
  if (isHelper(a) && isHelper(b)) return new Helper(a.scale / b.scale, a.combine(b, -1));
  if (isHelper(a)) {
    if (b === 0) throw new UnitError("division by zero");
    return new Helper(a.scale / b, new Map(a.terms));
  }
  if (isHelper(b)) {
    const inverse = power(b, -1);
    return new Helper(inverse.scale * a, inverse.terms);
  }
  if (b === 0) throw new UnitError("division by zero");
  return a / b;
}

function power(a, b) {
  if (isHelper(b)) throw new UnitError("a unit cannot be an exponent");
  if (isHelper(a)) {
    const terms = new Map();
    for (const [k, v] of a.terms) terms.set(k, v * b);
    return new Helper(a.scale ** b, terms);
  }
  return a ** b;
}

function evaluate(node) {
  if (node.token) {
    if (node.token.type === "NUMBER") return pyNumber(node.token.string);
    return Helper.word(node.token.string);
  }
  if (node.unary) {
    const value = evaluate(node.left);
    if (node.operator === "+") return value;
    if (node.operator === "-") return multiply(value, -1);
    throw new UnitError(`missing unary operator ${node.operator}`);
  }
  const left = evaluate(node.left);
  const right = evaluate(node.right);
  switch (node.operator ?? "") {
    case "":
    case "*":
      return multiply(left, right);
    case "/":
    case "//":
      if (node.operator === "//" && !isHelper(left) && !isHelper(right)) {
        if (right === 0) throw new UnitError("division by zero");
        return Math.floor(left / right);
      }
      return divide(left, right);
    case "**":
      return power(left, right);
    case "+":
    case "-":
    case "%":
      if (isHelper(left) || isHelper(right)) throw new UnitError(`unsupported operand for ${node.operator}`);
      if (node.operator === "+") return left + right;
      if (node.operator === "-") return left - right;
      if (right === 0) throw new UnitError("modulo by zero");
      return left - right * Math.floor(left / right);
    default:
      throw new UnitError(`missing binary operator ${node.operator}`);
  }
}

// -- the registry -------------------------------------------------------------------------------

export class Registry {
  /* `table` is units.json's `registry`: keys, prefixes, suffixes and units. */
  constructor(table) {
    this.keys = table.keys;
    this.prefixes = table.prefixes;
    this.suffixes = table.suffixes;
    this.units = table.units;
    this.currencies = table.currencies ?? [];
    this.prefixFactor = Object.fromEntries(table.prefixes.map(([, name, factor]) => [name, factor]));
    this.cache = new Map();
  }

  /* pint's get_name: the canonical name a string refers to, or "" for dimensionless. */
  canonical(text) {
    if (text === "dimensionless") return "";
    if (Object.hasOwn(this.keys, text)) return this.keys[text];
    const candidates = [];
    const seen = new Set();
    for (const [suffix] of this.suffixes) {
      for (const [prefix, prefixName] of this.prefixes) {
        if (!text.startsWith(prefix) || !text.endsWith(suffix)) continue;
        let name = text.slice(prefix.length);
        if (suffix) {
          name = name.slice(0, -suffix.length);
          if (name.length === 1) continue;
        }
        if (!Object.hasOwn(this.keys, name)) continue;
        const triple = [prefixName, this.keys[name]];
        const key = triple.join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(triple);
        }
      }
    }
    // Prefer a prefixed reading over the same unit spelled whole: kilo + gram over kilogram.
    const kept = candidates.filter(
      ([p, u]) => p !== "" || !candidates.some(([cp, cu]) => cp !== "" && cp + cu === u),
    );
    if (!kept.length) throw new UnitError(`'${text}' is not defined in the unit registry`);
    const [prefix, unit] = kept[0];
    if (prefix) {
      if (!this.units[unit]?.multiplicative) throw new UnitError("Prefixing a unit requires multiplying the unit.");
      return prefix + unit;
    }
    return unit;
  }

  /* One canonical unit's factor to base units, dimensions, and whether it converts by a factor. */
  base(name) {
    if (Object.hasOwn(this.units, name)) return this.units[name];
    for (const [, prefixName, factor] of this.prefixes) {
      if (prefixName && name.startsWith(prefixName) && Object.hasOwn(this.units, name.slice(prefixName.length))) {
        const unit = this.units[name.slice(prefixName.length)];
        return { ...unit, factor: factor * unit.factor };
      }
    }
    throw new UnitError(`no definition for ${name}`);
  }

  /*
   * A unit string as a units container: { canonical name: exponent }, as Pint's Unit() gives.
   * Throws UnitError where Pint would refuse it.
   */
  parse(text) {
    if (!this.cache.has(text)) {
      try {
        this.cache.set(text, this.parseUncached(String(text)));
      } catch (error) {
        this.cache.set(text, error instanceof UnitError ? error : new UnitError(String(error?.message ?? error)));
      }
    }
    const hit = this.cache.get(text);
    if (hit instanceof UnitError) throw hit;
    this.ratioScale(text, hit);
    return { ...hit };
  }

  /*
   * sizing.units.parse refuses a unit that converts with an offset (degC) or a logarithm (dB): a
   * node converts by one factor. A logarithmic unit among others becomes a delta unit Pint never
   * defined, and the book falls over looking it up with a KeyError.
   */
  ratioScale(text, container) {
    for (const name of Object.keys(container)) {
      let unit;
      try {
        unit = this.base(name);
      } catch (error) {
        if (name.startsWith("delta_")) throw new PyError("KeyError", `'${name}'`);
        throw error;
      }
      if (!unit.multiplicative) {
        const refused = new UnitError(
          `unit '${text}' is not a ratio scale: ${name} converts with an offset or a logarithm, and a node converts by one factor`,
        );
        refused.ratio = true;
        throw refused;
      }
    }
  }

  parseUncached(text) {
    // The registry's own preprocessors, then strip, as _parse_units_as_container does.
    let s = text.replaceAll("×", "*").replaceAll("‰", " permille ").replaceAll("%", " percent ");
    if (!s) return {};
    s = s.trim();
    let helper;
    if (!s) helper = new Helper();
    else {
      const [tree] = buildTree(tokenize(preprocess(s)));
      const value = evaluate(tree);
      helper = isHelper(value) ? value : new Helper(value);
      for (const name of [...helper.terms.keys()]) {
        if (name.toLowerCase() === "nan") {
          helper.terms.delete(name);
          helper.scale = NaN;
        }
      }
    }
    if (helper.scale !== 1) throw new UnitError("Unit expression cannot have a scaling factor.");
    const out = {};
    const many = helper.terms.size > 1;
    for (const [name, value] of helper.terms) {
      let canonical = this.canonical(name);
      if (!canonical) continue;
      if (many || value !== 1) {
        if (!this.base(canonical).multiplicative) canonical = `delta_${canonical}`;
      }
      const next = (out[canonical] ?? 0) + value;
      if (next === 0) delete out[canonical];
      else out[canonical] = next;
    }
    return out;
  }

  /* A container's dimensions, factor to base units, and whether every unit in it is multiplicative. */
  describe(container) {
    const dimensionality = {};
    let factor = 1;
    let multiplicative = true;
    for (const [name, exponent] of Object.entries(container)) {
      const unit = this.base(name);
      if (unit.error) throw new UnitError(unit.error);
      multiplicative &&= unit.multiplicative;
      factor *= unit.factor ** exponent;
      for (const [dimension, power] of Object.entries(unit.dimensionality)) {
        const next = (dimensionality[dimension] ?? 0) + power * exponent;
        if (next === 0) delete dimensionality[dimension];
        else dimensionality[dimension] = next;
      }
    }
    return { dimensionality, factor, multiplicative };
  }
}

/* Two containers are the same unit exactly when they hold the same names to the same powers. */
export function sameUnits(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function sameDimensions(a, b) {
  return sameUnits(a, b);
}

/* The factor that converts a quantity in `from` into `to`: Pint's Quantity(1, from).to(to). */
export function conversion(registry, from, to) {
  return registry.describe(from).factor / registry.describe(to).factor;
}
