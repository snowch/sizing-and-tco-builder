/*
 * The rules engine: the book's loader, unit checks, evaluator and build checks, in JavaScript.
 *
 * Not built yet. This file fixes the interface the conformance runner (test/conformance.test.js)
 * holds the engine to, so the harness can be written and checked before the engine exists. Every
 * function below throws until milestone 1 replaces it; the runner reports each case as failing,
 * which is the honest state of an engine that does not exist.
 *
 * The shapes are the fixtures' own (conformance/fixtures/cases/*.json), so there is one
 * description of them: conformance/README.md.
 */

export const NOT_BUILT = "the rules engine is not built yet (milestone 1)";

/*
 * Everything the book's toolkit says about one model file and its scenarios.
 *
 *   files    { "model.yaml": text, "scenarios/<name>.yaml": text, ... }
 *   results  { <result name>: stamped payload }: the book's measured constants, plus any a case brings
 *   registry the unit table the book's Pint registry was reduced to (fixtures/units.json)
 *
 * Returns { load, verify, model, nodes, scenarios } in the fixtures' shape.
 */
export function report(_files, _context) {
  throw new Error(NOT_BUILT);
}

/* What the book's registry makes of one unit string: { ok, dimensionality, factor, multiplicative }. */
export function parseUnit(_text, _registry) {
  throw new Error(NOT_BUILT);
}

/* One formula as the book's parser reads it: { ok: true, tree } or { ok: false, code }. */
export function parseFormula(_text) {
  throw new Error(NOT_BUILT);
}
