/*
 * The questions the page can answer, and the words the page uses for the things every question
 * shares: who decides an option, where a number came from, what a requirement is called.
 *
 * A question decides which options start out on the page and which node is its answer. A cost
 * question's answer is the solution's total; a sizing question's is one of the infrastructure
 * part's metrics, and it needs no prices.
 */

export const QUESTIONS = [
  { id: "competitive", label: "Competitive TCO", kind: "cost", roles: ["current", "ours", "rival"], note: "Your solution against the customer's current environment and a competitor, each costed for the same requirements.", sentence: "Compare the customer's current environment with our solution and a competitor's, over the period, for the same requirements." },
  { id: "tco", label: "TCO of a solution", kind: "cost", roles: ["ours"], note: "What one solution costs over the period, every line traced to its source.", sentence: "What does our solution cost the customer over the period?" },
  { id: "sizing", label: "Sizing", kind: "sizing", metric: "sizing", roles: ["current", "ours"], note: "How many servers, nodes or instances each option needs, and which resource sets the number. Prices are not needed.", sentence: "How many units does each option need to meet the customer's requirements?" },
  { id: "capacity", label: "Capacity", kind: "sizing", metric: "capacity", roles: ["current", "ours"], note: "How much raw capacity each option has to provide by the end of the period.", sentence: "How much raw capacity does each option need by the end of the period?" },
  { id: "performance", label: "Performance", kind: "sizing", metric: "performance", roles: ["current", "ours"], note: "How full each option's processors run at the end of the period, against the limit the customer sets.", sentence: "How hard will each option's processors be working at the end of the period?" },
  { id: "business", label: "Business case", kind: "cost", roles: ["current", "ours"], note: "Your solution against what the customer does today: what changing saves.", sentence: "Does moving to our solution cost the customer less than staying as they are?" },
  { id: "comparison", label: "Comparison", kind: "cost", roles: ["ours", "alt"], note: "Two or more solutions side by side, costed for the same requirements.", sentence: "How do the solutions compare in cost over the period, for the same requirements?" },
  { id: "custom", label: "Other / Custom", kind: "cost", roles: ["current", "ours"], note: "Start from the period and your own cost lines.", sentence: "What does each option cost the customer over the period?" },
];
export const questionById = (id) => QUESTIONS.find((q) => q.id === id) ?? QUESTIONS[0];

export const ROLE_NAMES = { current: "Current environment", ours: "Our solution", rival: "Competitor A", alt: "Alternative solution", custom: "Custom option" };

/*
 * Where a number came from, in the words a presales engineer uses, and how each is written
 * into the file's provenance. The file knows three kinds (fact, vendor_claim, assumption); the
 * source text carries the rest, so the mapping runs both ways without a field the file lacks.
 */
export const ORIGINS = {
  customer: { label: "Customer", kind: "assumption", prefix: "Customer: ", note: "What the customer said or wrote. It becomes a fact when a document, email or invoice is cited." },
  quote: { label: "Quote", kind: "vendor_claim", prefix: "Quote: ", note: "A supplier's quote, ours included. A claim until the customer sees the paper." },
  published: { label: "Published price", kind: "vendor_claim", prefix: "Published price: ", note: "A price list or spec sheet anyone can read." },
  assumption: { label: "Assumption", kind: "assumption", prefix: "Assumption: ", note: "Ours. Firm it up before the customer asks, or present it as one." },
  fact: { label: "Document", kind: "fact", prefix: "", note: "Cites a document, an email, an invoice, a URL or a definition." },
};
export function originOf(provenance) {
  const kind = provenance?.kind ?? "", source = provenance?.source ?? "";
  if (!kind) return "";
  if (kind === "fact") return "fact";
  if (kind === "vendor_claim") return source.startsWith(ORIGINS.published.prefix) ? "published" : "quote";
  return source.startsWith(ORIGINS.customer.prefix) ? "customer" : "assumption";
}
export function provenanceFor(via, text) {
  const o = ORIGINS[via];
  if (!o) return { kind: "", source: "" };
  const body = String(text ?? "").trim();
  return { kind: o.kind, source: o.prefix + body };
}
/* The evidence, without the prefix that names its origin. */
export function evidenceOf(provenance) {
  const via = originOf(provenance);
  const prefix = ORIGINS[via]?.prefix ?? "";
  const source = provenance?.source ?? "";
  return source.startsWith(prefix) ? source.slice(prefix.length) : source;
}

export const SAMPLE_NOTES = "Customer has 500 TB of usable data today, growing by about 30% per year. They currently run 12 servers with 100 TB raw storage each, mirrored across two sites (active/passive). Peak load is about 500 cores and 4,000 GB of memory, and they want every resource kept below 70% full. They need to keep backups for 7 years. They want to compare their current environment with our solution over 5 years. Power costs them £0.25 per kWh and the data centre runs at a PUE of 1.4. An admin costs them about £60k a year.";
