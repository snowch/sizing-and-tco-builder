#!/usr/bin/env python3
"""Ask the book's own toolkit about model files the builder wrote.

    python3 conformance/check-files.py DIR [DIR ...]

Each DIR holds a ``model.yaml`` and a ``scenarios/`` folder, as the builder writes them. For each,
the book's loader reads it and ``scripts/verify-models.py``'s model and scenario checks run over it,
at the pinned book commit, in the book's own environment. Prints one JSON line per directory, and
exits non-zero if the book refuses any of them. The builder's flow tests use this, so a file the
builder writes is held to the book itself, not only to the engine that copies it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import generate  # noqa: E402


def inside(directories: list[Path]) -> int:
    dsl, evaluate, expr, mc, units, verify = generate.book_modules()
    staging = generate.CHECKOUT / "_builder_written"
    failed = 0
    try:
        for directory in directories:
            where = staging / directory.name
            shutil.rmtree(where, ignore_errors=True)
            shutil.copytree(directory, where)
            entry: dict = {"directory": str(directory)}
            try:
                model = dsl.load_model(where / "model.yaml")
            except Exception as exc:
                entry.update(ok=False, refused=f"{type(exc).__name__}: {exc}")
                failed += 1
                print(json.dumps(entry))
                continue
            problems: list[str] = []
            try:
                verify.check_model(model, problems)
                verify.check_scenarios(model, problems)
            except Exception as exc:
                problems.append(f"verify-models.py fell over: {type(exc).__name__}: {exc}")
            points = {}
            for scenario in dsl.scenarios_for(model):
                try:
                    points[scenario.name] = {o: evaluate.point(model, scenario).get(o) for o in model.outputs}
                except Exception as exc:
                    points[scenario.name] = f"{type(exc).__name__}: {exc}"
            tornado = {}
            reference = next((s for s in dsl.scenarios_for(model) if s.name == "reference"), None)
            if reference is not None and not problems:
                for output in model.outputs:
                    tornado[output] = [
                        {k: bar[k] for k in ("node", "low", "high", "span")}
                        for bar in evaluate.tornado(model, reference, output)
                    ]
            entry.update(ok=not problems, problems=problems, classification=model.classification, points=points, tornado=tornado)
            failed += bool(problems)
            print(json.dumps(entry))
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return 1 if failed else 0


def main() -> int:
    if len(sys.argv) > 2 and sys.argv[1] == "--inside":
        return inside([Path(p).resolve() for p in sys.argv[2:]])
    pin = generate.lock()
    generate.ensure_checkout(pin["repository"], pin["commit"])
    python = generate.ensure_environment()
    return subprocess.run([str(python), str(Path(__file__).resolve()), "--inside", *sys.argv[1:]]).returncode


if __name__ == "__main__":
    sys.exit(main())
