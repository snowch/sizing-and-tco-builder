/*
 * The site is complete as static files: every file the page reaches exists, and the offline
 * cache (sw.js) holds every one of them, so the builder reloads with no network.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

/* Every file reachable from index.html: its stylesheet and script, their static imports, and the data main.js fetches. */
export function reachable() {
  const seen = new Set();
  const queue = [];
  for (const page of ["index.html", "v2/index.html"]) {
    const html = readFileSync(join(ROOT, page), "utf8");
    for (const m of html.matchAll(/(?:href|src)="([^"#:]+\.(?:css|js))"/g)) queue.push(normalize(join(dirname(page), m[1])));
  }
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(/(?:from|import\s*\(?|new URL\()\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      queue.push(relative(ROOT, join(ROOT, dirname(file), m[1])));
    }
  }
  for (const main of ["app/main.js", "v2/app/main.js"]) {
    const text = readFileSync(join(ROOT, main), "utf8");
    for (const m of text.matchAll(/data\("([^"]+)"\)/g)) seen.add(`data/${m[1]}`);
  }
  // v2 fetches its part templates by the names index.json lists.
  seen.add("v2/templates/index.json");
  for (const part of JSON.parse(readFileSync(join(ROOT, "v2/templates/index.json"), "utf8")).parts) seen.add(`v2/templates/${part.file}`);
  return [...seen].sort();
}

test("every file the page reaches exists", () => {
  for (const file of reachable()) assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
});

test("the offline cache holds every file the page reaches", () => {
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const listed = new Set([...sw.matchAll(/^\s+"([^"]+)",$/gm)].map((m) => m[1]));
  const missing = reachable().filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], "add these to FILES in sw.js");
});

test("the page stands on its own: its words never send the reader to the book", () => {
  // Every explanation is complete without the book; the only way to it is a "Read more" link,
  // named by topic. So no text the page shows says "book" or cites a chapter by its number.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");
  const files = [join(ROOT, "index.html"), join(ROOT, "v2/index.html"), ...readdirSync(join(ROOT, "app")).filter((f) => f.endsWith(".js")).map((f) => join(ROOT, "app", f)), ...readdirSync(join(ROOT, "v2/app")).filter((f) => f.endsWith(".js")).map((f) => join(ROOT, "v2/app", f))];
  const found = [];
  for (const file of files) {
    code(readFileSync(file, "utf8")).split("\n").forEach((line, i) => {
      if (/\bbook(?:'s)?\b/i.test(line) || /\bch\d{2}\b/.test(line)) found.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, []);
});
