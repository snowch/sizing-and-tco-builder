/*
 * Keeps the builder usable with no network: every file the page needs is cached on first visit,
 * and served from the cache after that. A new version of the site replaces the cache, because
 * the cache's name carries the version.
 */

const VERSION = "builder-3";
/* Every file the page reaches. test/site.test.js fails if one is missing from this list. */
const FILES = [
  "./",
  "index.html",
  "app/explore.js",
  "app/guide.js",
  "app/judge.js",
  "app/table.js",
  "app/main.js",
  "app/state.js",
  "app/style.css",
  "app/ui.js",
  "app/view.js",
  "app/wizard.js",
  "app/words.js",
  "app/workbench.js",
  "app/worker.js",
  "data/examples.json",
  "data/outline.json",
  "data/results.json",
  "data/units.json",
  "engine/describe.js",
  "engine/evaluate.js",
  "engine/explore.js",
  "engine/formula.js",
  "engine/index.js",
  "engine/infer.js",
  "engine/model.js",
  "engine/python.js",
  "engine/quantity.js",
  "engine/sample.js",
  "engine/spreadsheet.js",
  "engine/template.js",
  "engine/tornado.js",
  "engine/units.js",
  "engine/verify.js",
  "engine/write.js",
  "engine/xlsx.js",
  "engine/yaml.js",
  "sw.js",
  "v2/index.html",
  "v2/app/evaluate.js",
  "v2/app/explain.js",
  "v2/app/interpret.js",
  "v2/app/interview.js",
  "v2/app/journey.js",
  "v2/app/main.js",
  "v2/app/parts.js",
  "v2/app/questions.js",
  "v2/app/remote.js",
  "v2/app/results.js",
  "v2/app/state.js",
  "v2/app/style.css",
  "v2/app/suggest.js",
  "v2/app/ui.js",
  "v2/app/webllm.js",
  "v2/templates/index.json",
  "v2/templates/infra.yaml",
  "v2/templates/services.yaml",
  "v2/templates/software.yaml",
  "vendor/yaml/compose/compose-collection.js",
  "vendor/yaml/compose/compose-doc.js",
  "vendor/yaml/compose/compose-node.js",
  "vendor/yaml/compose/compose-scalar.js",
  "vendor/yaml/compose/composer.js",
  "vendor/yaml/compose/resolve-block-map.js",
  "vendor/yaml/compose/resolve-block-scalar.js",
  "vendor/yaml/compose/resolve-block-seq.js",
  "vendor/yaml/compose/resolve-end.js",
  "vendor/yaml/compose/resolve-flow-collection.js",
  "vendor/yaml/compose/resolve-flow-scalar.js",
  "vendor/yaml/compose/resolve-props.js",
  "vendor/yaml/compose/util-contains-newline.js",
  "vendor/yaml/compose/util-empty-scalar-position.js",
  "vendor/yaml/compose/util-flow-indent-check.js",
  "vendor/yaml/compose/util-map-includes.js",
  "vendor/yaml/doc/Document.js",
  "vendor/yaml/doc/anchors.js",
  "vendor/yaml/doc/applyReviver.js",
  "vendor/yaml/doc/createNode.js",
  "vendor/yaml/doc/directives.js",
  "vendor/yaml/errors.js",
  "vendor/yaml/index.js",
  "vendor/yaml/log.js",
  "vendor/yaml/nodes/Alias.js",
  "vendor/yaml/nodes/Collection.js",
  "vendor/yaml/nodes/Node.js",
  "vendor/yaml/nodes/Pair.js",
  "vendor/yaml/nodes/Scalar.js",
  "vendor/yaml/nodes/YAMLMap.js",
  "vendor/yaml/nodes/YAMLSeq.js",
  "vendor/yaml/nodes/addPairToJSMap.js",
  "vendor/yaml/nodes/identity.js",
  "vendor/yaml/nodes/toJS.js",
  "vendor/yaml/parse/cst-scalar.js",
  "vendor/yaml/parse/cst-stringify.js",
  "vendor/yaml/parse/cst-visit.js",
  "vendor/yaml/parse/cst.js",
  "vendor/yaml/parse/lexer.js",
  "vendor/yaml/parse/line-counter.js",
  "vendor/yaml/parse/parser.js",
  "vendor/yaml/public-api.js",
  "vendor/yaml/schema/Schema.js",
  "vendor/yaml/schema/common/map.js",
  "vendor/yaml/schema/common/null.js",
  "vendor/yaml/schema/common/seq.js",
  "vendor/yaml/schema/common/string.js",
  "vendor/yaml/schema/core/bool.js",
  "vendor/yaml/schema/core/float.js",
  "vendor/yaml/schema/core/int.js",
  "vendor/yaml/schema/core/schema.js",
  "vendor/yaml/schema/json/schema.js",
  "vendor/yaml/schema/tags.js",
  "vendor/yaml/schema/yaml-1.1/binary.js",
  "vendor/yaml/schema/yaml-1.1/bool.js",
  "vendor/yaml/schema/yaml-1.1/float.js",
  "vendor/yaml/schema/yaml-1.1/int.js",
  "vendor/yaml/schema/yaml-1.1/merge.js",
  "vendor/yaml/schema/yaml-1.1/omap.js",
  "vendor/yaml/schema/yaml-1.1/pairs.js",
  "vendor/yaml/schema/yaml-1.1/schema.js",
  "vendor/yaml/schema/yaml-1.1/set.js",
  "vendor/yaml/schema/yaml-1.1/timestamp.js",
  "vendor/yaml/stringify/foldFlowLines.js",
  "vendor/yaml/stringify/stringify.js",
  "vendor/yaml/stringify/stringifyCollection.js",
  "vendor/yaml/stringify/stringifyComment.js",
  "vendor/yaml/stringify/stringifyDocument.js",
  "vendor/yaml/stringify/stringifyNumber.js",
  "vendor/yaml/stringify/stringifyPair.js",
  "vendor/yaml/stringify/stringifyString.js",
  "vendor/yaml/visit.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FILES)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

/* The network first, so a reader online always has the current site; the cache when offline. */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // The solutions API is live state on a server, never a file to keep.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      // Offline: the cached file, or the page of the folder asked for (/ or /v2/), or the front page.
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match(new URL("index.html", event.request.url).href)).then((hit) => hit ?? caches.match("index.html"))),
  );
});
