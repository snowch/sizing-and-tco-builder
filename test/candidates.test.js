/*
 * The candidate finder: every number in the notes becomes a candidate, matched to an input by
 * the words around it, confident only when one input fits clearly, and never touching a model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { findCandidates, findWritten, inUnitOf, sentences } from "../engine/candidates.js";

const INPUTS = [
  { key: "shared|data_today", name: "usable data today", unit: "TB", keys: "usable|data|hold|storage", scope: "shared" },
  { key: "shared|growth", name: "growth a year", unit: "dimensionless", keys: "grow", scope: "shared" },
  { key: "shared|horizon", name: "evaluation period", unit: "year", keys: "year view|-year|over \\d+ years|period", scope: "shared" },
  { key: "shared|cores", name: "peak cores", unit: "core", keys: "cores?|vcpu|processor", scope: "shared" },
  { key: "shared|memory", name: "peak memory", unit: "GiB", keys: "memory|GiB|GB|RAM", scope: "shared" },
  { key: "shared|fill_margin", name: "fill margin", unit: "dimensionless", keys: "below|full|headroom", scope: "shared" },
  { key: "shared|power_price", name: "electricity price", unit: "GBP/kWh", keys: "kwh|electric", scope: "shared" },
  { key: "shared|pue", name: "PUE", unit: "dimensionless", keys: "pue|overhead", scope: "shared" },
  { key: "shared|admin_cost", name: "cost of one admin a year", unit: "GBP/count/year", keys: "admin|salary", scope: "shared" },
  { key: "shared|software_admin_cost", name: "cost of one software admin a year", unit: "GBP/count/year", keys: "admin|salary", scope: "shared" },
  { key: "current|unit_tb", name: "raw capacity per unit", unit: "TB/host", keys: "raw|each|per (server|node|unit)", scope: "current" },
  { key: "current|price", name: "price per unit", unit: "GBP/host", keys: "price|each", scope: "current" },
];
const NOTES = "Customer has 500 TB of usable data today, growing by about 30% per year. They currently run 12 servers with 100 TB raw storage each, mirrored across two sites. Peak load is about 500 cores and 4,000 GB of memory, and they want every resource kept below 70% full. They want to compare over 5 years. Power costs them £0.25 per kWh and the data centre runs at a PUE of 1.4. An admin costs them about £60k a year.";

test("sentences keep their offsets", () => {
  const s = sentences("One. Two, three.\nFour");
  assert.deepEqual(s.map((x) => x.text), ["One.", "Two, three.", "Four"]);
  assert.equal(s[1].start, 5);
});

test("every number is a candidate, and the clear ones are confident with the right value", () => {
  const found = findCandidates(NOTES, INPUTS);
  const by = Object.fromEntries(found.filter((c) => c.target).map((c) => [c.target, c]));
  assert.equal(by["shared|data_today"].value, 500);
  assert.equal(by["shared|growth"].value, 0.3, "a percentage becomes a share");
  assert.equal(by["shared|growth"].written, 30);
  assert.equal(by["shared|horizon"].value, 5);
  assert.equal(by["shared|cores"].value, 500);
  assert.equal(by["shared|memory"].value, 4000);
  assert.equal(by["shared|fill_margin"].value, 0.7);
  assert.equal(by["shared|power_price"].value, 0.25);
  assert.equal(by["shared|pue"].value, 1.4);
  assert.equal(by["current|unit_tb"].value, 100, "a figure about the current environment goes to that option");
  for (const key of ["shared|data_today", "shared|cores", "shared|memory", "shared|pue", "current|unit_tb"]) assert.equal(by[key].confidence, "confident", key);
});

test("a number two inputs fit equally is ambiguous, with both offered", () => {
  const found = findCandidates(NOTES, INPUTS);
  const admin = found.find((c) => c.text === "£60k");
  assert.equal(admin.value, 60000);
  assert.equal(admin.confidence, "ambiguous");
  assert.equal(admin.target, "");
  assert.deepEqual(new Set(admin.alternatives), new Set(["shared|admin_cost", "shared|software_admin_cost"]));
});

test("a number nothing fits is kept as a candidate with no match, and the quote points at it", () => {
  const found = findCandidates("They have 3 data centres. Budget is £2m.", INPUTS.filter((i) => !/data_today|price/.test(i.key)));
  const three = found.find((c) => c.text === "3");
  assert.equal(three.confidence, "none");
  assert.equal(three.sentence.slice(three.at, three.at + three.length), "3");
  const budget = found.find((c) => c.text === "£2m");
  assert.equal(budget.value, 2e6);
  assert.equal(budget.confidence, "none");
});

test("nothing is written into a model: the result is plain data", () => {
  const found = findCandidates(NOTES, INPUTS);
  assert.ok(found.every((c) => c.status === "pending"));
  assert.ok(found.every((c) => typeof c.sentence === "string" && typeof c.id === "string"));
});

test("written requirements are picked out by sentence", () => {
  const w = findWritten("Mirrored across two sites (active/passive). Backups kept for 7 years.", { Availability: "active|passive|failover", Retention: "backups?|retain|retention" });
  assert.deepEqual(w.map((x) => x.category), ["Availability", "Retention"]);
});

test("a number followed straight by its unit is found, a digit inside a word is not, and a data unit is converted", () => {
  const found = findCandidates("Customer has 3PB on the S3 tier of usable data today. Memory is 512GiB.", INPUTS);
  assert.deepEqual(found.map((c) => c.text), ["3PB", "512GiB"], "the 3 in S3 is not a figure");
  assert.equal(found[0].writtenUnit, "PB");
  assert.equal(found[0].target, "shared|data_today");
  assert.equal(found[0].value, 3000, "3 PB read into an input declared in TB");
  assert.equal(found[0].written, 3);
  assert.equal(found[1].value, 512);
  assert.equal(inUnitOf(2, "TB", "GiB/host"), 2048, "across prefixes, scaled by the input's base");
  assert.equal(inUnitOf(4000, "GB", "GiB"), 4000, "the same prefix is taken as written: GB means GiB to the people who write it");
  assert.equal(inUnitOf(1.5, "PB", "TB"), 1500);
  assert.equal(inUnitOf(5, "", "TB"), 5);
});

test("a data unit on the number is enough to propose the data inputs, even with no key word in the sentence", () => {
  const found = findCandidates("Customer has 3PB on the S3 tier - need to explore TCO by migrating.", INPUTS);
  const c = found.find((x) => x.text === "3PB");
  assert.equal(c.target, "shared|data_today", "PB leans to the input in TB, not to memory in GiB");
  assert.equal(c.value, 3000);
  const m = findCandidates("Boxes have 256GB and that is all we know.", INPUTS).find((x) => x.text === "256GB");
  assert.equal(m.target, "shared|memory", "GB leans to memory in GiB");
  assert.equal(m.value, 256);
});
