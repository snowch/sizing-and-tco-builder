# Requests to the book

Changes the builder would need from *Sizing and TCO*, each with the reason. The builder does not
change the book. Its engine matches the book exactly, including where the book is loose; where
the interface asks more of a reader than the book checks, it says so on screen.

Every finding below was checked against the book's own toolkit at the commit in
[`book.lock.json`](book.lock.json), and names the conformance case that shows it. Run
`python3 conformance/generate.py` and read the case's fixture to see what the toolkit said.

## Already planned by the book

### 1. A `dsl:` format version on every model file

The design adds a top-level `dsl: <version>` line that the loader checks. The builder is ready
for it: the fixture manifest has a `dsl` slot, `null` until the book's `sizing/dsl.py` declares a
version, and the builder will write the line and refuse a file whose version differs from the one
its suite was generated against.

### 2. The book publishes the conformance suite

Until it does, `conformance/generate.py` here is the source, pinned to a commit. When the book
publishes the suite, the generator's cases, codes and fixture layout are offered as a starting
point, and the builder switches to reading the published fixtures.

## Found while building the harness

### 3. Bytes are dimensionless

Pint's default registry defines `bit` as dimensionless, so `byte`, `TB` and every storage unit are
dimensionless too. A node declared in `TB` whose formula produces a pure number passes the unit
check, with a silent factor of 1.25e-13 (one over the bits in a terabyte). A model that multiplies
a growth factor and forgets the terabytes is not caught.

*Why it matters:* `sizing/units.py` makes requests, spans and series dimensions of their own so
that multiplying the wrong pair cannot give a plausible answer. Bytes are not among them, so a
byte count and a pure number are interchangeable, and the storage chain is where both reference
models do most of their arithmetic.
*Case:* `edge/bytes-are-dimensionless`.
*Suggested:* define `bit` (or `byte`) as a dimension of its own in `COUNTING_UNITS`, as the book
already does for `request` and `series`, and regenerate.

### 4. Only one currency exists

The registry defines `USD` and nothing else. `sizing/units.py` says a model "may declare another
— the dimension is what matters", and the model file has a `currency:` field, but `EUR` or `GBP`
is an unknown unit. A reader who prices in another currency cannot build a model.

*Why it matters:* the builder asks for the answer's unit first, and for a cost that is a currency.
It can offer only USD.
*Case:* the unit probes `EUR`, `GBP`, `euro` in `fixtures/units.json`.
*Suggested:* either define the currency the model's `currency:` field names as `[currency]`, or
say in the appendix that USD is the only one.

### 5. Offset and logarithmic units are in the registry

`sizing/units.py` says no temperature units are defined. The default Pint registry defines them,
and `degC` and `dB` load as node units. Pint converts one `degC` to 274.15 K, not by a factor, so
the evaluator's single conversion factor per node is wrong for them.

*Case:* the unit probes `degC`, `dB`, `decibel`.
*Suggested:* refuse non-multiplicative units in `parse`. The builder will not offer them either
way.

### 6. The design's mixed-generations formula is refused by the operand rule

The design's outline for mixed generations uses `max(0, need - existing_capacity)`. Pint allows a
quantity to be compared with zero, so the formula typechecks, and then the book's
mixed-operands rule refuses it, because a pure number (`0`) meets terabytes inside a `max`. The
scenario then does not evaluate.

*Why it matters:* this shape is how the book plans to write "how many new hosts to buy". The same
applies to any `max(0, …)` over a quantity with a unit.
*Case:* `edge/max-with-zero`.
*Suggested:* either write the zero as a node in the right unit (a `definition` input), or let a
literal zero meet any unit in the operand rule. Decide before the chapter is written, since the
builder will offer whichever the book adopts.

### 7. Correlations are not checked

`verify-models.py` does not look at `correlations:`. A pair naming a node that does not exist, a
derived node, or a pair with no `because` all pass. The appendix says "The reason is not
optional"; nothing enforces it. A pair naming an input that is pinned is dropped silently at
evaluation, which is intended; reading `sizing/evaluate.py`, a pair naming a node that does not
exist, or one that is not sampled, is dropped by the same line, which is not.

*Case:* `edge/correlation-unchecked`.
*Suggested:* a rule that each pair names two sampled inputs, has `rho` in [-1, 1] and a non-empty
`because`. Until then the builder always asks for a reason, and says on screen that this is the
builder asking, not the build.

### 8. The shape-naming check accepts any shape's name

Rule 2 passes a sampled input if any of the four shape names appears in its source. A triangular
input whose source says "a normal busy hour" passes, and every source that names `lognormal` also
names `normal`.

*Case:* `edge/shape-named-loosely`.
*Suggested:* check for the input's own shape. The builder writes the shape's name into the source
it helps a reader write.

### 9. Two files make `verify-models.py` fall over instead of reporting

- A scenario file with no `scenario:` key raises from `scenarios_for`, outside the `try` in
  `check_scenarios`. *Case:* `invalid/scenario-missing-name`.
- An input declaring two shapes, whose source names neither, raises while the verifier builds its
  message about the shape (`mc.one_shape`). *Case:* `invalid/distribution-two-shapes`.

The build still fails, which is the right outcome, but with a traceback rather than a problem a
reader can act on. The suite records both as `verifier.crashed`, so the builder must refuse the
same files.

### 10. YAML 1.1 quirks reach the model

The book reads model files with PyYAML, a YAML 1.1 parser. `value: yes` loads as `1.0`, and a node
name written twice keeps the second declaration without a word. The builder matches both, so that
it reads a file as the book does, and warns about them.

*Cases:* `edge/yaml-yes-is-one`, `edge/duplicate-node-key`.
*Suggested:* a loader that refuses duplicate keys (a custom PyYAML constructor does it in a few
lines).

### 11. `min` and `max` of fewer than two things parse

`min(a)` and `max()` are accepted by the formula parser and fail at evaluation. *Case:* the
formula probes `min(a)` and `max()` in `fixtures/formulas.json`.
*Suggested:* refuse them in `expr.parse`, where the reader would see which formula is wrong.

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

### 13. An empty `source:` or `because:` passes as the text "None"

A provenance written `source:` with nothing after it, or a ceiling's `because:` left empty, is
YAML's null. The loader calls `str()` on it and gets `"None"`, which is not blank, so rules 2 and 6
pass: an input with no source and a ceiling with no reason both build. The same `str()` turns
`decided: yes` into `"True"`, which rule 2 does catch.

*Why it matters:* "every number says where it came from" is invariant 4, and an empty line is the
commonest way to leave it unsaid.
*Case:* `edge/types-in-the-yaml`.
*Suggested:* treat a null source, reason or unit as missing rather than as the text `None`.
