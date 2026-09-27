# Requests to the book

Changes the builder would need from *Sizing and TCO*, each with the reason. The builder does not
change the book. Its engine matches the book exactly, including where the book is loose; where
the interface asks more of a reader than the book checks, it says so on screen.

Every finding below was checked against the book's own toolkit at the commit in
[`book.lock.json`](book.lock.json), and names the conformance case that shows it. Run
`python3 conformance/generate.py` and read the case's fixture to see what the toolkit said.

## Open

### 2. The book publishes the conformance suite

Until it does, `conformance/generate.py` here is the source, pinned to a commit. When the book
publishes the suite, the generator's cases, codes and fixture layout are offered as a starting
point, and the builder switches to reading the published fixtures.

### 12. A reader's own measurement has nowhere to go

A `measured` node reads a stamped result from the book's own `bench/results/`. That is right for
the book. A reader modelling their own system has measurements of their own (spans per request is
the book's example of one only the reader can take), and the format gives them two options: name a
result that does not exist, so the chain is *not yet measured*; or declare an `input` with
provenance `fact`, which makes the model definitional when it is not.

*Why it matters:* the builder may offer only the book's stamped results (the builder's rules say
so, and they are right to). A reader's model therefore can reach *conditional* only through the
book's own constants or a ceiling.
*Suggested:* a way for a model to carry a result beside it (for example `results/` next to
`scenarios/`, read before `bench/results/`), held to the same disclosure rules as an `estate`
result. The builder would then write one.

## Closed by the book

All eleven at `156e02b` ("Close the holes the model builder's conformance suite found"). Each is
now a case the book's toolkit is asked about on every run, so a rule that loosens again fails the
generator.

| | Request | What the book does now | Case |
|---|---|---|---|
| 1 | A `dsl:` format version | `DSL_VERSION = 1`. The loader refuses another version; `verify-models.py` reports a file that does not say. The builder writes `dsl: 1` first. | `invalid/dsl-other-version`, `invalid/dsl-missing` |
| 3 | Bytes are dimensionless | `bit` is `[information]`, so terabytes are a dimension of their own. | `invalid/bytes-are-information`, `invalid/plus-two-with-units` |
| 4 | Only one currency | 21 ISO currencies, each its own dimension. A model's `currency:` must be one of them, and money in another is refused. | `edge/currency-euro`, `invalid/currency-unknown`, `invalid/currency-another` |
| 5 | Offset and logarithmic units load | A unit that is not a ratio scale is refused. | `invalid/unit-offset`, `invalid/unit-logarithmic` |
| 6 | `max(0, need - held)` refused by the operand rule | A literal zero meets any unit. | `edge/max-with-zero` |
| 7 | Correlations not checked | Each pair names two quantities that vary, has `rho` from -1 to 1, and gives a reason. | `invalid/correlation-not-varying`, `invalid/correlation-rho-out-of-range`, `invalid/correlation-rho-a-word`, `invalid/correlation-no-reason`, `invalid/correlation-unchecked` |
| 8 | Any shape's name passes | The source must name the input's own shape, as a word. | `invalid/shape-named-loosely`, `invalid/shape-inside-another-word`, `edge/shape-in-a-longer-word` |
| 9 | The verifier falls over on two files | Both are reported as problems. | `invalid/distribution-two-shapes`, `invalid/scenario-missing-name`, `invalid/scenario-not-a-mapping` |
| 10 | YAML 1.1 quirks reach the model | A key written twice is refused, and so is a boolean or a word where a number belongs. | `invalid/duplicate-node-key`, `invalid/yaml-yes-is-one`, `invalid/value-not-a-number`, `invalid/range-a-word`, `invalid/shape-parameter-not-a-number`, `invalid/scenario-override-a-word` |
| 11 | `min` and `max` of fewer than two things | Refused when the formula is parsed. | `invalid/formula-min-of-one`, the formula probes |
| 13 | An empty `source:` or `because:` is the text "None" | An empty field is empty, and a blank unit is refused. | `invalid/source-left-empty`, `invalid/ceiling-reason-left-empty`, `invalid/unit-blank`, `invalid/missing-unit` |

Since the last pin the book has also added a model of two hardware generations in one pool
(`models/mixed_pool`, ch10), which the builder now reads as a reference case, samples, and offers
as an example.
