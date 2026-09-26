/*
 * Quantities for the unit pass, behaving as the book's Pint quantities behave.
 *
 * The book checks a model's units by evaluating every formula on Pint quantities
 * (sizing/evaluate.py, check_units). Whether a formula typechecks, and the conversion factor it
 * needs, depend on Pint's rules for each operation, and some of those rules are not obvious:
 *
 *   - a quantity plus a plain zero keeps its units; plus any other plain number, it must be
 *     dimensionless and the result is dimensionless;
 *   - a quantity may be compared with zero whatever its units;
 *   - min and max return the winning operand with its own units;
 *   - a sum or difference of two quantities is in the left one's units;
 *   - a dimensionless exponent is applied to the units too, so a rate to the power 1.5 is a
 *     rate to the power 1.5;
 *   - sqrt goes through numpy, so it and everything computed from it stop raising on a division
 *     by zero and return inf or nan instead.
 *
 * Offset and logarithmic units (degC, dB) are not supported here: the builder does not offer
 * them, and the book is asked to refuse them (BOOK-REQUESTS 5). A file that uses one is refused
 * by the engine rather than checked differently from the book.
 *
 * A value is { units, m, np, cx }: units is a container (null for a plain number), m the
 * magnitude, np whether it is a numpy float64, cx whether Python has made it complex.
 */

import { PyError } from "./python.js";

export const plain = (m, np = false, cx = false) => ({ units: null, m, np, cx });
export const quantity = (m, units, np = false, cx = false) => ({ units: { ...units }, m, np, cx });
const isQ = (x) => x.units !== null;

export class Quantities {
  constructor(registry) {
    this.registry = registry;
  }

  describe(units) {
    const info = this.registry.describe(units);
    if (!info.multiplicative) throw new PyError("OffsetUnitCalculusError", "offset and logarithmic units are not supported");
    return info;
  }

  dimensionless(q) {
    return Object.keys(this.describe(q.units).dimensionality).length === 0;
  }

  sameDimensions(a, b) {
    const x = this.describe(a).dimensionality;
    const y = this.describe(b).dimensionality;
    const kx = Object.keys(x).sort();
    const ky = Object.keys(y).sort();
    return kx.length === ky.length && kx.every((k, i) => k === ky[i] && x[k] === y[k]);
  }

  /* The magnitude of q expressed in `units`: Pint's q.to(units).magnitude. */
  convert(q, units) {
    if (!this.sameDimensions(q.units, units)) throw new PyError("DimensionalityError", "Cannot convert between units of different dimensions");
    if (sameUnits(q.units, units)) return q.m;
    return q.m * (this.describe(q.units).factor / this.describe(units).factor);
  }

  factor(from, to) {
    return this.describe(from).factor / this.describe(to).factor;
  }

  // -- arithmetic --------------------------------------------------------------------------------

  add(a, b, subtract = false) {
    const np = a.np || b.np;
    const cx = a.cx || b.cx;
    const op = (x, y) => (subtract ? x - y : x + y);
    if (!isQ(a) && !isQ(b)) return plain(op(a.m, b.m), np, cx);
    if (isQ(a) && !isQ(b)) return this.addPlain(a, b, op, np, cx);
    if (!isQ(a) && isQ(b)) {
      // __radd__ is __add__; __rsub__ is -(b - a).
      const r = this.addPlain(b, a, (x, y) => (subtract ? x - y : x + y), np, cx);
      return subtract ? { ...r, m: -r.m } : r;
    }
    if (!this.sameDimensions(a.units, b.units)) throw new PyError("DimensionalityError", "Cannot add quantities of different dimensions");
    if (sameUnits(a.units, b.units)) return quantity(op(a.m, b.m), a.units, np, cx);
    return quantity(op(a.m, this.convert(b, a.units)), a.units, np, cx);
  }

  addPlain(q, n, op, np, cx) {
    if (n.m === 0 || Number.isNaN(n.m)) return quantity(op(q.m, n.m), q.units, np, cx);
    if (this.dimensionless(q)) return quantity(op(this.convert(q, {}), n.m), {}, np, cx);
    throw new PyError("DimensionalityError", "Cannot add a plain number to a quantity with dimensions");
  }

  multiply(a, b) {
    const np = a.np || b.np;
    const cx = a.cx || b.cx;
    const m = a.m * b.m;
    if (!isQ(a) && !isQ(b)) return plain(m, np, cx);
    if (!isQ(a)) return quantity(m, b.units, np, cx);
    if (!isQ(b)) return quantity(m, a.units, np, cx);
    return quantity(m, combine(a.units, b.units, 1), np, cx);
  }

  divide(a, b) {
    const np = a.np || b.np;
    const cx = a.cx || b.cx;
    if (b.m === 0 && !np) throw new PyError("ZeroDivisionError", "float division by zero");
    const m = a.m / b.m;
    if (!isQ(a) && !isQ(b)) return plain(m, np, cx);
    if (!isQ(b)) return quantity(m, a.units, np, cx);
    if (!isQ(a)) return quantity(m, combine({}, b.units, -1), np, cx);
    return quantity(m, combine(a.units, b.units, -1), np, cx);
  }

  negate(a) {
    return { ...a, m: -a.m };
  }

  power(a, b) {
    const np = a.np || b.np;
    if (!isQ(a)) {
      if (!isQ(b)) return this.rawPower(a.m, b.m, np, a.cx || b.cx, null);
      // number ** quantity: the quantity must be dimensionless, and the answer is a number.
      if (!this.dimensionless(b)) throw new PyError("DimensionalityError", "an exponent must be dimensionless");
      return this.rawPower(a.m, this.convert(b, {}), np, a.cx || b.cx, null);
    }
    let exponent;
    if (isQ(b)) {
      if (b.cx) throw new PyError("TypeError", "complex exponent");
      if (!this.dimensionless(b)) throw new PyError("DimensionalityError", "an exponent must be dimensionless");
      exponent = this.convert(b, {});
      if (exponent === 1) return a;
    } else {
      if (b.cx) throw new PyError("TypeError", "complex exponent");
      exponent = b.m;
      if (exponent === 1) return a;
    }
    if (exponent === 0) return this.rawPower(a.m, 0, np, a.cx, {});
    const units = {};
    for (const [name, e] of Object.entries(a.units)) units[name] = e * exponent;
    return this.rawPower(a.m, exponent, np, a.cx, units);
  }

  rawPower(base, exponent, np, cx, units) {
    let m;
    let complex = cx;
    if (cx) m = NaN;
    else if (np) m = base ** exponent;
    else {
      if (base === 0 && exponent < 0) throw new PyError("ZeroDivisionError", "0.0 cannot be raised to a negative power");
      if (base < 0 && Number.isFinite(exponent) && !Number.isInteger(exponent)) {
        complex = true;
        m = NaN;
      } else {
        m = base ** exponent;
        if (!Number.isFinite(m) && Number.isFinite(base) && Number.isFinite(exponent)) {
          throw new PyError("OverflowError", "(34, 'Numerical result out of range')");
        }
      }
    }
    return units === null ? plain(m, np, complex) : quantity(m, units, np, complex);
  }

  // -- comparison, for min and max ---------------------------------------------------------------

  /* a < b, as Python's `<` dispatches it between numbers and quantities. */
  less(a, b) {
    return this.compare(a, b, (x, y) => x < y);
  }

  greater(a, b) {
    return this.compare(a, b, (x, y) => x > y);
  }

  compare(a, b, op) {
    if (a.cx || b.cx) throw new PyError("TypeError", "'<' not supported for complex numbers");
    if (!isQ(a) && !isQ(b)) return op(a.m, b.m);
    if (isQ(a) && !isQ(b)) return this.compareWithNumber(a, b.m, op);
    if (!isQ(a) && isQ(b)) return this.compareWithNumber(b, a.m, (x, y) => op(y, x));
    if (sameUnits(a.units, b.units)) return op(a.m, b.m);
    if (!this.sameDimensions(a.units, b.units)) throw new PyError("DimensionalityError", "Cannot compare quantities of different dimensions");
    return op(a.m * this.describe(a.units).factor, b.m * this.describe(b.units).factor);
  }

  compareWithNumber(q, n, op) {
    if (this.dimensionless(q)) return op(this.convert(q, {}), n);
    if (n === 0 || Number.isNaN(n)) return op(q.m, n);
    throw new PyError("ValueError", "Cannot compare PlainQuantity and <class 'float'>");
  }

  // -- the functions the unit pass uses (evaluate.UNIT_FUNCTIONS) ---------------------------------

  call(fn, args) {
    switch (fn) {
      case "min":
      case "max": {
        if (!args.length) throw new PyError("ValueError", `${fn}() arg is an empty sequence`);
        let best = args[0];
        for (const x of args.slice(1)) {
          if (fn === "min" ? this.less(x, best) : this.greater(x, best)) best = x;
        }
        return best;
      }
      case "ceil":
      case "floor": {
        const x = single(fn, args);
        if (x.cx) throw new PyError("TypeError", "must be real number, not complex");
        if (Number.isNaN(x.m)) throw new PyError("ValueError", "cannot convert float NaN to integer");
        if (!Number.isFinite(x.m)) throw new PyError("OverflowError", "cannot convert float infinity to integer");
        const m = fn === "ceil" ? Math.ceil(x.m) : Math.floor(x.m);
        return quantity(m, isQ(x) ? x.units : {}, false, false);
      }
      case "sqrt": {
        const x = single(fn, args);
        const m = Math.sqrt(x.m);
        if (!isQ(x)) return plain(m, true, x.cx);
        const units = {};
        for (const [name, e] of Object.entries(x.units)) units[name] = e * 0.5;
        return quantity(m, units, true, x.cx);
      }
      case "log":
      case "exp": {
        const x = single(fn, args);
        const m = isQ(x) ? this.convert(x, {}) : x.m;
        if (x.cx) throw new PyError("TypeError", "must be real number, not complex");
        if (fn === "log") {
          if (Number.isNaN(m)) return plain(NaN);
          if (m <= 0) throw new PyError("ValueError", "math domain error");
          return plain(Math.log(m));
        }
        const r = Math.exp(m);
        if (r === Infinity && m !== Infinity) throw new PyError("OverflowError", "math range error");
        return plain(r);
      }
      default:
        throw new PyError("KeyError", fn);
    }
  }
}

function single(fn, args) {
  if (args.length !== 1) throw new PyError("TypeError", `${fn}() takes exactly one argument (${args.length} given)`);
  return args[0];
}

export function combine(a, b, sign) {
  const out = { ...a };
  for (const [name, e] of Object.entries(b)) {
    const next = (out[name] ?? 0) + sign * e;
    if (next === 0) delete out[name];
    else out[name] = next;
  }
  return out;
}

export function sameUnits(a, b) {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/* What `str(units)` would be compared by in _mixed_operands: the container, or dimensionless. */
export function unitKey(value) {
  if (!value.units) return "dimensionless";
  const entries = Object.entries(value.units).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return entries.length ? entries.map(([k, e]) => `${k}^${e}`).join(" ") : "dimensionless";
}
