/*
 * Vendor neutrality, held to the book's own list.
 *
 * No product, vendor or cloud is named in the interface, the docs, the examples or the fixtures.
 * The list is the book's (tests/test_book.py, extracted by conformance/generate.py), so the two
 * repositories cannot disagree about what counts. Like the book's check, a list and not a
 * principle: it catches the names it has been told about.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const PRODUCTS = JSON.parse(readFileSync(join(ROOT, "conformance/fixtures/products.json"), "utf8"));
const SKIP = new Set(["node_modules", ".git", ".book", "vendor", "package-lock.json", "products.json"]);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:js|mjs|html|css|md|json|yaml|yml|txt|py)$/.test(name) ? [path] : [];
  });
}

test("the book's list of products is there to check against", () => {
  assert.ok(PRODUCTS.length > 10);
});

test("no file names a product", () => {
  const named = [];
  for (const path of files(ROOT)) {
    const body = readFileSync(path, "utf8").toLowerCase();
    for (const product of PRODUCTS) {
      if (new RegExp(`\\b${product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body)) named.push(`${path.slice(ROOT.length)}: ${product}`);
    }
  }
  assert.deepEqual(named, []);
});
