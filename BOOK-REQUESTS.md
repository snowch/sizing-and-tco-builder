# Requests to the book

Changes the builder would need from *Sizing and TCO*, each with the reason. The builder does not
change the book. Its engine matches the book exactly, including where the book is loose; where
the interface asks more of a reader than the book checks, it says so on screen.

Every finding below was checked against the book's own toolkit at the commit in
[`book.lock.json`](book.lock.json), and names the conformance case that shows it. Run
`python3 conformance/generate.py` and read the case's fixture to see what the toolkit said.

## Open

None. Every request below has been closed by the book.

## Closed by the book

The last two at `4225e27`:

- **2. The book publishes the conformance suite.** It does, in its own `conformance/` folder, from
  this repository's cases, codes and fixture layout. The builder still generates its own, pinned,
  so it can add a case the day it finds a gap; reading the book's instead is a later step.
- **12. A reader's own measurement has nowhere to go.** A model may carry a `results/` folder beside
  its `scenarios/`, read before the book's own results and held to an `estate` result's disclosure
  (system, window, date, and the implementation it was taken on). The builder does not write one
  yet; it is its next step.

The same commit moved the format to `dsl: 2`: a key the loader does not read is refused, naming
the nearest one it does (`invalid/unknown-model-key`, `invalid/unknown-node-key`,
`invalid/key-of-another-kind`, `invalid/unknown-provenance-key`, `invalid/unknown-correlation-key`,
`invalid/unknown-scenario-key`); a uniform range whose minimum is above its maximum is refused
(`invalid/uniform-backwards`); only an answer must be in the model's currency, so a price quoted
in another is converted by a rate (`edge/price-in-another-currency`); and a measurement's unit is
compared by what it means, not how it is spelled (`edge/measured-unit-spelled-differently`).

The first eleven at `156e02b` ("Close the holes the model builder's conformance suite found"). Each is
now a case the book's toolkit is asked about on every run, so a rule that loosens again fails the
generator.

| | Request | What the book does now | Case |
|---|---|---|---|
| 1 | A `dsl:` format version | `DSL_VERSION` (1 then, 2 since `4225e27`). The loader refuses another version; `verify-models.py` reports a file that does not say. The builder writes the line first. | `invalid/dsl-other-version`, `invalid/dsl-missing` |
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
