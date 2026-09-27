/*
 * Which input to measure first: sizing/evaluate.py's tornado, as the book computes it.
 *
 * Each input with a shape is swung between the 10th and 90th percentile of its own shape, and a
 * measured constant by 1.28 standard errors either side of its value, one at a time, with
 * everything else at its point value. The bars are ranked by how far the output moves. One at a
 * time is the method's limit, and ch19 says so: an input that matters only together with another
 * gets a short bar here and can still be the one that sinks you.
 *
 * Held to the book's own tornado() by the conformance fixtures (conformance/fixtures/tornado/).
 */

import { measuredSd, measuredValue } from "./model.js";
import { blocked } from "./model.js";
import { oneShape, point, ppf, sampledInputs, Z90 } from "./evaluate.js";

export const TORNADO_LOW = 0.1;
export const TORNADO_HIGH = 0.9;

/* evaluate.swing_of: the low and high an input is swung between, or null. */
export function swingOf(model, name) {
  const node = model.nodes.get(name);
  if (node.kind === "input" && node.distribution !== null) {
    const [shape, p] = oneShape(node.distribution);
    return [ppf(shape, p, TORNADO_LOW), ppf(shape, p, TORNADO_HIGH)];
  }
  if (node.kind === "measured" && node.measurement !== null && measuredSd(node) > 0) {
    const v = measuredValue(node);
    return [v - Z90() * measuredSd(node), v + Z90() * measuredSd(node)];
  }
  return null;
}

/* evaluate.tornado: the bars for one output, widest first. */
export function tornado(model, scenario, output, factors) {
  const base = point(model, scenario, factors);
  if (!base.has(output)) return [];
  const stuck = blocked(model);
  const bars = [];
  for (const name of sampledInputs(model)) {
    if (stuck.has(name) || scenario.overrides.has(name)) continue;
    const swing = swingOf(model, name);
    if (swing === null) continue;
    const [low, high] = swing.map((setting) => {
      const forced = { ...scenario, overrides: new Map([...scenario.overrides, [name, setting]]) };
      return point(model, forced, factors).get(output);
    });
    const node = model.nodes.get(name);
    bars.push({
      node: name,
      label: node.label ?? name.replaceAll("_", " "),
      kind: node.kind,
      low_input: swing[0],
      high_input: swing[1],
      low,
      high,
      base: base.get(output),
      span: Math.abs(high - low),
    });
  }
  // Python's sorted is stable, and so is Array.prototype.sort: ties keep sampled_inputs' order.
  return bars.sort((a, b) => b.span - a.span);
}
