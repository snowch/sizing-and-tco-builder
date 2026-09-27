/* The verdict and the ranges, off the page's thread. Messages: init once, then judge per change. */

import { judge } from "./judge.js";

let context = null;

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") {
    context = { results: message.results, units: message.units };
    return;
  }
  try {
    const out = judge(message.files, context);
    self.postMessage({ id: message.id, ...out });
  } catch (error) {
    self.postMessage({ id: message.id, error: String(error?.message ?? error) });
  }
});
