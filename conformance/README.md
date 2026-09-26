# The conformance suite

The builder's rules engine is JavaScript and the book's is Python. This directory holds them to
each other. Every case here is a model file the book's own toolkit has been asked about, and the
engine must give the same answer, or CI fails.

The book will publish this suite itself (design, *Repository*). Until it does, this directory is
the source, pinned to the book commit in [`../book.lock.json`](../book.lock.json). That file is the
only place the pin lives: the generator reads it, the fixtures record it, and the runner checks
the two agree.

## Running it

```bash
python3 conformance/generate.py          # write fixtures/ from the book at the pinned commit
python3 conformance/generate.py --check  # fail if fixtures/ is not what the book says now
python3 conformance/roundtrip.py         # the book reads what the engine writes as it reads the original
npm test                                 # hold the engine to fixtures/
```

`generate.py` needs Python 3.11 and network access the first time. It checks the book out into
`.book/checkout` by commit hash, makes a virtual environment from the book's own
`requirements.txt`, and runs itself again inside it. The fixtures have sorted keys and no
timestamps, so the same commit always writes the same bytes; `--check` compares numbers to a part in a trillion, because the book's own point values can differ
in the last bit between processors.

## What is here

| Path | What it is |
|---|---|
| `generate.py` | Asks the book's toolkit about every case and writes `fixtures/` |
| `cases/invalid/<name>/` | Hand-written models, one per refusal the loader and `verify-models.py` know |
| `cases/edge/<name>/` | Hand-written models the book accepts, each pinning down one exact behaviour |
| `probes/units.txt` | Unit strings; the engine must read each as the book's Pint registry does |
| `probes/formulas.txt` | Formulas; the engine must parse each to the same tree, or refuse it the same way |
| `probes/yaml.txt` | YAML documents; the engine must build the same typed Python values PyYAML does |
| `roundtrip.py`, `write-cases.mjs` | The engine writes every case back out; the book's toolkit must read the same model |
| `compare.js` | What counts as agreeing: codes, nodes and values, never message wording |
| `fixtures/` | Generated. Committed, so the engine's tests run with no Python and no network |

A case is a directory with `model.yaml`, `scenarios/*.yaml`, and a `case.yaml` saying what it is
for. A case that needs a stamped result the book does not have brings it in `results/`. The
reference models and every stage under `models/web_service/stages/` are read from the book's
checkout in place.

`case.yaml`'s `expect` lists the codes the case exists to show. The generator stops if the book no
longer says them, so a case cannot drift into testing something else, or nothing, as the book
changes.

## The fixtures

`manifest.json` names the book commit, the toolkit's versions (Python, numpy, Pint, PyYAML), every
code the generator knows, and the case list. It has a `dsl` slot for the format version the book
has planned; it is `null` until the book declares one.

`units.json` is Pint's registry reduced to a table (every unit's symbol, aliases, factor to base
units and dimensions; every prefix), with the verdict on each probe. The engine reads this table;
it does not carry a copy of Pint's definitions.

`formulas.json` is the list of allowed functions and the verdict on each formula probe.

`yaml.json` is each YAML probe's value as PyYAML builds it, with every Python type kept (`3` and
`3.0` differ, and so do `True` and `1`), because the book calls `str()` and `float()` on them. A
probe line starting `json:` is a JSON string, so a probe can hold a newline.

`results.json` is every stamped measurement a `measured` node can name, with the implementation
it was measured on. The builder offers these and no others.

`outline.json` is the book's chapter list by slug. The builder links a question to the chapter
that teaches it by slug, and shows the number from here, as the book does.

`cases/<group>/<name>.json`, one per case:

| Field | What the book said |
|---|---|
| `files`, `results` | The inputs: the model and scenario files as text, and any case-local results |
| `load` | `ok`, or the refusal: `code`, the `node` and `field` it names, the exception and message |
| `verify` | Every `verify-models.py` problem, each with `code`, `rule`, `node`, `part`, `scenario`, `cause`; and `crashed` where the verifier itself fell over |
| `model` | Classification, evaluation order, outputs, unmeasured constants, correlations |
| `nodes` | Per node: kind, unit, dimensions, the conversion factor(s), the magnitude used for the unit pass, what blocks it, and its fields |
| `scenarios` | Per scenario: every node's value at the point, and each ceiling's value, limit, margin and verdict; or the error |

## Codes

A message is classified by pattern into a code, so the engine is compared on *what* failed rather
than on the wording. A message that matches no pattern, or more than one, stops the generator: a
rule the book adds must arrive as a failure here, not be filed under "other".

Loader refusals: `load.yaml`, `load.not-a-mapping`, `load.missing-field`, `load.node-not-a-mapping`,
`load.unknown-kind`, `load.unknown-unit`, `load.formula-syntax`, `load.formula-function`,
`load.formula-keywords`, `load.formula-constant`, `load.formula-construct`, `load.unknown-reference`,
`load.unknown-output`, `load.cycle`, and `load.malformed` for a file the loader falls over on
without a worded refusal (a value that is not a number, a list where a mapping belongs).

`verify-models.py`, by its own rule numbers: `units.*` (1), `input.*` (2, 3), `measured.*` (4, 5),
`ceiling.*` (6), `shape.*` (7), `classification.*` (8), `scenario.*` (`check_scenarios`). A
scenario that does not evaluate also carries a `cause`: `typecheck`, `no-value`,
`no-measured-value`, `distribution`, `correlation` or `arithmetic`.

Every code has a case except `classification.definitional-with-ceilings`, which the book marks
unreachable by construction: a model with a ceiling is conditional by definition.

`check_stamps`, the ninth thing `verify-models.py` does, is about the book's own `bench/results/`
being current. It says nothing about a model file, and the suite does not cover it.

## Comparing

`compare.js` says what agreeing means. Values agree to a part in a billion of the value, the
tolerance the book holds its own browser evaluator to, plus 1e-15 absolute for values that cancel
to zero. Conversion factors agree to a part in a billion with no absolute allowance, because a
factor such as USD/TB/month's is 4.75e-20. `test/compare.test.js` checks the comparison accepts
the book's own answer and rejects changed ones; it caught the absolute allowance swallowing that
factor on its first run.
