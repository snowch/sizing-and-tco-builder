/*
 * What a unit is, in the words the book uses for it: a rate, a level, a length of time, a ratio.
 *
 * ch02's question for every quantity is which of those it is, because the commonest sizing error
 * multiplies a rate by a plain number and calls the result an amount. The builder reads each unit
 * back to the reader in these words, from the dimensions the book's own registry gives it.
 */

const COUNTS = {
  "[request]": "requests",
  "[span]": "spans",
  "[sample]": "samples",
  "[series]": "series",
  "[line]": "lines",
  "[query]": "queries",
  "[host]": "hosts",
  "[node]": "nodes",
  "[core]": "cores",
  "[label]": "labels",
  "[drive]": "drives",
  "[failure]": "failures",
  "[information]": "data",
};

/* Every currency is a dimension of its own ([currency_usd], [currency_eur]...), and all are money. */
const isMoney = (dimension) => dimension.startsWith("[currency_");

const word = (dimension) => (isMoney(dimension) ? "money" : COUNTS[dimension] ?? dimension.replace(/[[\]]/g, ""));

/* After "per": one of the thing, not the plural. */
const one = (dimension) => {
  const w = word(dimension);
  if (w === "data" || w === "money") return `unit of ${w}`;
  return w === "series" ? w : w.replace(/ies$/, "y").replace(/s$/, "");
};

/*
 * { kind, words }: kind is one of rate, level, duration, ratio, and words is the sentence the
 * builder shows: "The toolkit reads this as a rate: requests per unit of time."
 */
export function describe(dimensionality) {
  const dims = Object.entries(dimensionality).filter(([, e]) => e !== 0);
  const time = dimensionality["[time]"] ?? 0;
  const others = dims.filter(([d]) => d !== "[time]");
  const named = (list) => list.map(([d]) => word(d)).join(" and ");
  const per = (list) => list.map(([d]) => one(d)).join(" and ");

  if (!dims.length) return { kind: "ratio", words: "a pure number: a ratio, a factor or a fraction." };
  if (time < 0) {
    const what = others.filter(([, e]) => e > 0);
    const under = others.filter(([, e]) => e < 0);
    const subject = what.length ? named(what) : "something";
    return { kind: "rate", words: `a rate: ${subject}${under.length ? ` per ${per(under)}` : ""} per unit of time.` };
  }
  if (time > 0 && !others.length) return { kind: "duration", words: "a length of time." };
  if (others.some(([, e]) => e < 0)) {
    const top = others.filter(([, e]) => e > 0);
    const bottom = others.filter(([, e]) => e < 0);
    const subject = top.length ? named(top) : "a number";
    return { kind: "ratio", words: `a ratio: ${subject} per ${per(bottom)}${time > 0 ? ", times a length of time" : ""}.` };
  }
  if (others.length === 1 && time === 0 && others[0][1] === 1) {
    if (isMoney(others[0][0])) return { kind: "level", words: "an amount of money." };
    if (others[0][0] === "[information]") return { kind: "level", words: "an amount of data." };
  }
  return { kind: "level", words: `a level: a count of ${named(others)}${time > 0 ? ", times a length of time" : ""}.` };
}
