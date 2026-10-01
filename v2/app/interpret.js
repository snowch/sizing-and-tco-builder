/*
 * Interpreting notes with a language model, on this device, as an optional accelerator.
 *
 * Whatever runs here produces candidates in one shape (the Customer step's cards) and
 * nothing else: value, the input it maps to, the sentence it came from, and whether the model
 * was sure. A candidate becomes an input only when the engineer confirms it. The page works in
 * full with no interpreter at all.
 *
 * The backend is pluggable: `createInterpreter({ backend })` takes anything with `status()` and
 * `complete(prompt, schema, onProgress)`, so a test can stand one in. The default backend is
 * WebLLM over WebGPU (v2/app/webllm.js), loaded only when asked for.
 */

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          input: { type: "string" },
          value: { type: "number" },
          quote: { type: "string" },
          sure: { type: "boolean" },
        },
        required: ["input", "value", "quote", "sure"],
      },
    },
  },
  required: ["candidates"],
};

/* The prompt: the inputs by key with their units, the notes, and the shape wanted back. */
export function promptFor(notes, inputs) {
  const list = inputs.map((i) => `- ${i.key}: ${i.name} (${i.unit})${i.scope !== "shared" ? " [a figure about the customer's current environment]" : ""}`).join("\n");
  return `You read a presales engineer's notes about a customer and pick out numbers that are inputs to a cost or sizing model.

The inputs, by key:
${list}

Rules:
- Only report a number that the notes state. Never estimate, never fill a gap, never use a typical figure.
- Give the value in the input's unit. A percentage of something is a share: 30% is 0.3. "£60k" is 60000. "half a petabyte" of data is 500 TB.
- "quote" is the exact sentence, or part of one, the number came from, copied from the notes.
- "sure" is true only when one input clearly fits; false when it could be another input.
- A number that fits no input is not reported.

Notes:
"""
${notes}
"""

Reply with JSON only, matching the schema: {"candidates": [{"input": key, "value": number, "quote": text, "sure": boolean}]}.`;
}

/* Reply JSON to candidates in the finder's shape, dropping anything that names no known input. */
export function candidatesFromReply(reply, notes, inputs, startId = 0) {
  let parsed;
  try { parsed = typeof reply === "string" ? JSON.parse(reply) : reply; } catch { return []; }
  const known = new Map(inputs.map((i) => [i.key, i]));
  const out = [];
  let k = startId;
  for (const c of parsed?.candidates ?? []) {
    if (!known.has(c.input) || typeof c.value !== "number" || !Number.isFinite(c.value)) continue;
    const quote = String(c.quote ?? "").trim();
    const where = quote ? notes.indexOf(quote) : -1;
    const sentence = where >= 0 ? sentenceAround(notes, where) : quote || "(no quote given)";
    const atIn = sentence.indexOf(quote);
    out.push({
      id: `ai${k++}`,
      text: quote.length > 40 ? String(c.value) : quote || String(c.value),
      value: c.value,
      written: c.value,
      kind: "ai",
      sentence,
      at: atIn >= 0 ? atIn : 0,
      length: atIn >= 0 ? quote.length : 0,
      confidence: c.sure ? "confident" : "ambiguous",
      target: c.sure ? c.input : "",
      alternatives: [c.input],
      status: "pending",
      by: "ai",
      found: where >= 0,
    });
  }
  return out;
}
function sentenceAround(text, at) {
  const start = Math.max(text.lastIndexOf(". ", at) + 1, text.lastIndexOf("\n", at) + 1, 0);
  let end = text.indexOf(". ", at);
  const nl = text.indexOf("\n", at);
  if (end < 0 || (nl >= 0 && nl < end)) end = nl;
  return text.slice(start, end < 0 ? text.length : end + 1).trim();
}

/*
 * One question, one answer: the interview. The app asks about one input it knows; the model
 * only reads the answer into that input's unit, or says the answer gives no figure. A much
 * smaller task than reading a page of notes, and one a small model gets right.
 */
const ANSWER_SCHEMA = {
  type: "object",
  properties: { value: { type: ["number", "null"] }, unknown: { type: "boolean" }, sure: { type: "boolean" } },
  required: ["value", "unknown", "sure"],
};
export function promptForOne(question, input, answer) {
  return `A presales engineer was asked about one input to a cost or sizing model and typed an answer. Read the answer into a number in the input's unit.

Input: ${input.name} (unit: ${input.unit})
Question: ${question}
Answer: """${answer}"""

Rules:
- Report only a figure the answer states. Never estimate, never fill a gap.
- Give the value in the unit named. A percentage of something is a share: 30% is 0.3. "£60k" is 60000. "half a petabyte" of data is 500 TB. "a third" is 0.33.
- If the answer gives no figure ("don't know", "not yet", a question back), set unknown true and value null.
- "sure" is true only when the answer clearly gives this figure.

Reply with JSON only: {"value": number or null, "unknown": boolean, "sure": boolean}.`;
}
/* Words that mean no figure, for the reader that has no model. */
const UNKNOWN = /\b(don'?t know|do not know|dunno|unknown|no idea|not sure|no figure|not yet|tbc|tbd|n\/a|\?)\s*$/i;
/* Read a typed answer without a model: the first number in it, in the unit's sense. */
export function readAnswer(answer, input) {
  const text = String(answer ?? "").trim();
  if (!text || UNKNOWN.test(text)) return { value: null, unknown: true, sure: false, by: "typed" };
  const m = /(£|\$|€)?\s?(-?\d[\d,]*(?:\.\d+)?)\s?(k|m|bn)?\b\s?(%|per ?cent)?/i.exec(text);
  if (!m) return { value: null, unknown: true, sure: false, by: "typed" };
  let value = Number(m[2].replace(/,/g, ""));
  if (m[3]) value *= { k: 1e3, m: 1e6, bn: 1e9 }[m[3].toLowerCase()];
  const percent = Boolean(m[4]);
  const share = /^(dimensionless|1\/)/.test(input.unit ?? "");
  if (percent && share) value /= 100;
  // A plain number with words around it is read; whether it is the right figure is the engineer's call.
  return { value, unknown: false, sure: /^\s*(£|\$|€)?\s?-?[\d,.]+\s?(k|m|bn)?\s?(%|per ?cent)?\s*([A-Za-z/]+\s*)?$/i.test(text), by: "typed" };
}
export function answerFromReply(reply) {
  let parsed;
  try { parsed = typeof reply === "string" ? JSON.parse(reply) : reply; } catch { return { value: null, unknown: true, sure: false, by: "ai" }; }
  const value = typeof parsed?.value === "number" && Number.isFinite(parsed.value) ? parsed.value : null;
  return { value, unknown: value === null || Boolean(parsed?.unknown), sure: Boolean(parsed?.sure) && value !== null, by: "ai" };
}

export function createInterpreter({ backend = null, loadBackend = null } = {}) {
  let engine = backend;
  return {
    /* Whether an interpreter can run here, and why not if it cannot. Never loads anything. */
    async status() {
      if (engine) return engine.status();
      if (!loadBackend) return { available: false, reason: "No interpreter is configured on this page." };
      if (!globalThis.navigator?.gpu) return { available: false, reason: "This browser has no WebGPU, which the on-device model needs. Chrome, Edge, Safari 26 or a recent Firefox have it." };
      return { available: true, reason: "", size: "about 560 MB, downloaded once and kept on this device" };
    },
    /* Candidates from the notes. Loads the backend on first use, reporting progress. */
    async interpret(notes, inputs, onProgress = () => {}) {
      if (!engine) {
        if (!loadBackend) throw new Error("No interpreter is configured on this page.");
        engine = await loadBackend(onProgress);
      }
      const reply = await engine.complete(promptFor(notes, inputs), OUTPUT_SCHEMA, onProgress);
      return candidatesFromReply(reply, notes, inputs);
    },
    /* Whether a model is loaded and ready to read answers. Never loads one. */
    loaded() { return Boolean(engine); },
    /*
     * One answer to one question, read into that input's unit. The model reads it only when one is
     * already loaded (the engineer asked for it in the Customer step); otherwise the typed reader
     * does, and a model failing mid-answer falls back to it too.
     */
    async interpretAnswer(question, input, answer, onProgress = () => {}) {
      if (!engine) return readAnswer(answer, input);
      try {
        const reply = await engine.complete(promptForOne(question, input, answer), ANSWER_SCHEMA, onProgress);
        return answerFromReply(reply);
      } catch {
        return readAnswer(answer, input);
      }
    },
  };
}
