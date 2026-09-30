#!/usr/bin/env python3
"""Write the conformance fixtures from the book's own toolkit, at the pinned commit.

The builder's rules engine is JavaScript. The book's is Python. A builder whose rules differ from
the book's writes files the book refuses, so every rule the builder knows is held to what the
book's toolkit says about a fixed set of cases, and CI fails on any difference.

This script is the source of those answers until the book publishes the suite itself. It does
three things:

1. Checks out the book at the commit in ``book.lock.json`` (the one place the pin lives) into
   ``.book/checkout``, and makes a virtual environment from the book's own ``requirements.txt``.
2. Runs itself again inside that environment, with the checkout on ``sys.path``, and asks the
   book's loader, ``check_units``, ``point`` and ``scripts/verify-models.py`` about every case.
3. Writes what they said to ``conformance/fixtures/``, as JSON with sorted keys and no
   timestamps, so that the same commit always writes the same bytes.

Nothing here decides anything. Where the toolkit refuses a file, the fixture records the refusal;
where it evaluates one, the fixture records the values. The only judgement this script adds is a
*code* for each message, so the JavaScript can be compared on what failed rather than on the
wording, and a message no pattern recognises stops the script: a rule the book has added must
arrive here as a failure, not be filed under "other".

    python3 conformance/generate.py            # write the fixtures
    python3 conformance/generate.py --check    # fail if the committed fixtures are not current
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOCK = ROOT / "book.lock.json"
BOOK = ROOT / ".book"
CHECKOUT = BOOK / "checkout"
CASES = HERE / "cases"
PROBES = HERE / "probes"
FIXTURES = HERE / "fixtures"
#: What the site reads at run time: the unit table, the measured constants, the book's outline.
DATA = ROOT / "data"

#: Where hand-written cases are copied inside the checkout, so that the book's messages name a
#: path relative to its own root and the fixtures do not depend on where a temporary directory was.
STAGING = "_builder_conformance"

#: Bumped when the fixture layout changes, so the JavaScript runner can refuse fixtures it does not
#: understand rather than misread them. Not the book's format version: that is ``dsl:``, when the
#: book adds it, and it will be recorded beside this.
FIXTURE_FORMAT = 1


# -- outside: the checkout and the environment ---------------------------------------------------


def lock() -> dict:
    return json.loads(LOCK.read_text())


def run(*args: str, cwd: Path | None = None) -> None:
    completed = subprocess.run(args, cwd=cwd)
    if completed.returncode:
        raise SystemExit(completed.returncode)


def ensure_checkout(repository: str, commit: str) -> None:
    """The book at exactly the pinned commit. Fetched by hash, so a moved branch cannot change it."""
    if (CHECKOUT / ".git").exists():
        current = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=CHECKOUT, capture_output=True, text=True, check=True
        ).stdout.strip()
        if current == commit:
            return
    else:
        CHECKOUT.mkdir(parents=True, exist_ok=True)
        run("git", "init", "--quiet", cwd=CHECKOUT)
        run("git", "remote", "add", "origin", repository, cwd=CHECKOUT)
    run("git", "fetch", "--quiet", "--depth", "1", "origin", commit, cwd=CHECKOUT)
    run("git", "checkout", "--quiet", "--force", "FETCH_HEAD", cwd=CHECKOUT)
    run("git", "clean", "-fdq", cwd=CHECKOUT)


def ensure_environment() -> Path:
    """A virtual environment with the book's pinned dependencies, keyed by the requirements file."""
    requirements = CHECKOUT / "requirements.txt"
    key = hashlib.sha256(requirements.read_bytes()).hexdigest()[:12]
    venv = BOOK / f"venv-{key}"
    python = venv / "bin" / "python"
    if not python.exists():
        run(sys.executable, "-m", "venv", str(venv))
        run(str(python), "-m", "pip", "install", "--quiet", "-r", str(requirements))
    return python


def outside(check: bool) -> int:
    pin = lock()
    ensure_checkout(pin["repository"], pin["commit"])
    python = ensure_environment()
    # Always into a fresh directory: a run that stops half way must not leave the committed
    # fixtures half written.
    target = Path(tempfile.mkdtemp(prefix="fixtures-")) / "fixtures"
    try:
        run(str(python), str(Path(__file__).resolve()), "--inside", "--out", str(target))
        # The site's data is generated with the fixtures and lives at the top, where the site is.
        shutil.move(str(target / "data"), str(target.parent / "data"))
        if check:
            return max(compare(target, FIXTURES), compare(target.parent / "data", DATA))
        shutil.rmtree(FIXTURES, ignore_errors=True)
        shutil.copytree(target, FIXTURES)
        shutil.rmtree(DATA, ignore_errors=True)
        shutil.copytree(target.parent / "data", DATA)
        return 0
    finally:
        shutil.rmtree(target.parent, ignore_errors=True)


#: How close a regenerated number must be to the committed one. Not zero: numpy's ``log`` and
#: ``exp`` may differ in the last bit between processors, and the book's point values for a
#: lognormal input pass through both. Far tighter than anything the engine is held to.
CHECK_RELATIVE = 1e-12


def differences(want, have, path: str = "", scale: float = 0.0) -> list[str]:
    """Where two fixtures differ, as paths into the JSON, numbers compared to CHECK_RELATIVE.

    A tornado bar's ``span`` is its high end minus its low end, so a last-bit difference in either
    end is a larger part of the span than of the ends. It is compared at the ends' scale.
    """
    if isinstance(want, dict) and isinstance(have, dict):
        out = []
        ends = [abs(d[k]) for d in (want, have) for k in ("low", "high") if isinstance(d.get(k), (int, float))]
        for key in sorted(set(want) | set(have)):
            if key not in want or key not in have:
                out.append(f"{path}.{key}: only in {'the committed' if key in have else 'the fresh'} fixture")
            else:
                at = max(ends) if key == "span" and ends else 0.0
                out += differences(want[key], have[key], f"{path}.{key}", at)
        return out
    if isinstance(want, list) and isinstance(have, list):
        if len(want) != len(have):
            return [f"{path}: {len(have)} items committed, {len(want)} fresh"]
        return [d for i, (a, b) in enumerate(zip(want, have)) for d in differences(a, b, f"{path}[{i}]")]
    numbers = (int, float)
    if isinstance(want, numbers) and isinstance(have, numbers) and not isinstance(want, bool):
        if abs(want - have) <= CHECK_RELATIVE * max(abs(want), abs(have), scale):
            return []
    elif want == have:
        return []
    return [f"{path}: committed {have!r}, fresh {want!r}"]


def compare(fresh: Path, committed: Path) -> int:
    def files(root: Path) -> dict[str, Path]:
        return {str(p.relative_to(root)): p for p in root.rglob("*.json")}

    want, have = files(fresh), files(committed)
    problems: dict[str, list[str]] = {}
    for name in sorted(set(want) | set(have)):
        if name not in have or name not in want:
            problems[name] = ["missing" if name not in have else "extra"]
            continue
        found = differences(json.loads(want[name].read_text()), json.loads(have[name].read_text()))
        if found:
            problems[name] = found
    if not problems:
        print(f"conformance fixtures: {committed.name}/ current ({len(want)} files)")
        return 0
    print("conformance fixtures: NOT current. Run `python3 conformance/generate.py` and commit.")
    for name, found in problems.items():
        print(f"  - {name}")
        for line in found[:8]:
            print(f"      {line[:300]}")
        if len(found) > 8:
            print(f"      ... and {len(found) - 8} more")
    return 1


# -- inside: asking the book -----------------------------------------------------------------------
#
# Everything below runs under the book's own interpreter and dependencies, with the checkout on
# sys.path. It imports the toolkit lazily so the outside half needs nothing but the standard library.


def book_modules():
    sys.path.insert(0, str(CHECKOUT))
    import yaml  # noqa: F401  (the book's pinned PyYAML)

    from sizing import dsl, evaluate, expr, mc, units

    spec = importlib.util.spec_from_file_location(
        "verify_models", CHECKOUT / "scripts" / "verify-models.py"
    )
    verify = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verify)
    return dsl, evaluate, expr, mc, units, verify


#: Every problem verify-models.py can report, as (code, rule, pattern). The rule number is the
#: script's own numbering; ``scenarios`` is ``check_scenarios``. A message that matches none of
#: these, or more than one, stops the generator.
PROBLEMS: tuple[tuple[str, str, str], ...] = (
    ("dsl.not-declared", "0", r"does not say which rules it is written against\. "),
    ("currency.unknown", "0", r"declares currency .*; expected an ISO code the registry defines: "),
    ("currency.another", "0", r"output '(?P<node>[^']+)' is in '[^']*', and the model declares `currency: "),
    ("units.does-not-typecheck", "1", r"node '(?P<node>[^']+)'(?P<part> limit| headroom)? does not typecheck\. `"),
    ("units.declared-vs-produced", "1", r"node '(?P<node>[^']+)'(?P<part> limit| headroom)? declares '[^']*', an? [a-z ]+, but `"),
    ("units.mixed-operands", "1", r"node '(?P<node>[^']+)'(?P<part> limit| headroom)? (?:adds|subtracts|takes the (?:min|max) of) quantities in "),
    ("units.rounds-in-wrong-unit", "1", r"node '(?P<node>[^']+)'(?P<part> limit| headroom)? rounds a number in "),
    ("input.decided", "2", r"input '(?P<node>[^']+)' declares decided "),
    ("input.provenance-kind", "2", r"input '(?P<node>[^']+)' declares provenance kind "),
    ("input.empty-source", "2", r"input '(?P<node>[^']+)' has an empty provenance source\."),
    ("input.shape-not-named", "2", r"input '(?P<node>[^']+)' is sampled as a \w+ and its provenance never says so\."),
    ("input.no-one-shape", "2", r"input '(?P<node>[^']+)' — "),
    ("input.fact-cites-nothing", "3", r"input '(?P<node>[^']+)' is declared a `fact` but its source cites nothing"),
    ("measured.no-result", "4", r"measured node '(?P<node>[^']+)' names no result file$"),
    ("measured.no-summary-value", "4", r"\S+\.json has no `summary\.value`, so node '(?P<node>[^']+)' has nothing to read$"),
    ("measured.unit-differs", "4", r"node '(?P<node>[^']+)' declares '[^']*' but \S+\.json measured '"),
    ("measured.no-uncertainty", "5", r"measured node '(?P<node>[^']+)' reports a standard error of "),
    ("ceiling.no-headroom", "6", r"ceiling '(?P<node>[^']+)' declares no headroom\."),
    ("ceiling.no-reason", "6", r"ceiling '(?P<node>[^']+)' gives no reason\."),
    ("correlation.not-varying", "2", r"a correlation names (?:'(?P<node>[^']*)'|\S+), which is neither an input with a shape nor a measured constant\."),
    ("correlation.rho", "2", r"the correlation between .* has rho .*; it is a number between -1 and 1$"),
    ("correlation.no-reason", "2", r"the correlation between .* gives no reason\. "),
    ("shape.feeds-no-output", "7", r"node '(?P<node>[^']+)' feeds no output\."),
    ("shape.no-outputs", "7", r"declares no outputs, so nothing in it can be checked$"),
    ("classification.measured-without-ceiling", "8", r"has measured constants but no ceiling\."),
    ("classification.definitional-with-ceilings", "8", r"classified as a definitional model but declares ceilings$"),
    ("scenario.does-not-load", "scenarios", r"a scenario file does not load — "),
    ("scenario.unknown-node", "scenarios", r"scenario '(?P<scenario>[^']+)' overrides '(?P<node>[^']+)', which is not a node$"),
    ("scenario.overrides-derived", "scenarios", r"scenario '(?P<scenario>[^']+)' overrides '(?P<node>[^']+)', which is derived\."),
    ("scenario.does-not-evaluate", "scenarios", r"scenario '(?P<scenario>[^']+)' does not evaluate — "),
)

#: Why a scenario did not evaluate, by the exception's text. Compared as well as the code, so a
#: JavaScript engine that refuses the right scenario for the wrong reason still fails.
CAUSES: tuple[tuple[str, str], ...] = (
    ("typecheck", r"does not typecheck, so it cannot be evaluated"),
    ("no-value", r"has neither a value nor a distribution"),
    # A measured node whose stamped result has no `summary.value`: the book reads it and gets a
    # KeyError, whose text is just the key.
    ("no-measured-value", r"does not evaluate — 'value'$"),
    ("distribution", r"_ppf\(\) (?:got an unexpected keyword argument|missing \d+ required positional argument)|uniform needs|triangular needs|lognormal needs|normal needs|a distribution declares exactly one shape"),
    # A pair missing `a`, `b` or `rho`: the book indexes it and gets a KeyError, whose text is the key.
    ("correlation", r"does not evaluate — '(?:a|b|rho)'$|correlation names|correlation between .* is .*outside|not mutually consistent|correlation matrix is"),
    # The sampler drew values that are not finite; the histogram of them refuses its range.
    ("sampling", r"autodetected range of .* is not finite"),
    ("arithmetic", r"division by zero|math domain error|Result too large|Numerical result out of range|cannot convert float|complex|out of range|overflow"),
)

#: Why the loader refused a file, by exception type and text.
REFUSALS: tuple[tuple[str, str], ...] = (
    ("load.not-a-mapping", r": is not a mapping$"),
    ("load.unknown-key", r": (?P<key>.*) is not a key this file may hold"),
    ("load.dsl-version", r": is written for dsl .*, and this toolkit reads dsl \d+$"),
    ("load.duplicate-key", r": line \d+: (?P<key>.*) is written twice in the same mapping"),
    ("load.not-a-number", r": (?P<field>value|range|samples|seed|override '[^']*'|\w+ \w+) is .*, which is not a number$"),
    ("load.no-unit", r"node '(?P<node>[^']+)' declares no unit\. "),
    ("load.not-ratio-scale", r"node '(?P<node>[^']+)' declares an unknown unit — unit .* is not a ratio scale: "),
    ("load.formula-arity", r"takes the (?:min|max) of fewer than two things"),
    ("load.missing-field", r"missing required field '(?P<field>[^']+)'$"),
    ("load.node-not-a-mapping", r"node '(?P<node>[^']+)' is not a mapping$"),
    ("load.unknown-kind", r"node '(?P<node>[^']+)' has kind "),
    ("load.unknown-unit", r"node '(?P<node>[^']+)' declares an unknown unit — unknown unit "),
    ("load.formula-syntax", r"does not parse \("),
    ("load.formula-function", r"calls '[^']*'\. A formula may call only"),
    ("load.formula-keywords", r"takes positional arguments only$"),
    ("load.formula-constant", r"(?<!, which) is not a number$"),
    ("load.formula-construct", r"which this language does not have\."),
    ("load.unknown-reference", r"node '(?P<node>[^']+)' refers to '(?P<ref>[^']+)', which this model does not define"),
    ("load.unknown-output", r"declares an output '(?P<node>[^']+)' that is not a node$"),
    ("load.cycle", r"depend on each other in a loop, so none of them can be evaluated: (?P<nodes>.*)$"),
)


def one_match(table, text: str, what: str):
    found = [(code, m) for code, *rest in table for m in [re.search(rest[-1], text)] if m]
    if len(found) != 1:
        raise SystemExit(
            f"generate: {len(found)} patterns match this {what}, expected exactly one. The book has "
            f"a rule or a wording this generator does not know; teach it before regenerating.\n"
            f"  {text}"
        )
    return found[0]


#: What precedes every problem: the model's path, and for a unit problem the model's name. Anchoring
#: on it matters, because a scenario that does not evaluate quotes the unit problem that stopped it.
PREFIX = r"^[^ ]+: (?:[^ ]+: )?"


def first_cause(text: str) -> str:
    """The first cause that fits, in the order of ``CAUSES``: a scenario that does not typecheck
    quotes the unit problem, and that problem's own text may look arithmetic."""
    for code, pattern in CAUSES:
        if re.search(pattern, text):
            return code
    raise SystemExit(f"generate: no cause matches this scenario failure; teach it.\n  {text}")


def classify_problem(text: str) -> dict:
    code, match = one_match([(c, PREFIX + p) for c, _, p in PROBLEMS], text, "verify-models problem")
    rule = next(r for c, r, _ in PROBLEMS if c == code)
    groups = {k: v for k, v in match.groupdict().items() if v is not None}
    entry = {"code": code, "rule": rule, "message": text}
    if "node" in groups:
        entry["node"] = groups["node"]
    if "scenario" in groups:
        entry["scenario"] = groups["scenario"]
    entry["part"] = (groups.get("part") or "").strip() or None
    if code == "scenario.does-not-evaluate":
        entry["cause"] = first_cause(text)
    return entry


def classify_refusal(exc: BaseException, yaml_module) -> dict:
    text = str(exc)
    entry: dict = {"exception": type(exc).__name__, "message": text}
    if isinstance(exc, yaml_module.YAMLError):
        return {"code": "load.yaml", **entry}
    if type(exc).__name__ in ("ModelError", "FormulaError"):
        code, match = one_match(REFUSALS, text, "loader refusal")
        entry["code"] = code
        groups = match.groupdict()
        node = groups.get("node") or (re.search(r"node '([^']+)'", text) or [None, None])[1]
        if node:
            entry["node"] = node
        if groups.get("field"):
            entry["field"] = groups["field"]
        if groups.get("ref"):
            entry["ref"] = groups["ref"]
        if groups.get("nodes"):
            entry["nodes"] = [n.strip() for n in groups["nodes"].split(",")]
        return entry
    # Not a refusal the loader words for a reader: a float() that could not convert, a field of
    # the wrong type. The file is still refused, and the builder must refuse it too.
    return {"code": "load.malformed", **entry}


def relative(text: str) -> str:
    """A message with the checkout's absolute path taken out, so fixtures do not depend on it."""
    return text.replace(str(CHECKOUT) + os.sep, "")


def dims(units_module, unit: str) -> dict[str, float]:
    return {str(k): float(v) for k, v in units_module.parse(unit).dimensionality.items()}


def clean(value):
    """JSON cannot hold an infinity or a NaN, and a fixture must say which one it was."""
    if isinstance(value, float):
        if math.isnan(value):
            return {"nonfinite": "nan"}
        if math.isinf(value):
            return {"nonfinite": "inf" if value > 0 else "-inf"}
        return value
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [clean(v) for v in value]
    return value


class LocalResults:
    """Stamped results a hand-written case carries, seen by the loader and the verifier alike.

    The book reads results from its own ``bench/results/``. A case that tests "a measured constant
    with no standard error" needs a result that says so, and the book has none, so the case brings
    one and both readers are pointed at it before the book's own directory.
    """

    def __init__(self, dsl, verify):
        self.dsl, self.verify = dsl, verify
        self.original = (dsl.load_result, dsl.result_exists, verify.load_result)
        self.local: dict[str, dict] = {}

    def install(self, local: dict[str, dict]) -> None:
        self.local = local
        book_load, book_exists, _ = self.original

        # The book's readers take the model's folder too, to look in its own results/ first; a
        # case's results are the book's kind, found before the book's own directory.
        def load(name, *beside):
            return json.loads(json.dumps(self.local[name])) if name in self.local else book_load(name, *beside)

        def exists(name, *beside):
            return name in self.local or book_exists(name, *beside)

        self.dsl.load_result, self.dsl.result_exists, self.verify.load_result = load, exists, load


#: The book's full models, each a case read in place.
REFERENCE = ("web_service", "observability", "mixed_pool", "sellers_tco")


def case_sources() -> list[tuple[str, Path, bool]]:
    """(id, directory, in the book) for every case, in a stable order."""
    out: list[tuple[str, Path, bool]] = []
    for name in REFERENCE:
        out.append((f"reference/{name}", CHECKOUT / "models" / name, True))
    for stage in sorted((CHECKOUT / "models" / "web_service" / "stages").iterdir()):
        if (stage / "model.yaml").exists():
            out.append((f"stages/{stage.name}", stage, True))
    for group in ("invalid", "edge"):
        for case in sorted((CASES / group).iterdir()):
            if (case / "model.yaml").exists():
                out.append((f"{group}/{case.name}", case, False))
    return out


def read_case_files(directory: Path) -> dict[str, str]:
    files = {"model.yaml": (directory / "model.yaml").read_text()}
    for path in sorted((directory / "scenarios").glob("*.yaml")):
        files[f"scenarios/{path.name}"] = path.read_text()
    return files


def run_case(case_id, directory, in_book, modules, results: LocalResults) -> dict:
    dsl, evaluate, expr, mc, units, verify = modules
    import yaml

    meta = {}
    if (directory / "case.yaml").exists():
        meta = yaml.safe_load((directory / "case.yaml").read_text()) or {}
    local = {p.stem: json.loads(p.read_text()) for p in sorted((directory / "results").glob("*.json"))}
    results.install(local)

    if in_book:
        where = directory
    else:
        where = CHECKOUT / STAGING / directory.name
        shutil.rmtree(where, ignore_errors=True)
        where.mkdir(parents=True)
        for name, text in read_case_files(directory).items():
            (where / name).parent.mkdir(parents=True, exist_ok=True)
            (where / name).write_text(text)

    out: dict = {
        "id": case_id,
        "about": meta.get("about", ""),
        "path": str((where / "model.yaml").relative_to(CHECKOUT)),
        "files": read_case_files(directory),
        "results": local,
    }

    try:
        model = dsl.load_model(where / "model.yaml")
    except Exception as exc:  # the loader's refusals are several exception types
        out["load"] = {"ok": False, **classify_refusal(exc, yaml)}
        expect_codes(meta, out, case_id)
        return out
    out["load"] = {"ok": True}

    problems: list[str] = []
    crashed = None
    try:
        verify.check_model(model, problems)
        verify.check_scenarios(model, problems)
    except Exception as exc:  # verify-models itself fell over: record it, the builder must refuse too
        crashed = {"exception": type(exc).__name__, "message": relative(str(exc))}
    out["verify"] = {
        "ok": not problems and crashed is None,
        "problems": [classify_problem(relative(p)) for p in problems],
        "crashed": crashed,
    }

    unit_problems, factors = evaluate.check_units(model)
    magnitudes = evaluate.plausible_magnitudes(model)
    blocked = model.blocked()
    nodes = {}
    for name in model.order:
        node = model.nodes[name]
        entry = {
            "kind": node.kind,
            "unit": node.unit,
            "dimensionality": dims(units, node.unit),
            "magnitude": magnitudes[name],
        }
        for key in (name, f"{name}.limit", f"{name}.headroom"):
            if key in factors:
                entry["factor" if key == name else f"factor_{key.split('.')[1]}"] = factors[key]
        if name in blocked:
            entry["blocked_by"] = list(blocked[name])
        if node.kind == "input":
            entry["decided"] = node.decided
            entry["provenance"] = {"kind": node.provenance.kind, "source": node.provenance.source}
            entry["value"] = node.value
            entry["distribution"] = node.distribution
            entry["range"] = list(node.slider) if node.slider else None
        elif node.kind == "derived":
            entry["formula"] = expr.parse(node.formula_text)
        elif node.kind == "measured":
            entry["result"] = node.result
            entry["measured"] = node.is_measured
            if node.is_measured:
                summary = node.measurement.get("summary", {})
                entry["measured_value"] = summary.get("value")
                entry["measured_sd"] = summary.get("sd", 0.0)
                entry["stack"] = node.stack
        else:
            entry["of"] = node.of
            entry["limit"] = node.limit
            entry["headroom"] = node.headroom
            entry["declares_headroom"] = node.declares_headroom
            entry["because"] = node.because
        nodes[name] = entry

    scenarios = {}
    for path in sorted((where / "scenarios").glob("*.yaml")):
        try:
            scenario = dsl.load_scenario(path)
        except Exception as exc:  # recorded under the file's name: the book could not read one
            scenarios[f"file:{path.name}"] = {
                "load_error": {"exception": type(exc).__name__, "message": relative(str(exc))}
            }
            continue
        report: dict = {
            "title": scenario.title,
            "overrides": scenario.overrides,
            "samples": scenario.samples,
            "seed": scenario.seed,
        }
        try:
            values = evaluate.point(model, scenario)
            report["point"] = values
            report["ceilings"] = evaluate.ceiling_report(model, values, {}, factors)
        except Exception as exc:
            report["point_error"] = {"exception": type(exc).__name__, "message": str(exc)}
        scenarios[scenario.name] = report

    out["model"] = {
        "name": model.name,
        "title": model.title,
        "currency": model.currency,
        "description": model.description,
        "outputs": list(model.outputs),
        "correlations": list(model.correlations),
        "classification": model.classification,
        "order": list(model.order),
        "unmeasured": list(model.unmeasured),
        "unit_problems": len(unit_problems),
    }
    out["nodes"] = nodes
    out["scenarios"] = scenarios
    expect_codes(meta, out, case_id)
    return out


def expect_codes(meta: dict, out: dict, case_id: str) -> None:
    """A hand-written case says what it is for, and the generator holds it to that.

    Without this a case meant to test one refusal can drift into testing another, or nothing, as
    the book changes -- and still pass, because the fixture would faithfully record whatever the
    book now says about it.
    """
    wanted = meta.get("expect")
    if not wanted:
        return
    got = {out["load"].get("code")} if not out["load"]["ok"] else {
        p["code"] for p in out["verify"]["problems"]
    } | ({"verifier.crashed"} if out["verify"]["crashed"] else set()) | (
        {"valid"} if out["verify"]["ok"] else set()
    )
    missing = set(wanted) - got
    if missing:
        MISMATCHED.append(
            f"case {case_id} is meant to show {sorted(missing)} and the book said "
            f"{sorted(c for c in got if c)}"
        )


#: Cases whose ``expect`` the book did not bear out, reported together at the end.
MISMATCHED: list[str] = []


def unit_table(units) -> dict:
    """Pint's registry, reduced to what an engine needs to parse a unit string the same way.

    From a fresh registry, not the one the cases have used: Pint adds each prefixed unit it meets
    to its table, so a used registry depends on the order the cases ran in.

    ``keys`` is every string Pint looks a unit up by (names, symbols and aliases) with the unit it
    names. ``prefixes`` and ``suffixes`` are in Pint's own order, because Pint takes the *first*
    reading of an ambiguous string (``min`` is a minute, not a milli-inch) and the order decides
    which is first. ``units`` holds, for every unit, the factor to the registry's base units, its
    dimensions, and whether it converts by a factor at all. The engine does not carry a copy of
    Pint's definitions: it reads this.
    """
    ureg = units.registry()
    table: dict = {
        "keys": {key: definition.name for key, definition in sorted(ureg._units.items())},
        "prefixes": [
            [key, definition.name, float(definition.converter.scale)]
            for key, definition in ureg._prefixes.items()
        ],
        "suffixes": [[key, value] for key, value in ureg._suffixes.items()],
        "units": {},
    }
    for name in sorted({definition.name for definition in ureg._units.values()}):
        definition = ureg._units[name]
        entry = {"multiplicative": bool(definition.is_multiplicative)}
        try:
            factor, _ = ureg.get_base_units(name)
            entry["factor"] = float(factor)
            entry["dimensionality"] = {
                str(k): float(v) for k, v in ureg.Unit(name).dimensionality.items()
            }
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
        table["units"][name] = entry
    # The ISO codes a model may declare as its `currency:`, each a dimension of its own.
    table["currencies"] = list(units.CURRENCIES)
    return table


def unit_probes(units, strings: list[str]) -> list[dict]:
    """What Pint makes of each probe: unknown, or its canonical units, dimensions and factor."""
    ureg = units.UNITS
    out = []
    for text in strings:
        entry: dict = {"unit": text}
        try:
            unit = units.parse(text)
        except Exception as exc:
            entry.update(ok=False, error=str(exc))
            out.append(entry)
            continue
        entry["ok"] = True
        entry["canonical"] = {str(k): float(v) for k, v in unit._units.items()}
        entry["dimensionality"] = {str(k): float(v) for k, v in unit.dimensionality.items()}
        # An offset (degC) or logarithmic (dB) unit converts, but not by a factor: Pint will turn
        # one degC into 274.15 K without complaint. Recorded so the builder can refuse to offer
        # them rather than compute with a factor that is not one.
        entry["multiplicative"] = all(ureg._units[name].is_multiplicative for name in unit._units)
        try:
            entry["factor"] = float(ureg.Quantity(1.0, unit).to_base_units().magnitude)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
        out.append(entry)
    return out


def typed(value):
    """A Python value with its type kept, so the engine is compared on what the book's str() and
    float() will see: 3 and 3.0 are different values, and so are True and 1."""
    import datetime

    if value is None:
        return {"py": "none"}
    if isinstance(value, bool):
        return {"py": "bool", "value": value}
    if isinstance(value, int):
        return {"py": "int", "value": str(value)}
    if isinstance(value, float):
        return {"py": "float", "value": repr(value)}
    if isinstance(value, str):
        return {"py": "str", "value": value}
    if isinstance(value, datetime.date):
        return {"py": "date", "value": str(value)}
    if isinstance(value, list):
        return {"py": "list", "items": [typed(v) for v in value]}
    if isinstance(value, dict):
        return {"py": "dict", "items": [[typed(k), typed(v)] for k, v in value.items()]}
    return {"py": type(value).__name__, "value": repr(value)}


def yaml_probes(strings: list[str]) -> list[dict]:
    """Each probe as PyYAML's safe_load builds it, and as the book's model reader does: that one
    refuses a key written twice, and so does not take a merge key either."""
    import yaml

    from sizing import dsl

    out = []
    for text in strings:
        try:
            entry = {"yaml": text, "ok": True, "value": typed(yaml.safe_load(text))}
        except yaml.YAMLError as exc:
            entry = {"yaml": text, "ok": False, "message": str(exc).splitlines()[0]}
        try:
            entry["read"] = {"ok": True, "value": typed(dsl.read_yaml(text, "probe"))}
        except yaml.YAMLError as exc:
            entry["read"] = {"ok": False, "code": "load.yaml", "message": str(exc).splitlines()[0]}
        except dsl.ModelError as exc:
            code, _ = one_match(REFUSALS, str(exc), "model reader refusal")
            entry["read"] = {"ok": False, "code": code, "message": str(exc)}
        except Exception as exc:  # an unhashable key: a TypeError, not a worded refusal
            entry["read"] = {"ok": False, "code": "load.malformed", "message": f"{type(exc).__name__}: {exc}"}
        out.append(entry)
    return out


def formula_probes(expr, strings: list[str]) -> list[dict]:
    out = []
    for text in strings:
        try:
            out.append({"formula": text, "ok": True, "tree": expr.parse(text)})
        except expr.FormulaError as exc:
            code, _ = one_match(REFUSALS, str(exc), "formula refusal")
            out.append({"formula": text, "ok": False, "code": code, "message": str(exc)})
        except Exception as exc:  # not worded as a refusal, but a refusal all the same
            out.append({"formula": text, "ok": False, "code": "load.malformed",
                        "message": f"{type(exc).__name__}: {exc}"})
    return out


def measured_catalogue() -> dict:
    """Every stamped measurement a ``measured`` node can name, with what it was measured on.

    The builder offers these and nothing else. Each is the stamped payload cut down to what the
    toolkit reads (``summary``'s value and standard error, ``units``' value) and what a reader
    should see beside it (the target, what produced it, the conditions it holds under). Results of
    ``kind: model`` are computations, not measurements, and have no ``summary.value`` to read.
    """
    out = {}
    for path in sorted((CHECKOUT / "bench" / "results").glob("*.json")):
        payload = json.loads(path.read_text())
        summary = payload.get("summary", {})
        if payload.get("kind") != "measurement" or "value" not in summary:
            continue
        out[path.stem] = {
            "kind": payload["kind"],
            "target": payload.get("target"),
            "summary": {key: summary[key] for key in ("value", "sd") if key in summary},
            "units": {key: payload.get("units", {})[key] for key in ("value", "sd") if key in payload.get("units", {})},
            "produced_by": payload.get("produced_by", {}),
            "conditions": payload.get("conditions", {}),
            "git_revision": payload.get("git_revision"),
        }
    return out


def outline() -> dict:
    """The book's chapters and appendices, with the label a reader sees and the page each is on.

    The book never uses a chapter number as an identifier: it derives each from its outline, so
    inserting a chapter renumbers every reference at once. The builder does the same, from here,
    and links a question to the chapter that teaches it by slug. A page is named for its slug
    (scripts/build-site.py, ``href_for``).
    """
    from bench.outline import APPENDICES, CHAPTERS

    page = lambda slug: f"{slug.replace('_', '-')}.html"  # noqa: E731
    return {
        "site": lock()["site"],
        "chapters": [
            {"label": c.label, "number": c.number, "slug": c.slug, "title": c.title, "part": c.part,
             "question": c.question, "page": page(c.slug)}
            for c in CHAPTERS
        ],
        "appendices": [
            {"label": a.label, "letter": a.letter, "slug": a.slug, "title": a.title, "page": page(a.slug)}
            for a in APPENDICES
        ],
    }


#: Cases whose sampled ranges the builder is held to, every scenario of each.
SAMPLED = (*(f"reference/{name}" for name in REFERENCE), "edge/all-four-shapes", "edge/strong-correlation")

#: How many other seeds each scenario is run with, to measure how far each figure moves by
#: chance alone at its sample count. That spread is the tolerance the builder is held to.
RESEEDS = 16

#: The figures compared, for every node that varies.
STATISTICS = ("p5", "p25", "p50", "p75", "p95", "mean")


def staged(case_id: str):
    """A case's model directory inside the checkout: in place for the book's own models."""
    directory = next(d for i, d, _ in case_sources() if i == case_id)
    if case_id.startswith(("reference/", "stages/")):
        return directory, lambda: None
    where = CHECKOUT / STAGING / directory.name
    shutil.rmtree(where, ignore_errors=True)
    where.mkdir(parents=True)
    for name, text in read_case_files(directory).items():
        (where / name).parent.mkdir(parents=True, exist_ok=True)
        (where / name).write_text(text)
    return where, lambda: shutil.rmtree(where, ignore_errors=True)


def sampling_fixture(case_id: str, modules) -> dict:
    """The book's sampled figures for every scenario of a case, and how far each moves by chance.

    For each scenario: every varying node's percentiles and mean at the scenario's own seed, and
    the standard deviation, least and greatest of each across RESEEDS further seeds; the same for
    each ceiling's share of draws over its allowed level. Draw for draw the builder cannot match
    the book (its random stream is its own), so it is held to these, by distribution.
    """
    import dataclasses
    import statistics

    dsl, evaluate, *_ = modules
    where, cleanup = staged(case_id)
    try:
        model = dsl.load_model(where / "model.yaml")
        out = {"case": case_id, "reseeds": RESEEDS, "scenarios": {}}
        for scenario in dsl.scenarios_for(model):
            runs = [evaluate.evaluate(model, scenario)]
            for k in range(1, RESEEDS + 1):
                runs.append(evaluate.evaluate(model, dataclasses.replace(scenario, seed=scenario.seed + 1000 * k)))
            first = runs[0]
            nodes = {}
            for name, summary in first.summaries.items():
                entry = {}
                for stat in STATISTICS:
                    others = [r.summaries[name][stat] for r in runs[1:]]
                    entry[stat] = {"value": summary[stat], "sd": statistics.stdev(others),
                                   "low": min(others), "high": max(others)}
                nodes[name] = entry
            ceilings = {}
            for name, report in first.ceilings.items():
                if "p_over_allowed" not in report:
                    continue
                others = [r.ceilings[name]["p_over_allowed"] for r in runs[1:]]
                ceilings[name] = {"value": report["p_over_allowed"], "sd": statistics.stdev(others),
                                  "low": min(others), "high": max(others)}
            out["scenarios"][scenario.name] = {"samples": scenario.samples, "seed": scenario.seed,
                                               "nodes": nodes, "ceilings": ceilings}
        return out
    finally:
        cleanup()


def tornado_fixture(case_id: str, modules) -> dict:
    """The book's tornado() for every output of a case, at its reference scenario."""
    dsl, evaluate, *_ = modules
    directory = next(d for i, d, _ in case_sources() if i == case_id)
    in_book = case_id.startswith("reference/")
    where = directory if in_book else CHECKOUT / STAGING / directory.name
    if not in_book:
        shutil.rmtree(where, ignore_errors=True)
        where.mkdir(parents=True)
        for name, text in read_case_files(directory).items():
            (where / name).parent.mkdir(parents=True, exist_ok=True)
            (where / name).write_text(text)
    try:
        model = dsl.load_model(where / "model.yaml")
        scenario = next(s for s in dsl.scenarios_for(model) if s.name == "reference")
        return {
            "case": case_id,
            "scenario": "reference",
            "outputs": {output: evaluate.tornado(model, scenario, output) for output in model.outputs},
        }
    finally:
        if not in_book:
            shutil.rmtree(where, ignore_errors=True)


def products() -> list[str]:
    """The book's list of product names, which no chapter, model or figure may use.

    Read from tests/test_book.py as a literal, without importing the book's tests. The builder
    holds its interface, docs and fixtures to the same list (test/neutrality.test.js).
    """
    import ast

    tree = ast.parse((CHECKOUT / "tests" / "test_book.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "PRODUCTS" for t in node.targets):
            return list(ast.literal_eval(node.value))
    raise SystemExit("generate: tests/test_book.py no longer defines PRODUCTS; teach the generator where it went.")


def examples() -> list[dict]:
    """The book's own models, for a reader to open and look around before starting their own.

    The files as the book has them, with the chapter each belongs to. They are the book's models
    with the book's numbers and sources; the builder shows them as that and never copies a number
    from one into a reader's model.
    """
    import yaml

    order = yaml.safe_load((CHECKOUT / "models" / "web_service" / "build-order.yaml").read_text())
    chapter_of = {stage["stage"]: stage["chapter"] for stage in order["stages"]}
    picks = [
        ("demand", CHECKOUT / "models" / "web_service" / "stages" / "05-demand", chapter_of["demand"]),
        ("web_service", CHECKOUT / "models" / "web_service", "the_sizing_model"),
        ("observability", CHECKOUT / "models" / "observability", "regime_changes"),
        ("mixed_pool", CHECKOUT / "models" / "mixed_pool", "bandwidth_and_the_binding_constraint"),
        ("sellers_tco", CHECKOUT / "models" / "sellers_tco", "the_sellers_tco"),
    ]
    out = []
    for name, directory, chapter in picks:
        files = read_case_files(directory)
        raw = yaml.safe_load(files["model.yaml"])
        out.append({"id": name, "title": " ".join(str(raw.get("title", raw["model"])).split()),
                    "chapter": chapter, "files": files})
    return out


#: The book's stamped chart data a chart in the builder is checked against, by result name.
CHARTS = ("seller",)


def chart_data(name: str) -> dict:
    """A stamped result's summary, with the commit it was stamped at, as the book wrote it."""
    payload = json.loads((CHECKOUT / "bench" / "results" / f"{name}.json").read_text())
    return {"name": name, "summary": payload["summary"], "units": payload.get("units", {})}


def probe_lines(name: str) -> list[str]:
    """One probe per line. A line starting ``json:`` is a JSON string, for probes with newlines."""
    lines = (PROBES / name).read_text().splitlines()
    return [
        json.loads(line[5:]) if line.startswith("json:") else line
        for line in lines
        if line.strip() and not line.startswith("#")
    ]


def write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(payload), indent=1, sort_keys=True, ensure_ascii=False) + "\n")


def inside(out: Path) -> int:
    modules = book_modules()
    dsl, evaluate, expr, mc, units, verify = modules
    import numpy
    import pint
    import yaml

    if out.exists():
        shutil.rmtree(out)
    results = LocalResults(dsl, verify)
    ids = []
    try:
        for case_id, directory, in_book in case_sources():
            write(out / "cases" / f"{case_id}.json", run_case(case_id, directory, in_book, modules, results))
            ids.append(case_id)
    finally:
        shutil.rmtree(CHECKOUT / STAGING, ignore_errors=True)
        results.install({})

    if MISMATCHED:
        print("generate: these cases do not show what they are for. Fix the case or its case.yaml.")
        for line in MISMATCHED:
            print(f"  - {line}")
        return 1

    write(out / "units.json", {
        "registry": unit_table(units),
        "probes": unit_probes(units, probe_lines("units.txt")),
    })
    write(out / "formulas.json", {
        "functions": sorted(expr.FUNCTIONS),
        "probes": formula_probes(expr, probe_lines("formulas.txt")),
    })
    write(out / "yaml.json", {"probes": yaml_probes(probe_lines("yaml.txt"))})
    write(out / "results.json", measured_catalogue())
    write(out / "products.json", products())
    # The data behind the book's own charts of a model, as the book stamped it: the Explore view
    # draws the same charts from the model and is held to these numbers.
    for chart in CHARTS:
        write(out / "charts" / f"{chart}.json", chart_data(chart))
    for case_id in (*(f"reference/{name}" for name in REFERENCE), "edge/all-four-shapes", "edge/measured-book-result"):
        write(out / "tornado" / f"{case_id}.json", tornado_fixture(case_id, modules))
    for case_id in SAMPLED:
        write(out / "sampling" / f"{case_id}.json", sampling_fixture(case_id, modules))
    write(out / "outline.json", outline())
    # What the site itself reads: the same three things, without the probes and cases.
    write(out / "data" / "units.json", unit_table(units))
    write(out / "data" / "results.json", measured_catalogue())
    write(out / "data" / "outline.json", outline())
    write(out / "data" / "examples.json", examples())

    write(out / "manifest.json", {
        "fixture_format": FIXTURE_FORMAT,
        "book": lock(),
        # The format version the book reads, and the builder writes as a model's first line.
        "dsl": dsl.DSL_VERSION,
        "toolkit": {
            "python": ".".join(map(str, sys.version_info[:2])),
            "numpy": numpy.__version__,
            "pint": pint.__version__,
            "pyyaml": yaml.__version__,
        },
        "rules": {
            "problems": [{"code": c, "rule": r} for c, r, _ in PROBLEMS],
            "refusals": ["load.yaml", *[c for c, _ in REFUSALS], "load.malformed"],
            "causes": [c for c, _ in CAUSES],
            "provenance_kinds": list(dsl.PROVENANCE_KINDS),
            "decided_by": list(dsl.DECIDED_BY),
            "shapes": list(mc.SHAPES),
            "currencies": list(units.CURRENCIES),
            "citation_markers": list(verify.CITATION_MARKERS),
        },
        "cases": ids,
    })
    print(f"generate: {len(ids)} cases written to {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if the fixtures are not current")
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--out", type=Path, default=FIXTURES, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inside:
        return inside(args.out)
    os.chdir(ROOT)
    return outside(args.check)


if __name__ == "__main__":
    sys.exit(main())
