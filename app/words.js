/*
 * Every sentence the builder shows, in one place, so the voice can be checked in one reading.
 *
 * British English, plain words, the reader as "you". The book rations six statistics words
 * (distribution, sample, percentile, interval, correlation, convergence); the interface uses plain
 * ones instead: a range, a shape, draws, "nine in ten", inputs that move together. The words
 * appear only where the file itself uses them.
 *
 * A question names the chapter that teaches it by slug. The number a reader sees comes from the
 * book's outline (data/outline.json), as the book derives its own, so it cannot go stale.
 */

export const ANSWERS = {
  hosts: {
    title: "How many machines?",
    blurb: "A fleet sized for the busy hour at the end of the purchase, with a margin below the point where it slows down.",
    unit: "host",
  },
  storage: {
    title: "How much storage?",
    blurb: "What is held today, grown to the horizon, after copies and compression, below the point where the disks fill.",
    unit: "TB",
  },
  cost: {
    title: "What will it cost?",
    blurb: "The machines you need, priced over the life of the purchase: what you pay up front and what it costs to run them.",
    unit: "USD",
  },
  other: {
    title: "Something else",
    blurb: "Any quantity: a request rate, a bandwidth, a number of racks. You say what it is and what it is measured in.",
    unit: "",
  },
};

export const QUESTIONS = {
  answer: {
    q: "What is the answer called, and what is it measured in?",
    why: "This is the output: the number you will be asked for. Its unit is what every formula below it has to produce.",
    chapters: ["point_estimates", "what_a_workload_is"],
  },
  decision: {
    q: "What decision does the answer feed?",
    why: "Who will act on the number, and what they will do with it. It tells you how precise the answer needs to be, and it is what you check the finished model against.",
    chapters: ["point_estimates", "a_tco_for_finance"],
    placeholder: "Finance approves the hardware order for the next refresh.",
  },
  horizon: {
    q: "When is the answer for?",
    why: "How long you are buying for. It fixes what the answer means, every growth figure hangs off it, and it is your decision.",
    chapters: ["what_a_workload_is", "peak_mean_and_growth"],
  },
  hosts: {
    q: "One kind of host, or several roles?",
    why: "One kind of host doing several jobs is sized by the resource that binds: the largest of its chains, not their sum, because the same machines do all three. Machines in different roles are different machines, so their pools add up.",
    chapters: ["bandwidth_and_the_binding_constraint"],
  },
  kind: {
    q: "Is it given, worked out, or measured?",
    why: "Given means somebody states it, estimates it or decides it. Worked out means you can write it as a formula over other quantities, which then need defining in turn. Measured means it comes from a stamped measurement with an error, and it makes the model conditional.",
    chapters: ["point_estimates", "where_the_numbers_come_from"],
  },
  name: {
    q: "What is it called?",
    why: "Two names: one formulas use, one people read. A label reads better in a table than stored_data_t0 does.",
    chapters: ["what_a_workload_is"],
  },
  unit: {
    q: "What kind of quantity is it, and in what unit?",
    why: "The unit says whether this is a rate, a level, a length of time or a ratio. The commonest sizing error multiplies a rate by a plain number and calls the result an amount.",
    chapters: ["what_a_workload_is"],
    appendix: "appendix_d_units",
  },
  decided: {
    q: "Who decides this number?",
    why: "Inputs look alike in the file, but some describe what is outside your control and some record what you decided. Only the decisions are yours to change.",
    chapters: ["what_a_workload_is"],
  },
  source: {
    q: "Where did the number come from?",
    why: "How much you are claiming when you write it down. A vendor's claim is never quietly promoted to a fact.",
    chapters: ["where_the_numbers_come_from"],
  },
  sure: {
    q: "How sure are you of it?",
    why: "One number is fine for a decision you make. For something outside your control, one number hides how far off it could be; a range with a shape says so, and every answer downstream gets a range.",
    chapters: ["peak_mean_and_growth", "monte_carlo"],
    appendix: "appendix_c_distributions",
  },
  formula: {
    q: "How is it worked out?",
    why: "Write it over the names of other quantities. The units are worked out as you type, and a name that does not exist yet becomes the next thing to define.",
    chapters: ["what_a_workload_is"],
    appendix: "appendix_a_dsl_reference",
  },
  measured: {
    q: "Which measurement is it?",
    why: "A measured constant is not typed in. It points at one of the book's stamped results, which carries the number, its error and the implementation it was measured on. It holds only for that implementation, so it makes the model conditional.",
    chapters: ["where_the_numbers_come_from"],
  },
  ceiling: {
    q: "Where does it stop working, and how far below that do you stay?",
    why: "A ceiling is where the arithmetic stops describing the system: past it, the system behaves differently. A limit with no margin is a comparison, not a sizing rule, so a margin and a reason are both required.",
    chapters: ["queueing_and_the_knee", "headroom_and_failure_domains"],
  },
  review: {
    q: "This is what goes in the file.",
    why: "The same format the book's models use, so the book's checks and viewer read it as they read the book's own.",
    chapters: [],
    appendix: "appendix_a_dsl_reference",
  },
};

export const KIND_CHOICES = [
  ["input", "Given", "A number the model is told: the busy hour, a price, a margin you choose. The branch stops here."],
  ["derived", "Worked out from other things", "Arithmetic over other quantities. Each new name becomes the next thing to define."],
  ["measured", "Measured", "One of the book's stamped measurements, with its error and the implementation it belongs to. Makes the model conditional."],
];

export const QUANTITY = [
  ["rate", "A rate", "Something per unit of time: requests a second, dollars a year.", ["request/second", "MB/s", "USD/year", "query/second"]],
  ["level", "A level", "How much there is: terabytes held, hosts in the fleet, a sum of money.", ["TB", "GB", "host", "core", "USD"]],
  ["duration", "A length of time", "A horizon, a retention period, the time one request takes.", ["year", "month", "day", "second"]],
  ["ratio", "A ratio, a pure number or a price", "A growth factor, a fraction kept free, a price per unit.", ["dimensionless", "USD/host", "core/host", "TB/host"]],
];

export const DECIDED = [
  ["outside", "Outside your control", "Your users, the market, a vendor's price: you can measure it, not set it."],
  ["you", "You decide it", "The horizon, a margin, the fleet you buy. Shown with a bar down its edge."],
  ["definition", "True by definition", "A year is a year whoever asks. Nobody chooses it."],
];

export const DECIDED_WORDS = { outside: "outside your control", you: "you decide it", definition: "true by definition" };

export const PROVENANCE = [
  ["fact", "A fact", "Traceable to a measurement, an invoice or a published specification. Must cite it.", "Cite the measurement, invoice or specification: a link, a file, or the word definition."],
  ["vendor_claim", "A vendor's claim", "Stated by someone selling it: plausible and unchecked. Shown differently everywhere.", "Who quoted it, and where."],
  ["assumption", "An assumption", "An estimate or a decision a reviewer may disagree with.", "Who estimated it, and why this value."],
];

export const PROVENANCE_WORDS = { fact: "fact", vendor_claim: "vendor's claim", assumption: "assumption" };

export const SURE = [
  ["one", "One number", "Enough for a decision, or for now."],
  ["shape", "A range with a shape", "How low and how high it might settle, and how likely each is."],
  ["none", "Not known yet", "No number. It and everything downstream show as not yet measured until you have one. Never a placeholder."],
];

export const SHAPES = {
  triangular: {
    fields: ["minimum", "likely", "maximum"],
    labels: { minimum: "The least it could be", likely: "The value you would bet on", maximum: "The most it could be" },
    words: "The least, the likeliest and the most: an expert's guess. It says nothing can fall outside the two ends.",
  },
  lognormal: {
    fields: ["p10", "p90"],
    labels: { p10: "Low: one time in ten it is below this", p90: "High: one time in ten it is above this" },
    words: "For anything that compounds or cannot go negative: prices, growth rates. It has no upper end.",
  },
  uniform: {
    fields: ["minimum", "maximum"],
    labels: { minimum: "The least", maximum: "The most" },
    words: "Anywhere between two ends, equally likely. Honest only when the ends are all you know.",
  },
  normal: {
    fields: ["mean", "sd"],
    labels: { mean: "The central value", sd: "The standard error" },
    words: "A central value and an error as likely to be high as low: the shape of a measurement's error. It can go negative.",
  },
};

/* The book's patterns, from its own models. Units are the book's, for filtering and for a
 * suggestion when a formula does not fix a new name's unit. Never a value. */
export const PATTERNS = [
  {
    formula: "ceil(busy_cores / (cores_per_host * (1 - queueing_margin)))",
    words: "What the load needs, divided by what one host gives below a margin, rounded up",
    units: { busy_cores: "core", cores_per_host: "core/host", queueing_margin: "dimensionless" },
    chapters: ["capacity", "headroom_and_failure_domains"],
  },
  {
    formula: "max(hosts_for_requests, hosts_for_memory, hosts_for_storage)",
    words: "The resource that binds: the largest of the needs, because the same hosts do every job",
    units: { hosts_for_requests: "host", hosts_for_memory: "host", hosts_for_storage: "host" },
    chapters: ["bandwidth_and_the_binding_constraint"],
  },
  {
    formula: "{name}_t0 * annual_growth ** horizon_periods",
    words: "Today's figure, grown to the horizon",
    units: { "{name}_t0": "{unit}", annual_growth: "dimensionless", horizon_periods: "dimensionless" },
    chapters: ["what_a_workload_is", "peak_mean_and_growth"],
  },
  {
    formula: "horizon / one_year",
    words: "A length of time as a number of years, so it can be an exponent",
    units: { horizon: "year", one_year: "year" },
    chapters: ["what_a_workload_is"],
  },
  {
    formula: "peak_request_rate * service_demand",
    words: "Work arriving, times what each piece of work costs a processor",
    units: { peak_request_rate: "request/second", service_demand: "core*second/request" },
    chapters: ["littles_law", "capacity"],
  },
  {
    formula: "stored_data * replication_factor / record_compression",
    words: "What is held, times the copies kept, divided by how far it compresses",
    units: { stored_data: "TB", replication_factor: "dimensionless", record_compression: "dimensionless" },
    chapters: ["capacity"],
  },
  {
    formula: "hosts * host_price + hosts * running_cost_per_host_year * horizon",
    words: "What you pay up front, plus what it costs to run, over the horizon",
    units: { hosts: "host", host_price: "USD/host", running_cost_per_host_year: "USD/host/year", horizon: "year" },
    chapters: ["capex_opex_and_lifecycle", "the_five_year_model"],
  },
];

/* The refinements, in the order that pays (design, "Refine"). */
export const REFINE = [
  {
    id: "sources",
    what: "Read where each number came from",
    why: "The assumptions outside your control are the list of things you could go and measure; the decisions are the ones you can change.",
    chapters: ["where_the_numbers_come_from"],
  },
  {
    id: "ceiling",
    what: "Say where it stops working",
    why: "Past a limit the system stops behaving like the arithmetic. Declare the limit and the margin you keep below it.",
    chapters: ["queueing_and_the_knee", "regime_changes", "headroom_and_failure_domains"],
  },
  {
    id: "ranges",
    what: "Give the inputs outside your control a range",
    why: "One number hides how far off it could be. A range gives every answer a range.",
    chapters: ["peak_mean_and_growth", "monte_carlo"],
  },
  {
    id: "measure",
    what: "See which input to measure first",
    why: "The input the answer rests on most is the one worth going to measure.",
    chapters: ["which_input_is_the_answer"],
  },
  {
    id: "scenario",
    what: "Compare a second case",
    why: "Change inputs in a small file beside the model, with a reason, rather than editing the model.",
    chapters: ["a_tco_for_finance", "comparing_two_tcos"],
  },
];

/* The book's build checks, by the conformance suite's codes, in words a reader can act on. */
export const PROBLEM_WORDS = {
  "units.does-not-typecheck": ["The formula of {node}{part} does not work in units", "what_a_workload_is"],
  "units.declared-vs-produced": ["{node}{part} declares one unit and its formula gives another", "what_a_workload_is"],
  "units.mixed-operands": ["{node}{part} adds or compares quantities in different units: declare them in one", "what_a_workload_is"],
  "units.rounds-in-wrong-unit": ["{node}{part} rounds a number before it is in the node's own unit", "what_a_workload_is"],
  "input.decided": ["{node} does not say who decides it", "what_a_workload_is"],
  "input.provenance-kind": ["{node} does not say what kind of claim it is", "where_the_numbers_come_from"],
  "input.empty-source": ["{node} does not say where it came from", "where_the_numbers_come_from"],
  "input.shape-not-named": ["{node} has a shape its source does not name: say why it is that shape", "peak_mean_and_growth"],
  "input.fact-cites-nothing": ["{node} is called a fact but cites nothing", "where_the_numbers_come_from"],
  "measured.no-result": ["{node} names no measurement", "where_the_numbers_come_from"],
  "measured.no-summary-value": ["{node}'s measurement holds no value", "where_the_numbers_come_from"],
  "measured.unit-differs": ["{node} declares a unit its measurement was not taken in", "where_the_numbers_come_from"],
  "measured.no-uncertainty": ["{node}'s measurement reports no error", "where_the_numbers_come_from"],
  "ceiling.no-headroom": ["The ceiling {node} keeps no margin", "headroom_and_failure_domains"],
  "ceiling.no-reason": ["The ceiling {node} gives no reason", "headroom_and_failure_domains"],
  "shape.feeds-no-output": ["{node} feeds no answer: remove it, or make it an answer", "point_estimates"],
  "shape.no-outputs": ["The model has no answers, so nothing in it can be checked", "point_estimates"],
  "classification.measured-without-ceiling": ["A measured constant and no ceiling: say where the model stops working", "headroom_and_failure_domains"],
  "scenario.unknown-node": ["Scenario {scenario} changes {node}, which is not in the model", "a_tco_for_finance"],
  "scenario.overrides-derived": ["Scenario {scenario} changes {node}, which is worked out: change its inputs instead", "a_tco_for_finance"],
  "scenario.does-not-evaluate": ["Scenario {scenario} cannot be worked out", "point_estimates"],
};

export const CAUSE_WORDS = {
  typecheck: "a formula does not work in units",
  "no-value": "an input has no number yet",
  "no-measured-value": "a measurement holds no value",
  distribution: "a range's shape cannot be drawn from",
  correlation: "inputs said to move together cannot all do so at once",
  arithmetic: "the arithmetic fails, for example a division by zero",
  sampling: "some of its draws come out infinite or undefined",
};
