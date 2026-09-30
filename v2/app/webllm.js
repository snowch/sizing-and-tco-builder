/*
 * The on-device interpreter: a small instruction-tuned model run in the browser over WebGPU by
 * WebLLM, loaded from a CDN only when the engineer asks for it, its weights cached by the
 * browser after the first download. Nothing leaves the device.
 *
 * The reply is constrained to the JSON schema the interpreter asks for, so it is always
 * well-formed; only the mapping can be wrong, and the engineer confirms every candidate.
 */

const LIBRARY = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm";
/* Small models, in order of preference; the first one WebLLM's registry knows is used. */
const MODELS = ["gemma-3-1b-it-q4f16_1-MLC", "gemma-2-2b-it-q4f16_1-MLC", "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "Llama-3.2-1B-Instruct-q4f16_1-MLC"];

export async function load(onProgress = () => {}) {
  onProgress({ text: "Loading the interpreter's code…", progress: 0 });
  const webllm = await import(/* webpackIgnore: true */ LIBRARY);
  const known = new Set((webllm.prebuiltAppConfig?.model_list ?? []).map((m) => m.model_id));
  const model = MODELS.find((m) => known.has(m));
  if (!model) throw new Error("none of the small models this page knows is in the interpreter's registry");
  const engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r) => onProgress({ text: r.text, progress: r.progress }),
  });
  return {
    model,
    async status() { return { available: true, reason: "", model }; },
    async complete(prompt, schema, progress = () => {}) {
      progress({ text: "Reading the notes…", progress: 1 });
      const reply = await engine.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object", schema: JSON.stringify(schema) },
      });
      return reply.choices?.[0]?.message?.content ?? "";
    },
  };
}
