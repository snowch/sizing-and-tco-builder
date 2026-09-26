/*
 * The vendored copy of the YAML reader is the installed, pinned package, byte for byte.
 *
 * The site loads vendor/ because it has no build step; the tests and the engine's Node runs load
 * the same files. If someone updates one and not the other, this fails and says which file.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

function files(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, base) : [path.slice(base.length + 1)];
  });
}

test("vendor/yaml is node_modules/yaml/browser/dist", { skip: !existsSync(join(ROOT, "node_modules/yaml")) && "run npm ci first" }, () => {
  const installed = join(ROOT, "node_modules/yaml/browser/dist");
  const vendored = join(ROOT, "vendor/yaml");
  const want = files(installed).sort();
  assert.deepEqual(files(vendored).filter((f) => f !== "LICENSE").sort(), want);
  for (const file of want) {
    assert.ok(readFileSync(join(installed, file)).equals(readFileSync(join(vendored, file))), `vendor/yaml/${file} differs`);
  }
});
