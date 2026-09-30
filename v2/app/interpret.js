/*
 * Interpreting notes with a language model, on this device, as an optional accelerator.
 *
 * Whatever runs here produces candidates in the finder's own shape (engine/candidates.js) and
 * nothing else: value, the input it maps to, the sentence it came from, and whether the model
 * was sure. A candidate becomes an input only when the engineer confirms it, exactly as one the
 * finder found. The page works in full with no interpreter at all.
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
  };
}
