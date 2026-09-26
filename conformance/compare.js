/*
 * What counts as the engine agreeing with the book, case by case.
 *
 * Compared on meaning, not wording: a refusal by its code and the node it names, a verify-models
 * problem by its code, node, part and scenario, a value to a part in a billion. Messages are not
 * compared -- the builder words its refusals for a reader, and the book words them for a build
 * log -- but a refusal for a different reason is a difference, which is why the codes exist.
 *
 * Returns a list of differences, empty when the engine agrees. Each is one line a person can act
 * on: where, what the book said, what the engine said.
 */

/*
 * A part in a billion, as tests/test_viewer.py holds the book's own browser evaluator to, but
 * relative to the value itself rather than to max(1, value). That floor suits the viewer's
 * values; it would accept any answer at all for a factor like USD/TB/month's 4.75e-20, and the
 * self-test in test/compare.test.js found exactly that. The absolute allowance is for values
 * only, where two languages' last-bit differences can cancel to 1e-17 against the book's 0.
 */
export const RELATIVE = 1e-9;
export const ABSOLUTE = 1e-15;

export function close(want, got, relative = RELATIVE, absolute = ABSOLUTE) {
  if (want !== null && typeof want === "object" && "nonfinite" in want) {
    const map = { nan: NaN, inf: Infinity, "-inf": -Infinity };
    return Object.is(map[want.nonfinite], got) || (Number.isNaN(map[want.nonfinite]) && Number.isNaN(got));
  }
  if (typeof want !== "number" || typeof got !== "number" || !Number.isFinite(got)) return false;
  return Math.abs(got - want) <= relative * Math.abs(want) + absolute;
}

/* JSON with sorted keys: the fixtures were written sorted, and an engine need not build its
 * objects in the same key order to mean the same thing. */
function canonical(value) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { nonfinite: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function dimensions(d) {
  return Object.fromEntries(Object.entries(d ?? {}).filter(([, v]) => v !== 0).sort());
}

function problemKey(p) {
  return [p.code, p.node ?? "", p.part ?? "", p.scenario ?? "", p.cause ?? ""].join(" | ");
}

export function compareCase(want, got) {
  const out = [];
  const where = (path) => `${want.id}: ${path}`;

  if (want.load.ok !== got.load?.ok) {
    out.push(where(`load: book ${want.load.ok ? "loads it" : `refuses it (${want.load.code})`}, engine ${got.load?.ok ? "loads it" : `refuses it (${got.load?.code})`}`));
    return out;
  }
  if (!want.load.ok) {
    for (const key of ["code", "node", "field", "ref"]) {
      if (key in want.load && want.load[key] !== got.load[key]) {
        out.push(where(`load.${key}: book ${JSON.stringify(want.load[key])}, engine ${JSON.stringify(got.load[key])}`));
      }
    }
    if (want.load.nodes && !same([...want.load.nodes].sort(), [...(got.load.nodes ?? [])].sort())) {
      out.push(where(`load.nodes: book ${want.load.nodes}, engine ${got.load.nodes}`));
    }
    return out;
  }

  // verify-models: the same problems, as a multiset, and a crash where the book's verifier crashes.
  const wanted = want.verify.problems.map(problemKey).sort();
  const gotten = (got.verify?.problems ?? []).map(problemKey).sort();
  if (!same(wanted, gotten)) {
    const missing = wanted.filter((k) => !gotten.includes(k));
    const extra = gotten.filter((k) => !wanted.includes(k));
    out.push(where(`verify: missing [${missing.join("; ")}], extra [${extra.join("; ")}]`));
  }
  if (Boolean(want.verify.crashed) !== Boolean(got.verify?.crashed)) {
    out.push(where(`verify: the book's verifier ${want.verify.crashed ? "falls over" : "runs"} on this file, the engine's ${got.verify?.crashed ? "falls over" : "runs"}`));
  }

  for (const key of ["classification", "order", "unmeasured", "outputs"]) {
    if (!same(want.model[key], got.model?.[key])) {
      out.push(where(`model.${key}: book ${JSON.stringify(want.model[key])}, engine ${JSON.stringify(got.model?.[key])}`));
    }
  }

  for (const [name, node] of Object.entries(want.nodes)) {
    const mine = got.nodes?.[name];
    if (!mine) {
      out.push(where(`node ${name}: missing from the engine`));
      continue;
    }
    if (node.kind !== mine.kind) out.push(where(`node ${name}.kind: book ${node.kind}, engine ${mine.kind}`));
    if (!same(dimensions(node.dimensionality), dimensions(mine.dimensionality))) {
      out.push(where(`node ${name}.dimensionality: book ${JSON.stringify(node.dimensionality)}, engine ${JSON.stringify(mine.dimensionality)}`));
    }
    for (const key of ["factor", "factor_limit", "factor_headroom", "magnitude"]) {
      if (key in node && !close(node[key], mine[key], RELATIVE, key === "magnitude" ? ABSOLUTE : 0)) {
        out.push(where(`node ${name}.${key}: book ${JSON.stringify(node[key])}, engine ${mine[key]}`));
      }
    }
    if (!same(node.blocked_by ?? null, mine.blocked_by ?? null)) {
      out.push(where(`node ${name}.blocked_by: book ${JSON.stringify(node.blocked_by)}, engine ${JSON.stringify(mine.blocked_by)}`));
    }
  }

  for (const [name, scenario] of Object.entries(want.scenarios)) {
    const mine = got.scenarios?.[name];
    if (!mine) {
      out.push(where(`scenario ${name}: missing from the engine`));
      continue;
    }
    for (const flag of ["load_error", "point_error"]) {
      if (Boolean(scenario[flag]) !== Boolean(mine[flag])) {
        out.push(where(`scenario ${name}.${flag}: book ${scenario[flag] ? "yes" : "no"}, engine ${mine[flag] ? "yes" : "no"}`));
      }
    }
    for (const [node, value] of Object.entries(scenario.point ?? {})) {
      if (!close(value, mine.point?.[node])) {
        out.push(where(`scenario ${name} point ${node}: book ${JSON.stringify(value)}, engine ${mine.point?.[node]}`));
      }
    }
    for (const node of Object.keys(mine.point ?? {})) {
      if (!(node in (scenario.point ?? {}))) out.push(where(`scenario ${name} point ${node}: the book has no value, the engine has one`));
    }
    for (const [node, ceiling] of Object.entries(scenario.ceilings ?? {})) {
      const theirs = mine.ceilings?.[node];
      if (!theirs || theirs.verdict !== ceiling.verdict) {
        out.push(where(`scenario ${name} ceiling ${node}: book ${ceiling.verdict}, engine ${theirs?.verdict}`));
        continue;
      }
      for (const key of ["value", "limit", "headroom", "allowed"]) {
        if (!close(ceiling[key], theirs[key])) {
          out.push(where(`scenario ${name} ceiling ${node}.${key}: book ${ceiling[key]}, engine ${theirs[key]}`));
        }
      }
    }
  }
  return out;
}

export function compareUnit(want, got) {
  if (want.ok !== got.ok) return [`unit ${JSON.stringify(want.unit)}: book ${want.ok ? "knows it" : "does not know it"}, engine ${got.ok ? "knows it" : "does not"}`];
  if (!want.ok) return [];
  const out = [];
  if (!same(dimensions(want.dimensionality), dimensions(got.dimensionality))) {
    out.push(`unit ${JSON.stringify(want.unit)}: book ${JSON.stringify(want.dimensionality)}, engine ${JSON.stringify(got.dimensionality)}`);
  }
  if (want.multiplicative !== got.multiplicative) out.push(`unit ${JSON.stringify(want.unit)}: multiplicative ${want.multiplicative} vs ${got.multiplicative}`);
  if (want.multiplicative && "factor" in want && !close(want.factor, got.factor, 1e-12, 0)) {
    out.push(`unit ${JSON.stringify(want.unit)}: factor ${want.factor} vs ${got.factor}`);
  }
  return out;
}

export function compareFormula(want, got) {
  if (want.ok !== got.ok) return [`formula ${JSON.stringify(want.formula)}: book ${want.ok ? "accepts it" : `refuses it (${want.code})`}, engine ${got.ok ? "accepts it" : `refuses it (${got.code})`}`];
  if (!want.ok) return want.code === got.code ? [] : [`formula ${JSON.stringify(want.formula)}: book ${want.code}, engine ${got.code}`];
  return same(want.tree, got.tree) ? [] : [`formula ${JSON.stringify(want.formula)}: book ${JSON.stringify(want.tree)}, engine ${JSON.stringify(got.tree)}`];
}

export function compareYaml(want, got) {
  if (want.ok !== got.ok) return [`yaml ${JSON.stringify(want.yaml)}: book ${want.ok ? "reads it" : "refuses it"}, engine ${got.ok ? "reads it" : `refuses it (${got.message})`}`];
  if (!want.ok) return [];
  return same(want.value, got.value) ? [] : [`yaml ${JSON.stringify(want.yaml)}: book ${JSON.stringify(want.value)}, engine ${JSON.stringify(got.value)}`];
}
