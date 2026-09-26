/*
 * The few Python behaviours the book's verdicts depend on.
 *
 * The book reads a model file into Python values and then calls str(), float() and tuple() on
 * them, sorts names, and does float arithmetic that raises where JavaScript quietly returns
 * Infinity or NaN. Each of those decides whether a file loads, what a message names, or whether a
 * scenario evaluates, so the engine does them the Python way. Values carry their Python type:
 *
 *   null (None), true/false (bool), { py: "int", value } , numbers (float), strings (str),
 *   { py: "date", text }, arrays (list), Map (dict, keys in insertion order)
 *
 * An int is boxed because YAML's `3` and `3.0` are different Python values, and str() of them
 * differs ("3" and "3.0"). Everything else maps onto a JavaScript type directly.
 */

/* A Python exception, by class name, so the engine can refuse where the book falls over. */
export class PyError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

export const pyInt = (value) => ({ py: "int", value });
export const isInt = (x) => x !== null && typeof x === "object" && x.py === "int";
export const isDict = (x) => x instanceof Map;

/* Python's sorted() on strings: by code point, which is not JavaScript's default order. */
export function codePointCompare(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
export const sorted = (items) => [...items].sort(codePointCompare);

/* repr(float): the shortest round-trip digits, in Python's layout. */
export function floatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Object.is(x, -0)) return "-0.0";
  const [mantissa, exp] = x.toExponential().split("e");
  const exponent = Number(exp);
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = x < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent >= 0) {
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fraction = digits.slice(exponent + 1) || "0";
    return `${sign}${whole}.${fraction}`;
  }
  return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
}

/* repr() of a value, for a list or dict that str() is called on. */
export function repr(x) {
  if (typeof x === "string") return `'${x.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  return str(x);
}

/* str() */
export function str(x) {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "string") return x;
  if (typeof x === "number") return floatRepr(x);
  if (isInt(x)) return String(x.value);
  if (x.py === "date") return x.text;
  if (Array.isArray(x)) return `[${x.map(repr).join(", ")}]`;
  if (isDict(x)) return `{${[...x].map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ")}}`;
  return String(x);
}

/* A Python float's text form as float() accepts it: digits with single underscores, or inf/nan. */
const FLOAT_TEXT = /^[+-]?(?:(?:[0-9](?:_?[0-9])*)?\.?[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;

/* float() */
export function float(x) {
  if (typeof x === "number") return x;
  if (x === true) return 1;
  if (x === false) return 0;
  if (isInt(x)) {
    const value = Number(x.value);
    if (!Number.isFinite(value)) throw new PyError("OverflowError", "int too large to convert to float");
    return value;
  }
  if (typeof x === "string") {
    const text = x.trim();
    const lower = text.toLowerCase();
    const bare = lower.replace(/^[+-]/, "");
    if (bare === "inf" || bare === "infinity") return lower.startsWith("-") ? -Infinity : Infinity;
    if (bare === "nan") return NaN;
    if (FLOAT_TEXT.test(text)) return Number(text.replaceAll("_", ""));
    throw new PyError("ValueError", `could not convert string to float: ${repr(x)}`);
  }
  throw new PyError("TypeError", `float() argument must be a string or a real number, not '${typeName(x)}'`);
}

/* int() of a scenario's samples and seed. */
export function int(x) {
  if (isInt(x)) return Number(x.value);
  if (x === true) return 1;
  if (x === false) return 0;
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new PyError(Number.isNaN(x) ? "ValueError" : "OverflowError", "cannot convert float to integer");
    return Math.trunc(x);
  }
  if (typeof x === "string" && /^\s*[+-]?[0-9](?:_?[0-9])*\s*$/.test(x)) return Number(x.trim().replaceAll("_", ""));
  throw new PyError(typeof x === "string" ? "ValueError" : "TypeError", `invalid literal for int(): ${repr(x)}`);
}

export function typeName(x) {
  if (x === null || x === undefined) return "NoneType";
  if (typeof x === "boolean") return "bool";
  if (typeof x === "string") return "str";
  if (typeof x === "number") return "float";
  if (isInt(x)) return "int";
  if (x.py === "date") return "date";
  if (Array.isArray(x)) return "list";
  if (isDict(x)) return "dict";
  return typeof x;
}

/* Python truthiness. */
export function truthy(x) {
  if (x === null || x === undefined || x === false) return false;
  if (typeof x === "number") return x !== 0;
  if (isInt(x)) return Number(x.value) !== 0;
  if (typeof x === "string" || Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return x.size > 0;
  return true;
}

/* What iterating a value yields: a list's items, a string's characters, a dict's keys. */
export function iterate(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") return [...x];
  if (isDict(x)) return [...x.keys()];
  throw new PyError("TypeError", `'${typeName(x)}' object is not iterable`);
}

/* dict.get(key, default) on a value that must be a dict. */
export function get(mapping, key, fallback = undefined) {
  if (!isDict(mapping)) throw new PyError("AttributeError", `'${typeName(mapping)}' object has no attribute 'get'`);
  return mapping.has(key) ? mapping.get(key) : fallback;
}

/* `key in mapping`: a dict's keys, a list's items, a string's substrings. */
export function contains(container, key) {
  if (isDict(container)) return container.has(key);
  if (Array.isArray(container)) return container.some((item) => item === key);
  if (typeof container === "string") {
    if (typeof key !== "string") throw new PyError("TypeError", "'in <string>' requires string as left operand");
    return container.includes(key);
  }
  throw new PyError("TypeError", `argument of type '${typeName(container)}' is not iterable`);
}

/* Python's str.strip(): whitespace as str.isspace() sees it. */
export const strip = (s) => s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "");

// -- float arithmetic that raises where Python's does -----------------------------------------------
//
// A number here is either a Python float or a numpy float64. They differ only in what happens at
// the edges: Python raises ZeroDivisionError and OverflowError, numpy returns inf or nan with a
// warning. A value that has passed through numpy (the unit pass's sqrt) stays numpy, and so does
// anything computed from it, which is why the flag travels with the value.

export function divide(a, b, numpy = false) {
  if (b === 0 && !numpy) throw new PyError("ZeroDivisionError", "float division by zero");
  return a / b;
}

export function power(a, b, numpy = false) {
  if (numpy) return a ** b;
  if (a === 0 && b < 0) throw new PyError("ZeroDivisionError", "0.0 cannot be raised to a negative power");
  if (a < 0 && Number.isFinite(b) && !Number.isInteger(b)) {
    // Python returns a complex number here rather than raising.
    return { complex: true };
  }
  const result = a ** b;
  if (!Number.isFinite(result) && Number.isFinite(a) && Number.isFinite(b)) {
    throw new PyError("OverflowError", "(34, 'Numerical result out of range')");
  }
  return result;
}

/* The seven functions, as math and Python's builtins do them. */
export const MATH = {
  min(...args) {
    if (args.length === 1) throw new PyError("TypeError", "'float' object is not iterable");
    if (!args.length) throw new PyError("TypeError", "min expected at least 1 argument, got 0");
    return args.reduce((best, x) => (x < best ? x : best));
  },
  max(...args) {
    if (args.length === 1) throw new PyError("TypeError", "'float' object is not iterable");
    if (!args.length) throw new PyError("TypeError", "max expected at least 1 argument, got 0");
    return args.reduce((best, x) => (x > best ? x : best));
  },
  ceil(...args) {
    const x = one("ceil", args);
    if (Number.isNaN(x)) throw new PyError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new PyError("OverflowError", "cannot convert float infinity to integer");
    return Math.ceil(x);
  },
  floor(...args) {
    const x = one("floor", args);
    if (Number.isNaN(x)) throw new PyError("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new PyError("OverflowError", "cannot convert float infinity to integer");
    return Math.floor(x);
  },
  sqrt(...args) {
    const x = one("sqrt", args);
    if (x < 0) throw new PyError("ValueError", "math domain error");
    return Math.sqrt(x);
  },
  log(...args) {
    if (args.length === 2) {
      const [x, base] = args;
      if (x <= 0 || base <= 0) throw new PyError("ValueError", "math domain error");
      const d = Math.log(base);
      if (d === 0) throw new PyError("ZeroDivisionError", "float division by zero");
      return Math.log(x) / d;
    }
    const x = one("log", args);
    if (x <= 0 || Number.isNaN(x)) {
      if (Number.isNaN(x)) return NaN;
      throw new PyError("ValueError", "math domain error");
    }
    return Math.log(x);
  },
  exp(...args) {
    const x = one("exp", args);
    const result = Math.exp(x);
    if (result === Infinity && x !== Infinity) throw new PyError("OverflowError", "math range error");
    return result;
  },
};

function one(name, args) {
  if (args.length !== 1) throw new PyError("TypeError", `math.${name}() takes exactly one argument (${args.length} given)`);
  const [x] = args;
  if (typeof x === "object" && x?.complex) throw new PyError("TypeError", "must be real number, not complex");
  return x;
}
