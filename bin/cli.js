#!/usr/bin/env node
/*
 * sizing-and-tco-builder serve   the page, the solutions API and MCP over HTTP, on localhost
 * sizing-and-tco-builder mcp     MCP over stdio for a client that launches it, with the page served too
 *
 *   --dir <folder>   where solutions live   (default ~/sizing-and-tco-solutions)
 *   --port <n>       the page's port        (default 8765; another is taken if busy)
 *   --host <addr>    the address to listen on (default 127.0.0.1; 0.0.0.0 for an intranet host)
 *   --token <text>   required on every /api and /mcp request when set
 *   --no-page        with mcp: stdio only, serve nothing
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createMcp, serveStdio } from "../server/mcp.js";
import { baseUrl, createHandler, listen } from "../server/serve.js";
import { Workspace, loadContext } from "../server/workspace.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: "string" }, port: { type: "string", default: "8765" }, host: { type: "string", default: "127.0.0.1" }, token: { type: "string", default: "" }, "no-page": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
});
const command = positionals[0] ?? "serve";
if (values.help || !["serve", "mcp"].includes(command)) {
  process.stderr.write(`usage: sizing-and-tco-builder serve|mcp [--dir folder] [--port n] [--host addr] [--token text] [--no-page]\n`);
  process.exit(values.help ? 0 : 2);
}
const dir = values.dir ?? process.env.SIZING_SOLUTIONS_DIR ?? join(homedir(), "sizing-and-tco-solutions");
const ws = new Workspace(dir, loadContext());
const log = (text) => process.stderr.write(`${text}\n`);

let server = null;
if (command === "serve" || !values["no-page"]) {
  try {
    server = await listen(createHandler(ws, { token: values.token }), { host: values.host, port: Number(values.port) });
    ws.pageUrl = baseUrl(server, values.host);
    log(`Solutions in ${dir}`);
    log(`Page at ${ws.pageUrl}v2/  ·  API at ${ws.pageUrl}api/solutions  ·  MCP at ${ws.pageUrl}mcp (POST)`);
    if (values.host !== "127.0.0.1" && values.host !== "localhost" && !values.token) log("Listening beyond localhost with no --token: anyone on the network can read and change the solutions.");
  } catch (e) {
    if (command === "serve") { log(`Could not listen: ${e.message}`); process.exit(1); }
    log(`The page is not being served (${e.message}); MCP over stdio only.`);
  }
}
if (command === "mcp") {
  await serveStdio(createMcp(ws));
  server?.close();
}
