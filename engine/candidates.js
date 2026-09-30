/*
 * Candidate inputs found in customer notes, without a language model.
 *
 * Every number in the notes is a candidate. Each is scored against every input the model has:
 * the input's words appearing in the same sentence, right next to the number, or in a wider
 * window around it, and the kind of number (a percentage, a sum of money, a plain count) fitting
 * the input's unit. One clear winner is confident; a tie is ambiguous; nothing fitting is none.
 * Nothing here changes a model: a candidate becomes an input only when someone confirms it.
 *
 * This is deliberately narrow. It reads notes that put a number and a label in one sentence,
 * and it knows only the words each input lists. "Half a petabyte" finds nothing; that is what
 * the optional interpreter is for, and it produces candidates in this same shape.
 */

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NUMBER = /(£|\$|€)?\s?(\d[\d,]*(?:\.\d+)?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b)\s?(k|m|bn)?\b\s?(%|per ?cent)?/gi;
const TODAY = /current|currently|today|existing|they run|they have|at present|now/i;

/* The notes as sentences, each with its offset into the text. */
export function sentences(text) {
  const out = [];
  let at = 0;
  for (const piece of text.split(/(?<=[.;!?])\s+|\n+/)) {
    const start = text.indexOf(piece, at);
    if (piece.trim()) out.push({ text: piece.trim(), start: start < 0 ? at : start });
    at = start < 0 ? at + piece.length : start + piece.length;
  }
  return out;
}

/* What kind of figure a number is, from what is written around it. */
function kindOf(m) {
  if (m[4]) return "%";
  if (m[1]) return "money";
  return "count";
}
const fits = (input, kind) => {
  const unit = input.unit ?? "";
  if (kind === "%") return unit === "dimensionless" || /^%/.test(unit) || /^1\//.test(unit);
  if (kind === "money") return /^[A-Z]{3}(\/|$)/.test(unit) || /^[£$€]/.test(unit);
  return !/^[A-Z]{3}(\/|$)/.test(unit);
};

/*
 * Find candidates in `text` for `inputs`, each { key, name, unit, keys, scope }: `key` is what
 * confirming resolves to, `keys` a regular expression (or its source) of the words that name
 * the input, `scope` "shared" for a customer figure or an option id for one the current
 * environment supplies. Returns candidates in the order the numbers appear.
 */
export function findCandidates(text, inputs, { current = "current" } = {}) {
  const pool = inputs.map((i) => ({ ...i, re: i.keys instanceof RegExp ? i.keys : i.keys ? new RegExp(i.keys, "i") : null }));
  const found = [];
  let k = 0;
  for (const s of sentences(text)) {
    const today = TODAY.test(s.text);
    for (const m of s.text.matchAll(NUMBER)) {
      let value = WORDS[m[2].toLowerCase()] ?? Number(m[2].replace(/,/g, ""));
      if (m[3]) value *= { k: 1e3, m: 1e6, bn: 1e9 }[m[3].toLowerCase()];
      const kind = kindOf(m);
      const lead = m[0].length - m[0].trimStart().length;
      const at = m.index + lead, len = m[0].trim().length;
      const near = s.text.slice(Math.max(0, at - 4), at + len + 14);
      const wider = s.text.slice(Math.max(0, at - 24), at + len + 24);
      const scored = pool.map((i) => {
        if (!i.re || !fits(i, kind) || !i.re.test(s.text)) return { key: i.key, score: 0 };
        if (i.scope !== "shared" && i.scope !== current) return { key: i.key, score: 0 };
        if (i.scope === current && !today) return { key: i.key, score: 0 };
        let score = 2, strong = false;
        if (i.re.test(near)) { score += 3; strong = true; }
        if (i.re.test(wider)) { score += 1; strong = true; }
        if (i.context && i.context.test(s.text)) score += 1;
        if (i.scope === current) score += 1;
        return { key: i.key, score, strong };
      }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
      found.push({
        id: `c${k++}`,
        text: m[0].trim(),
        // A percentage in the notes is a share in the model: 30% is 0.3 of something.
        value: kind === "%" ? value / 100 : value,
        written: value,
        kind,
        sentence: s.text,
        at,
        length: len,
        scored,
        status: "pending",
      });
    }
  }
  // Resolve strongest first: a confident match claims its input, so a weaker number elsewhere in
  // the notes cannot be the same thing, whichever came first.
  const taken = new Set();
  const order = [...found].sort((a, b) => (b.scored[0]?.score ?? 0) - (a.scored[0]?.score ?? 0));
  for (const c of order) {
    const scored = c.scored.filter((x) => !taken.has(x.key));
    const top = scored[0];
    const ties = top ? scored.filter((x) => x.score === top.score) : [];
    // Confident only when the input's words sit by the number, not just somewhere in the sentence.
    c.confidence = !top ? "none" : ties.length > 1 || !top.strong ? "ambiguous" : "confident";
    c.target = c.confidence === "confident" ? top.key : "";
    c.alternatives = scored.slice(0, 4).map((x) => x.key);
    if (c.target) taken.add(c.target);
    delete c.scored;
  }
  return found;
}

/* Written requirements the notes mention: no number, but worth recording with the answer. */
export function findWritten(text, patterns) {
  const out = [];
  for (const s of sentences(text)) {
    for (const [category, re] of Object.entries(patterns)) {
      if ((re instanceof RegExp ? re : new RegExp(re, "i")).test(s.text)) out.push({ category, sentence: s.text });
    }
  }
  return out;
}
