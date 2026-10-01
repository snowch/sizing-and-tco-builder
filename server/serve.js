/*
 * One process for the engineer and the assistant: the v2 page served from this repository,
 * the solutions behind it over /api, and the MCP server over /mcp (HTTP) or stdio.
 *
 * It listens on localhost unless told otherwise. On an intranet host, --token makes every
 * /api and /mcp request carry it. Nothing here reaches outside the machine.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

import { createMcp } from "./mcp.js";
import { NAME, ROOT, Refused } from "./workspace.js";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".yaml": "text/yaml", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
const body = (req) => new Promise((resolve, reject) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts).toString("utf8"))); req.on("error", reject); });

/* The request handler, for a test to mount as well as for the command. */
export function createHandler(ws, { root = ROOT, token = "" } = {}) {
  const mcp = createMcp(ws);
  const allowed = (req) => !token || req.headers.authorization === `Bearer ${token}` || new URL(req.url, "http://x").searchParams.get("token") === token;
  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/mcp") {
        if (!allowed(req)) return json(res, 401, { error: "a token is required" });
        if (req.method !== "POST") return res.writeHead(405, { allow: "POST" }).end();
        const text = await body(req);
        const out = mcp.handleText(text);
        if (out === null) return res.writeHead(202).end();
        return json(res, 200, out);
      }
      if (url.pathname.startsWith("/api/")) {
        if (!allowed(req)) return json(res, 401, { error: "a token is required" });
        return await api(ws, req, res, url);
      }
      return serveFile(root, req, res, url);
    } catch (e) {
      if (e instanceof Refused) return json(res, 400, { error: e.message });
      json(res, 500, { error: String(e?.message ?? e) });
    }
  };
}

async function api(ws, req, res, url) {
  const m = /^\/api\/solutions(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: "not found" });
  const name = m[1] ? decodeURIComponent(m[1]) : null;
  if (!name) {
    if (req.method !== "GET") return res.writeHead(405, { allow: "GET" }).end();
    return json(res, 200, { solutions: ws.list() });
  }
  if (!NAME.test(name)) return json(res, 400, { error: "a solution's name is lower-case letters, digits and hyphens" });
  if (req.method === "GET") {
    if (!ws.exists(name)) return json(res, 404, { error: `no solution called "${name}"` });
    const r = ws.read(name);
    // A watcher asks for the version it has; the answer is 304 until the record moves on.
    if (url.searchParams.get("since") === String(r.version)) return res.writeHead(304).end();
    return json(res, 200, r);
  }
  if (req.method === "PUT") {
    const text = await body(req);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return json(res, 400, { error: "the body is not JSON" }); }
    if (!parsed?.state || typeof parsed.state !== "object" || parsed.state.version !== 2) return json(res, 400, { error: "the body is { version, state } with the page's state" });
    const written = ws.write(name, parsed.state, { version: typeof parsed.version === "number" ? parsed.version : null });
    return json(res, 200, { version: written.version, updated: written.updated });
  }
  return res.writeHead(405, { allow: "GET, PUT" }).end();
}

function serveFile(root, req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "") || "index.html";
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    // A folder asked for without its slash: the page's relative links need the slash.
    if (existsSync(file) && statSync(file).isDirectory()) return res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
    return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(req.method === "HEAD" ? undefined : readFileSync(file));
}

/* Listen; if the port is taken, take any free one and say so. */
export function listen(handler, { host = "127.0.0.1", port = 8765 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", (e) => {
      if (e.code !== "EADDRINUSE") return reject(e);
      const again = createServer(handler);
      again.once("error", reject);
      again.listen(0, host, () => resolve(again));
    });
    server.listen(port, host, () => resolve(server));
  });
}
export const baseUrl = (server, host) => { const a = server.address(); return `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${a.port}/`; };
