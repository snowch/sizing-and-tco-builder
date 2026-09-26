#!/usr/bin/env python3
"""The book's own toolkit reads what the builder writes, and finds the same model.

The engine loads every conformance case the book loads, writes it back out as the builder would
(``conformance/write-cases.mjs``), and this hands each written file to the book's toolkit at the
pinned commit. For each case it must find:

- the same model: every node's fields, the outputs, the correlations, the title and description;
- the same scenarios: every field but the path, and the same value for every node at the point;
- the same ``verify-models.py`` verdicts, compared by code as the conformance suite compares them.

Comments and fields the book's loader does not read are not part of a model, and are not kept.

    python3 conformance/roundtrip.py
"""

from __future__ import annotations

import dataclasses
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import generate  # noqa: E402  (the checkout, the environment, and the problem codes)


def outside() -> int:
    pin = generate.lock()
    generate.ensure_checkout(pin["repository"], pin["commit"])
    python = generate.ensure_environment()
    written = subprocess.run(
        ["node", str(HERE / "write-cases.mjs")], capture_output=True, text=True, check=True
    ).stdout
    with tempfile.TemporaryDirectory() as directory:
        payload = Path(directory) / "written.json"
        payload.write_text(written)
        completed = subprocess.run([str(python), str(Path(__file__).resolve()), "--inside", str(payload)])
    return completed.returncode


def same_number(a, b) -> bool:
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return a == b


def fields(obj, skip=("path",)) -> dict:
    return {f.name: getattr(obj, f.name) for f in dataclasses.fields(obj) if f.name not in skip}


def inside(payload_path: Path) -> int:
    dsl, evaluate, expr, mc, units, verify = generate.book_modules()
    results = generate.LocalResults(dsl, verify)
    cases = json.loads(payload_path.read_text())
    sources = {case_id: (directory, in_book) for case_id, directory, in_book in generate.case_sources()}
    staging = generate.CHECKOUT / "_builder_roundtrip"
    problems: list[str] = []
    try:
        for case_id, written in sorted(cases.items()):
            directory, _ = sources[case_id]
            results.install(written["results"])

            def place(name: str, files: dict[str, str]) -> Path:
                where = staging / case_id.replace("/", "--") / name
                shutil.rmtree(where, ignore_errors=True)
                for path, text in files.items():
                    (where / path).parent.mkdir(parents=True, exist_ok=True)
                    (where / path).write_text(text)
                return where

            original = place("original", generate.read_case_files(directory))
            rewritten = place("written", written["files"])
            a = dsl.load_model(original / "model.yaml")
            b = dsl.load_model(rewritten / "model.yaml")

            for name in ("name", "title", "currency", "outputs", "correlations", "description"):
                if getattr(a, name) != getattr(b, name):
                    problems.append(f"{case_id}: model.{name} differs")
            if list(a.nodes) != list(b.nodes):
                problems.append(f"{case_id}: the nodes are not the same, in the same order")
            for name in a.nodes:
                if name in b.nodes and a.nodes[name] != b.nodes[name]:
                    fa, fb = fields(a.nodes[name]), fields(b.nodes[name])
                    changed = sorted(k for k in fa if fa[k] != fb.get(k))
                    problems.append(f"{case_id}: node {name} differs in {changed}")

            scenarios_a = {s.name: s for s in dsl.scenarios_for(a)}
            scenarios_b = {s.name: s for s in dsl.scenarios_for(b)}
            if set(scenarios_a) != set(scenarios_b):
                problems.append(f"{case_id}: the scenarios differ")
            for name in sorted(set(scenarios_a) & set(scenarios_b)):
                if fields(scenarios_a[name]) != fields(scenarios_b[name]):
                    problems.append(f"{case_id}: scenario {name} differs")
                try:
                    pa = evaluate.point(a, scenarios_a[name])
                except Exception as exc:  # the same refusal on both sides is agreement
                    pa = type(exc).__name__
                try:
                    pb = evaluate.point(b, scenarios_b[name])
                except Exception as exc:
                    pb = type(exc).__name__
                if isinstance(pa, str) or isinstance(pb, str):
                    if pa != pb:
                        problems.append(f"{case_id}: scenario {name} evaluates on one side only")
                elif pa.keys() != pb.keys() or not all(same_number(pa[k], pb[k]) for k in pa):
                    problems.append(f"{case_id}: scenario {name} gives different values")

            def verdicts(model) -> list:
                found: list[str] = []
                crashed = None
                try:
                    verify.check_model(model, found)
                    verify.check_scenarios(model, found)
                except Exception as exc:
                    crashed = type(exc).__name__
                return sorted(
                    (p["code"], p.get("node") or "", p.get("part") or "", p.get("scenario") or "")
                    for p in map(generate.classify_problem, found)
                ) + ([("crashed", crashed)] if crashed else [])

            if verdicts(a) != verdicts(b):
                problems.append(f"{case_id}: verify-models.py says different things")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        results.install({})

    if problems:
        print("round trip: FAILED")
        for line in problems:
            print(f"  - {line}")
        return 1
    print(f"round trip: the book reads {len(cases)} written models as it reads the originals")
    return 0


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        return inside(Path(sys.argv[2]))
    return outside()


if __name__ == "__main__":
    sys.exit(main())
