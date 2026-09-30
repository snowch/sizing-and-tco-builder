/*
 * A shape to start from: a worked example's structure with every number taken out.
 *
 * Someone who does not know where to begin gets the whole tree of a model like theirs at once:
 * what the answer is made of, each quantity's unit, each formula, and who decides each input.
 * What they do not get is anyone else's number. Every input is left with no value, no range and
 * no source; a measured constant becomes an input to find out, because a measurement taken on
 * somebody else's system is not a figure about theirs; ceilings, correlations and notes are left
 * out, since each carries a number or a claim of its own. The shape keeps only what its answers
 * rest on.
 */

import { ancestors, loadModel } from "./model.js";
import { documentFrom } from "./write.js";

/* The situations offered, each an example model and the answers that make it that situation. */
export const SHAPES = [
  {
    id: "demand",
    example: "demand",
    title: "What arrives and what piles up",
    blurb: "The busy hour's requests and the data you hold, grown to the horizon. The smallest place to start.",
    outputs: ["peak_request_rate", "stored_data"],
  },
  {
    id: "machines",
    example: "web_service",
    title: "Machines for a service",
    blurb: "How many hosts a service needs: its processor time, memory and disk, each below a margin, and the largest wins.",
    outputs: ["hosts_recommended"],
  },
  {
    id: "fleet_cost",
    example: "web_service",
    title: "The running cost of a fleet",
    blurb: "What the hosts cost to buy and to run over the horizon: hardware, power, licences, support and people.",
    outputs: ["tco"],
  },
  {
    id: "keep_or_replace",
    example: "mixed_pool",
    title: "Keep old hardware, or replace it",
    blurb: "How many new hosts to buy while last generation's stay in service, and what the pool costs.",
    outputs: ["new_hosts_weighted", "total_cost"],
  },
  {
    id: "vendor_tco",
    example: "sellers_tco",
    title: "Check a vendor's TCO",
    blurb: "What a proposed product saves a customer, and the benchmark carry-over and usage it needs to break even.",
    outputs: ["saving", "break_even_transfer", "payback"],
  },
];

/*
 * The shape as a document in the writer's form, with every input blank. `examples` is the list
 * data/examples.json holds; the result has no numbers but the constants written into formulas,
 * which are arithmetic (the 1 in 1 - margin), not figures about anything.
 */
export function shapeFrom(shape, examples, { registry, results = {} }) {
  const example = examples.find((e) => e.id === shape.example);
  if (!example) throw new Error(`no example called ${shape.example}`);
  const model = loadModel(example.files["model.yaml"], { registry, results });
  const keep = new Set(shape.outputs.flatMap((o) => [o, ...ancestors(model, o)]));
  const doc = documentFrom(model);
  const nodes = [];
  for (const node of doc.nodes) {
    if (!keep.has(node.name) || node.kind === "ceiling") continue;
    const common = { name: node.name, unit: node.unit, label: node.label ?? null, note: null };
    if (node.kind === "derived") nodes.push({ ...common, kind: "derived", formula: node.formula });
    else {
      nodes.push({
        ...common,
        kind: "input",
        decided: node.kind === "measured" ? "outside" : node.decided,
        value: null,
        distribution: null,
        provenance: { kind: "", source: "" },
        range: null,
      });
    }
  }
  return {
    dsl: doc.dsl ?? 2,
    model: shape.id,
    title: shape.title,
    currency: doc.currency,
    description: "",
    nodes,
    outputs: [...shape.outputs],
    correlations: [],
  };
}
