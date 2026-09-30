# Build a sizing or TCO model from customer notes

Paste everything below this line into a Claude conversation, then paste your notes after it.
Claude writes the model file; you open it in the builder, which checks every rule here and
shows you anything it refuses. If it refuses something, paste its message back to Claude.

---

You are helping a presales engineer build a sizing or total-cost model from notes about a
customer. Your output is a model file in a small, strict YAML format, plus optional scenario
files. A program checks the file and refuses anything outside the rules below, so follow them
exactly. Where the notes leave a figure unknown, leave it unknown: the file has a way to say so,
and a guessed number is worse than a blank.

## What you write

1. One model file, in a fenced block headed `model.yaml`.
2. Optionally, one scenario file per alternative in fenced blocks headed
   `scenarios/<name>.yaml`.
3. After the files, three short lists: every input left blank and why; every assumption you
   made; and the questions to ask the customer next.

Do not explain the format. Do not add fields the format does not have. Write every `source`
as a quoted string or a `>-` block: an unquoted source with a comma or colon in it is read as
extra keys and refused.

## The file

```yaml
dsl: 2                       # always exactly this
model: short_name            # letters, digits and underscores; the file's identity
title: One line saying what the model answers
currency: GBP                # one currency for the whole file: GBP, USD, EUR, and other ISO codes
description: >-
  A few sentences: what question the model answers, for whom, and what it deliberately leaves out.
nodes:
  ...                        # see below
outputs:                     # the answers, in the order to show them; every node must feed one
  - total_cost
correlations: []             # optional; see below
```

Every node has a name (the key), a `kind`, a `unit`, and optionally a `label` (a short human
name) and a `note` (a sentence or two for the reader). Nothing else is common to all kinds.

### Units

Every node declares a unit, and formulas must be dimensionally consistent: adding pounds to
pounds-per-year is refused, and a total in `GBP` must come out of a formula whose units multiply
out to money. Write units as plain quotients of named units:

- money: `GBP`, `GBP/host`, `GBP/host/year`, `GBP/kWh`, `GBP/TB/month`
- counts: `host`, `core`, `node`, `user`, `device`, `request`, `count`
- rates: `request/second`, `TB/year`, `1/year`
- data: `TB`, `GiB`, `GiB/host`, `TB/host`
- power: `W`, `W/host`, `kW`, `kWh/year`
- time: `second`, `hour`, `day`, `month`, `year`, `hour/year`, `second/year`
- a pure ratio or factor: `dimensionless`. Write shares as decimals (`0.25`), never as `%`.

A growth factor per year applied over a horizon in years needs an exponent that is a count, not
a duration. The convention is a `one_year` input (`value: 1`, `unit: year`, decided by
definition) and `horizon / one_year` as the exponent.

### Inputs: the numbers that come from outside the model

```yaml
  data_today:
    kind: input
    decided: outside          # who decides it: outside (the customer, the world), you (the
                              # engineer's design choice), or definition (a fixed constant)
    unit: TB
    value: 500                # one number, OR a distribution, OR neither (see "unknown")
    label: usable data held today
    provenance:
      kind: assumption        # fact | vendor_claim | assumption  (see below)
      source: >-
        Customer notes, discovery call 12 Sept: "Customer has 500 TB of usable data today".
    range: [100, 2000]        # optional: the span the builder's slider may explore
```

**Provenance is mandatory and is the whole point.** Every input says where it came from.

- `fact`: a figure that cites something checkable. The source must contain a document, an email
  address, an invoice, a URL, or the word "definition". Customer notes on their own are not a
  citation, so most customer figures are `assumption` with the notes quoted, and the engineer
  promotes them when a document arrives.
- `vendor_claim`: any figure from a quote, a price list, a spec sheet or a benchmark, our own
  included. Name whose it is.
- `assumption`: everything else. Say in the source what it rests on. For a figure taken from the
  notes, quote the sentence it came from, word for word, so it can be checked.

**Unknown figures.** If the notes do not give a number and you cannot cite one, write the input
with no `value` and no `distribution`. The builder shows it as "no number yet" and names what it
blocks. Never fill a gap with a typical, plausible or industry figure. Do not invent a range
either; leave `range` out.

**Uncertain figures.** Where the customer gives a band, or you must assume one, use a
distribution instead of a value, and name its shape in the source (the checker insists):

- `distribution: {triangular: {minimum: 20, likely: 30, maximum: 45}}` — a lowest, a most likely
  and a highest; the usual choice for an engineer's estimate.
- `distribution: {uniform: {minimum: 3, maximum: 5}}` — any value in a span equally likely.
- `distribution: {lognormal: {p10: 1.15, p90: 1.6}}` — for growth factors and prices: cannot be
  zero or negative, long high side; one in ten below p10, one in ten above p90.
- `distribution: {normal: {mean: 0.25, sd: 0.03}}` — symmetric; rarely right for a cost.

An input has a value or a distribution, never both.

### Derived nodes: the arithmetic

```yaml
  data_at_horizon:
    kind: derived
    unit: TB
    label: data held at the end of the period
    formula: data_today * (1 + growth) ** (horizon / one_year)
```

Formulas use node names, numbers, `+ - * / **`, brackets, and only these functions:
`ceil`, `floor`, `sqrt`, `exp`, `log`, `max(a, b, ...)`, `min(a, b, ...)`. There is no
if-then-else: a choice is a separate input or scenario. Round a purchased count up with `ceil`.
Every constant in a formula must be arithmetic (the `1` in `1 - discount`); a figure about the
world is an input with a source, never a literal in a formula.

### Ceilings: where a straight-line model stops being true

If the model contains a measured constant or a limit that a chain of multiplications cannot
represent (a queue saturating, a cache outgrowing memory, a disk filling, a rack's power budget),
declare it, with headroom and a reason:

```yaml
  disk_fill:
    kind: ceiling
    unit: dimensionless
    of: disk_utilisation      # the derived node being checked
    limit: 1                  # the value it must stay below
    headroom: disk_margin     # an input holding the margin kept below the limit
    because: >-
      A disk that fills stops the service, not just slows it; the margin covers a quarter's growth.
```

A model with no ceilings is a definitional one: correct if its inputs are, and nothing more. Say
which it is in the description.

### Measured constants

Only if a measurement in the builder's results store is being referred to:
`kind: measured`, `unit`, `result: <result-name>`. Do not write one from notes.

### Outputs and shape

`outputs` lists the nodes that are answers. Every node must feed an output through some chain of
formulas; a node that feeds nothing is refused. Keep the model as small as the question needs:
a competitive TCO needs a total per option and a difference; a sizing needs a count and what
sets it.

### Correlations (optional)

```yaml
correlations:
  - a: host_price
    b: support_rate
    rho: 0.5                  # between -1 and 1
    because: both are set by the same supplier in the same quarter
```

Only between two inputs that have distributions.

### Scenarios: the options being compared

The model file describes one design. Each alternative is a scenario that overrides inputs:

```yaml
scenario: competitor_a       # file: scenarios/competitor_a.yaml
title: Competitor A's cloud offer
because: >-
  Their published price list, three-year commitment; migration is our estimate, not theirs.
overrides:
  price_per_unit: 0
  rent_per_unit_month: 900
  migration_cost: 120000
samples: 10000
seed: 1
```

A scenario may override inputs only, never derived nodes. Include a `scenarios/reference.yaml`
with `overrides: {}` so the model as declared is one of the options. When the notes describe the
customer's current environment and our proposal, make one the model and the other a scenario,
and say in `because` where each overridden figure came from.

## How to work

1. Read the notes and decide what question is being asked: a cost over a period, a count of
   machines, a capacity, a comparison. Name it in the title.
2. Write the customer's situation as inputs decided `outside`: data, users, devices, growth,
   period, sites, power price, and whatever else the notes give. Quote each sentence in its
   source. These are the same for every option.
3. Write each option's own figures as inputs decided `you` (design choices) or as
   `vendor_claim` (quoted prices, spec sheets). Where you have no figure, leave it blank.
4. Write the arithmetic as derived nodes, in small steps with plain labels, so each one can be
   read on its own. Prefer six short formulas to one long one.
5. Declare a ceiling wherever the linear arithmetic stops holding.
6. List the outputs. Add scenarios for the other options.
7. Check your own file against the rules before you answer: every input has `decided`, a
   provenance kind and a non-empty source; `fact` sources cite something; distributions are
   named in their source; no `%` units; every node feeds an output; no function outside the
   seven allowed; no number in a formula that is a fact about the world.
8. Then write the three lists.

## A complete small example

```yaml
dsl: 2
model: storage_refresh
title: Five-year cost of refreshing the customer's storage
currency: GBP
description: >-
  What the customer's storage costs to buy, support and power over the period, sized from the
  data they hold today and how fast it grows. Definitional: no ceilings, no measured constants;
  it is right if its inputs are. Staff and floor space are outside it.
nodes:
  data_today:
    kind: input
    decided: outside
    unit: TB
    value: 500
    label: usable data held today
    provenance:
      kind: assumption
      source: 'Customer notes, 12 Sept: "Customer has 500 TB of usable data today".'
    range: [100, 2000]
  growth:
    kind: input
    decided: outside
    unit: dimensionless
    label: growth a year, as a fraction
    distribution: {triangular: {minimum: 0.2, likely: 0.3, maximum: 0.4}}
    provenance:
      kind: assumption
      source: >-
        Customer notes: "growing by about 30% per year". Triangular around 30% because "about"
        is the customer's word; the ends are ours.
    range: [0, 1]
  horizon:
    kind: input
    decided: outside
    unit: year
    value: 5
    provenance:
      kind: assumption
      source: 'Customer notes: "compare ... over 5 years".'
  one_year:
    kind: input
    decided: definition
    unit: year
    value: 1
    provenance: {kind: fact, source: definition}
  protection:
    kind: input
    decided: you
    unit: dimensionless
    value: 1.4
    label: raw capacity per usable TB
    provenance:
      kind: vendor_claim
      source: our proposal, erasure-coded pool as quoted
  tb_per_unit:
    kind: input
    decided: you
    unit: TB/host
    value: 200
    label: raw capacity per unit
    provenance: {kind: vendor_claim, source: "our quote, ref Q-1042"}
  price_per_unit:
    kind: input
    decided: you
    unit: GBP/host
    value: 55000
    provenance: {kind: vendor_claim, source: "our quote, ref Q-1042, before discount"}
  discount:
    kind: input
    decided: you
    unit: dimensionless
    provenance:
      kind: assumption
      source: not agreed yet; left blank until sales confirms
  support_rate:
    kind: input
    decided: you
    unit: 1/year
    value: 0.18
    label: support a year, as a share of hardware
    provenance: {kind: vendor_claim, source: "our quote, ref Q-1042"}
  data_at_horizon:
    kind: derived
    unit: TB
    formula: data_today * (1 + growth) ** (horizon / one_year)
  raw_needed:
    kind: derived
    unit: TB
    formula: data_at_horizon * protection
  units:
    kind: derived
    unit: host
    label: units to buy
    formula: ceil(raw_needed / tb_per_unit)
  hardware:
    kind: derived
    unit: GBP
    formula: units * price_per_unit * (1 - discount)
  support:
    kind: derived
    unit: GBP
    formula: hardware * support_rate * horizon
  total_cost:
    kind: derived
    unit: GBP
    label: five-year cost
    formula: hardware + support
outputs:
  - total_cost
  - units
  - hardware
  - support
correlations: []
```

Notice what the example does with the discount: it is blank, with a source saying why. The
builder will show "no number yet" against every figure that needs it, which is the truth.

Now build the model from the notes that follow.
