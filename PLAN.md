# Plan

The Model Builder guides a reader through building a sizing and TCO model of their own system,
and writes the same YAML model files as the book *Sizing and TCO*. The specification is the book's
[`design/model-builder.md`](https://github.com/snowch/sizing-and-tco/blob/main/design/model-builder.md);
where this plan and the design differ, the design wins, and the differences are listed below.

## Reading of the design

- **The output is the book's file format, and nothing else.** The builder is a front end to the
  DSL. A reader can leave the builder and edit the file, and the book's viewer, checks and tests
  read what they built. What the format cannot express, the builder does not offer.
- **The engine is the book's rules, proven equal.** JavaScript for feedback on every keystroke,
  held to the book's Python by a conformance suite. The builder may not release while any case
  differs. The book will publish the suite; until then this repository generates it from the book
  at a pinned commit.
- **No numbers are filled in.** An input with no number is *not yet measured*, and so is
  everything downstream. The builder may preset a node's *kind* (from a pattern, or the hosts
  question), never its value. Measured constants come only from the book's stamped results.
- **Answer first.** The answer and its unit, the decision it feeds, the horizon, then work back:
  each node still *to define* is given, measured or worked out. Names in a formula that do not
  exist yet become new nodes to define, with their unit inferred where the formula fixes it.
- **The build's refusals are the wizard's gates.** The builder does not move on from an answer the
  book's build would refuse.
- **Refine once the tree is complete**, in the order that pays: sources, ceilings, ranges,
  measure first, scenarios.
- **The classification is worked out, never set**: a `measured` or `ceiling` node makes the model
  conditional (ch01).

## Where this plan departs from the prompt or the design

These are the places I read the two differently, or found the book says something else. Each is
a decision I have taken provisionally; say if you want it the other way.

1. **"Every rule in verify-models.py"** (prompt). Eight of its nine checks are about a model file
   and the engine implements all eight. The ninth, `check_stamps`, checks that the book's own
   `bench/results/` were produced by the code checked in. It says nothing about a reader's model,
   and the builder does not implement it.
2. **Measure first swings between p10 and p90, not the ends of the range.** The design says each
   shaped input is "moved from the low end of its range to the high end". The book's tornado
   (`sizing/evaluate.py`, `swing_of`) swings each input between the 10th and 90th percentile of
   its own shape, and a measured constant by ±1.28 standard errors. The DSL's `range:` is a
   different thing, the slider span. The builder follows the book.
3. **The answer's range is the book's, 5th to 95th.** The mock-up shows "the middle eight in ten";
   the book's `mc.interval` reports the 5th to the 95th. The builder follows the book.
4. **Chapter references are by slug.** The design and the prompt cite chapters by number. The book
   never uses a number as an identifier (its CLAUDE.md), and derives every number from its
   outline. The builder links each question to the chapter's slug and shows the number from the
   book's outline, which the generator exports (`fixtures/outline.json`). Where the design's
   number and the outline disagree, the outline wins: the design cites ch09 for measured
   constants, which the outline and `sizing/dsl.py` put in ch03 (*Where the numbers come from*).
5. **The engine is never stricter than the book.** The mock-up's build checks include "a pair that
   moves together has no reason", which the book does not check (BOOK-REQUESTS 7). The engine
   reports exactly what the book reports. The interface may ask for more (it always asks for a
   correlation's reason), and where it does it says it is the builder asking, not the build.
6. **Measured nodes offer the book's results or "not yet measured".** A reader's own measurement
   cannot be carried in the book's format today (BOOK-REQUESTS 12). The builder offers the book's
   four stamped constants with the implementation each was measured on, or a result name nobody
   has taken, which the book accepts and treats as not yet measured.
7. **Currency is USD only.** The book's unit registry has no other (BOOK-REQUESTS 4).
8. **The design's mixed-generations formula does not pass the book's rules as written**
   (BOOK-REQUESTS 6). Out of scope anyway: the prompt leaves several generations out until the
   book covers it, and the hosts question offers one kind or several roles only.

## Technology

Small on purpose. The builder is a handful of screens, a tree and a text file.

- **Plain JavaScript modules, no framework, no bundler, no build step.** The site is this
  repository's files served as they are, which is what GitHub Pages does. A framework's
  reactivity would earn its place in a large app with many views of shared state; here the state
  is one model and the views are redrawn from it on each change. Fewer dependencies is fewer
  things to pin, and the engine's tests run in Node directly.
- **One runtime dependency: [`yaml`](https://eemeli.org/yaml/)** (ISC licence), pinned in
  `package.json` and vendored into `vendor/` as an ES module so the site works offline. Chosen
  because the book reads model files with PyYAML, a YAML 1.1 parser, and this is the JavaScript
  parser that implements 1.1 (`yes` is true, a repeated key keeps the last). It also keeps
  comments on a round trip. The common alternative implements YAML 1.2 only.
- **Units from the book's Pint, not a JavaScript units library.** The generator reduces the book's
  pinned Pint registry to a table (every unit, alias, prefix, factor and dimension). The engine
  implements Pint's name lookup over that table (prefix, name, plural; `per`, `**`, `^`), and the
  unit probes hold it to Pint. A Pint upgrade in the book arrives as new fixtures.
- **A formula parser of our own**, recursive descent over the part of Python's expression grammar
  the book allows, refusing everything else with the book's codes. Held to the book by the
  formula probes (the book parses with Python's own `ast`, then whitelists).
- **Python's float rules where the book's verdict depends on them.** Where Python raises (division
  by zero, a logarithm of a negative, an overflow, a complex power), JavaScript quietly returns
  `NaN` or `Infinity`. The book's verdict *does not evaluate* depends on the raise, so the engine
  raises in the same places. The unit pass copies the book's too: it evaluates at the same
  plausible magnitudes, falls back to 0.37 where the book does, and treats a quantity compared
  with zero as Pint does.
- **Storage:** the reader's work is kept in the browser (`localStorage`, every access in
  `try`/`catch`), with copy, download and open-file for the model and each scenario. No backend.
- **Offline:** a service worker caching the site, as the book's own site does.
- **Tests:** `node:test` (built in) for the engine and the conformance runner; Playwright with the
  machine's Chromium for the interface's flows, from milestone 2; and the book's own toolkit, in
  the generator's environment, to load every file the builder writes and run `verify-models.py`
  over it.

## Milestones

Each is finished and verified before the next starts.

### 1. The engine and its conformance harness

Built (see *Status*). The engine, as modules under `engine/`:

| Module | What it does | Held to |
|---|---|---|
| `yaml.js` | Read a file as PyYAML does: the vendored `yaml` package for structure, PyYAML's own resolvers for types | YAML probes |
| `units.js` | Pint's preprocessing, tree builder and name lookup over the generated table | unit probes |
| `formula.js` | Python's expression grammar far enough to tell a syntax error from a refused construct; the book's whitelist, in its order | formula probes |
| `python.js` | `str()`, `float()`, sorted order, and float arithmetic that raises where Python's does | every case |
| `model.js` | Load and refuse, in the book's order; evaluation order (Kahn, sorted); ancestors; blocked chains; classification | load codes, `order`, `blocked_by` |
| `quantity.js` | Pint's quantity arithmetic for the unit pass, numpy's rules after a `sqrt` | `factor`, `units.*` |
| `evaluate.js` | Plausible magnitudes, the unit pass, the point, the ceiling report, the checks a scenario gets before sampling | `magnitude`, `point`, `ceilings`, causes |
| `verify.js` | `verify-models.py`'s eight model rules and `check_scenarios`, stopping where the book's verifier falls over | `verify.problems`, `crashed` |
| `write.js` | A document back to the book's format and layout, readable by PyYAML as written | round trip, in both languages |

Done when: every case and probe passes; CI is green on both jobs; every model the book loads is
written back out and read again, by the engine and by the book's toolkit, to the same nodes,
fields, outputs, correlations, scenarios, point values and build-check verdicts.

The engine will check the book's format version once the book declares one, and refuse a file
whose `dsl:` differs from the fixtures' (BOOK-REQUESTS 1). The writer already writes the line when
a document carries it.

### 2. The answer-first interface

Per the design, one question per screen, each naming the chapter that teaches it:

1. the answer, its name, label and unit (the unit read back as the toolkit reads it: a rate, a
   level, a length of time, a ratio);
2. the decision it feeds (kept in the model's `description`, the only place the format has for it);
3. the horizon, a decision, or an explicit "for today";
4. each node *to define*, breadth first from the outputs: given (unit, who decides, source kind
   and source), measured (a stamped result), or worked out (a formula, with the patterns table
   filtered to the node's unit, and unit inference for the new names it introduces).

Beside it: the live tree from each output, with *to define* and *waits on N to define* (never
*not yet measured*, which is for a missing measurement); the next-step bar; the build checks, live,
from the engine; the classification; the file, with copy.

Done when: scripted flows (Playwright) build models whose files load in the book's toolkit and pass
`verify-models.py`, including the tiny model from the conformance cases and a rebuild of stage 05
of the web service; no screen fills a number in; every screen works at phone width and offline;
and a test fails any interface text that names a product, using the book's own list from
`tests/test_book.py` (every file here passes that list today).

### 3. Refinements

Sources grouped by claim (fact, vendor claim, assumption; ch03); ceilings with a margin and a
reason (the queueing and headroom chapters); ranges in the four shapes, each named in its source
as the build requires; measure first (the tornado, p10 to p90, with the note that one input at a
time cannot show two that matter only together); scenarios, each its own file; and the hosts
question (one kind of host doing several jobs, with `max` of the chains; or several roles, with
the sum of the pools). Several generations is left out.

Done when: each refinement is covered by a flow whose file the book's toolkit accepts, and the
tornado agrees with the book's `tornado()` for the reference models (a fixture the generator
adds).

### 4. Sampling

Ranges with correlations, in JavaScript: this repository's own implementation of Iman and
Conover's method (Iman and Conover, 1982, *A distribution-free approach to inducing rank
correlation among input variables*, which the book cites as `@imanconover1982`), inverse
transform sampling from the same four percentile functions, and Acklam's inverse normal as the
book uses it. Checked against the book's ranges for the same file and seed. The builder's random
stream is its own, so the check is by distribution, not by draw, and the tolerance is stated from
the sampling error at the sample count (the square-root law the book derives in ch14): the
generator adds each sampled node's percentiles and the spread of those percentiles across
reseeds, and the builder's must fall inside it.

Done when: every output of both reference models and every scenario is within tolerance, with the
tolerance written next to the test.

## Status

### Milestone 1: done, and checked

- `book.lock.json` pins the book at `888ac509f2e923a50f6ac6b51153e2c1b6119172` (its `main` on
  2026-09-26). It is the only place the pin lives.
- `conformance/generate.py` checks the book out at that commit, builds an environment from the
  book's `requirements.txt` (numpy 2.4.6, Pint 0.25.3, PyYAML 6.0.1 on Python 3.11), and writes
  106 cases: both reference models, all 15 stages, 59 hand-written invalid models (one or more for
  every refusal the loader and `verify-models.py` know) and 30 edge cases; plus 190 unit probes,
  143 formula probes, 61 YAML probes, the measured-result catalogue (four constants) and the
  outline. `--check` regenerates and compares, numbers to a part in a trillion (the book's own
  point values differ in the last bit between processors; CI found that).
- Each hand-written case declares what it is for, and the generator refuses to write fixtures if
  the book does not say it. It stopped three times while the cases were written, each time
  correctly: a failure it had no code for, and one case whose expectation was mine and wrong.
- `npm test`: 194 passing, none failing. Every case and every probe agrees with the book; every
  model the book loads round-trips through the engine's writer; the comparison itself is tested
  against altered answers; the vendored YAML package is checked against the pinned install.
- `python3 conformance/roundtrip.py`: the book's toolkit reads all 76 writable models, as written
  by the engine, exactly as it reads the originals. Altering one written value, one scenario
  override or one `decided:` makes it fail, as it should.
- CI runs all of it on every push.

### Known gaps in the engine

- **A scenario whose draws alone go wrong.** The book's `verify-models.py` samples every scenario
  (100,000 draws by default) and refuses one whose sampled values are not finite, for example a
  square root of an input whose range crosses zero. The engine checks everything that can be
  known without drawing, and leaves this to milestone 4, which brings sampling. No case exercises
  it yet; milestone 4 adds one.
- **Offset and logarithmic units** (`degC`, `dB`): the book loads them; the engine refuses them
  rather than check them differently (BOOK-REQUESTS 5). The builder never offers them.
- **A mapping key YAML reads as something other than a string** (a node named `on` is the key
  `True` to PyYAML): the engine uses the key's text. No case covers it.
- **Integers in the unit pass.** After `ceil` or `floor` the book carries a Python integer, which
  cannot overflow when raised to a large power; the engine carries a float, which can. No
  realistic formula reaches it.

### Not started

Milestones 2 to 4. The GitHub Pages deploy comes with the first screen, in milestone 2 (Pages is
already set to deploy from Actions).

## Open questions

1. **Where a reader's model lives.** Browser storage plus copy, download and open-file, as the
   design suggests. One model at a time, or a list of them?
2. **The book's viewer.** Host it for a finished model, or link to it? Hosting means carrying the
   book's viewer code at the pinned commit; linking means the reader's model leaves the page.
3. **Refine before the tree is complete.** The design leaves it open. I plan the mock-up's rule:
   refinements unlock when nothing is left to define, because measuring first on half a model
   misleads.
4. **A reader's own measurements** (BOOK-REQUESTS 12). Until the book has a place for them, the
   builder offers only the book's constants or *not yet measured*.
5. **Licence.** This repository has none yet. The book's code is Apache-2.0; the same?
6. **The decision the answer feeds.** The format has no field for it, so it goes in the model's
   `description`. Would the book want a field of its own (design, *The flow*, step 2)?
