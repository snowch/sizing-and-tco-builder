/*
 * The Model Context Protocol, by hand: JSON-RPC 2.0 messages, one per line over stdio, or one
 * per POST over HTTP. The server offers tools and nothing else; it keeps no session state
 * beyond the solutions on disk, so any client that speaks the protocol's tools methods can use
 * it, and a request can be replayed.
 *
 *   initialize, notifications/initialized, ping, tools/list, tools/call
 */

import { createInterface } from "node:readline";

import { runTool, toolList } from "./tools.js";

export const PROTOCOL = "2025-06-18";
export const INFO = { name: "sizing-and-tco-builder", version: "2" };
export const INSTRUCTIONS = [
  "This server is a solution builder: it works out sizing and total cost from a model whose every input says where it came from.",
  "You read specifications, spreadsheets, notes and web pages; the engine does the arithmetic. Never type a figure into the model: call suggest_inputs with the value in the input's unit, its origin and the evidence you read it from. The engineer confirms each suggestion in the page.",
  "Start with list_questions, then start_solution, then missing_inputs; suggest what you can find; evaluate with provisional: true to show what the answer would be; explain to say why.",
].join(" ");

const error = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });

/* One message in, one response out, or null for a notification. */
export function createMcp(ws) {
  function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return error(null, -32600, "Invalid Request");
    const { id, method, params = {} } = message;
    const notification = id === undefined;
    if (typeof method !== "string") return notification ? null : error(id, -32600, "Invalid Request");
    if (method === "initialize") return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: INFO, instructions: INSTRUCTIONS });
    if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: toolList() });
    if (method === "tools/call") {
      const name = params?.name;
      if (typeof name !== "string") return error(id, -32602, "tools/call needs a tool name");
      let out;
      try {
        out = runTool(ws, name, params.arguments ?? {});
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `The tool failed: ${e?.message ?? e}` }], isError: true });
      }
      if (!out.ok) return reply(id, { content: [{ type: "text", text: `Refused: ${out.error}` }], isError: true });
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }], structuredContent: out.result });
    }
    return notification ? null : error(id, -32601, `Method not found: ${method}`);
  }
  /* A batch is answered as a batch; a parse failure as a single error. */
  function handleText(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return error(null, -32700, "Parse error"); }
    if (Array.isArray(parsed)) { const out = parsed.map(handle).filter(Boolean); return out.length ? out : null; }
    return handle(parsed);
  }
  return { handle, handleText };
}

/* Newline-delimited JSON over stdin and stdout, as an MCP client launches a local server. */
export function serveStdio(mcp, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const out = mcp.handleText(line);
    if (out) output.write(`${JSON.stringify(out)}\n`);
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
