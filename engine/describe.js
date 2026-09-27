/*
 * What a unit is, in the words the book uses for it: a rate, a level, a length of time, a ratio.
 *
 * ch02's question for every quantity is which of those it is, because the commonest sizing error
 * multiplies a rate by a plain number and calls the result an amount. The builder reads each unit
 * back to the reader in these words, from the dimensions the book's own registry gives it.
 *
 * One case needs saying out loud. The book's registry gives bytes no dimension of their own
 * (BOOK-REQUESTS 3), so terabytes are checked as a pure number. The words say so rather than
 * pretend otherwise.
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
  "[currency]": "money",
};

const DATA_UNITS = /(?:^|_|[a-z])(?:byte|bit)$/;

/* Whether a container holds a unit of data (byte, terabyte, gibibit...). */
export function holdsData(units) {
  return Object.keys(units).some((name) => DATA_UNITS.test(name) || name === "byte" || name === "bit");
}

/*
 * { kind, words }: kind is one of rate, level, duration, ratio, and words is the sentence the
 * builder shows: "The toolkit reads this as a rate: requests per unit of time."
 */
export function describe(dimensionality, units = {}) {
  const dims = Object.entries(dimensionality).filter(([, e]) => e !== 0);
  const time = dimensionality["[time]"] ?? 0;
  const others = dims.filter(([d]) => d !== "[time]");
  const named = (list) => list.map(([d]) => COUNTS[d] ?? d.replace(/[[\]]/g, "")).join(" and ");
  const data = holdsData(units);

  if (!dims.length) {
    if (data) {
      return { kind: "level", words: "an amount of data. The book's registry checks data as a pure number, so it cannot tell terabytes from a plain count." };
    }
    return { kind: "ratio", words: "a pure number: a ratio, a factor or a fraction." };
  }
  if (time < 0) {
    const what = others.filter(([, e]) => e > 0);
    const per = others.filter(([, e]) => e < 0);
    const subject = what.length ? named(what) : data ? "data" : "something";
    return { kind: "rate", words: `a rate: ${subject}${per.length ? ` per ${named(per).replace(/s$/, "")}` : ""} per unit of time.` };
  }
  if (time > 0 && !others.length) return { kind: "duration", words: "a length of time." };
  if (others.some(([, e]) => e < 0)) {
    const top = others.filter(([, e]) => e > 0);
    const bottom = others.filter(([, e]) => e < 0);
    const subject = top.length ? named(top) : data ? "data" : "a number";
    return { kind: "ratio", words: `a ratio: ${subject} per ${named(bottom).replace(/s$/, "")}${time > 0 ? ", times a length of time" : ""}.` };
  }
  if (dimensionality["[currency]"] > 0 && others.length === 1) return { kind: "level", words: "an amount of money." };
  return { kind: "level", words: `a level: a count of ${named(others)}${time > 0 ? ", times a length of time" : ""}.` };
}
