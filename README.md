# Model Builder

A browser tool that guides you through building a sizing and TCO model of your own system, and
writes the same YAML model files as the book *Sizing and TCO*
([snowch/sizing-and-tco](https://github.com/snowch/sizing-and-tco)). It asks the book's questions
at the moment they matter, starting from the answer you are being asked for, and never fills in a
number for you.

A TCO model you can understand, reproduce, test and share. The model can be seen as a graph or
as a table, and downloaded as a spreadsheet whose formulas still work.

**Use it at <https://snowch.github.io/sizing-and-tco-builder/>.** It runs entirely in your
browser, keeps working offline once loaded, and sends nothing anywhere. The site is deployed from
`main` by [`pages.yml`](.github/workflows/pages.yml), after the engine's tests pass.

**Status: all four milestones are built and checked.** The rules engine agrees with the book's
toolkit on every conformance case, the interface builds models whose files the book accepts, and
the sampler's ranges land where the book's do. See [PLAN.md](PLAN.md) for what was checked and
how, and what is not done.

- [PLAN.md](PLAN.md): the reading of the design, the milestones, the technology and the open
  questions.
- [conformance/](conformance/README.md): how the builder's rules are held to the book's own
  toolkit, case by case.
- [BOOK-REQUESTS.md](BOOK-REQUESTS.md): what the builder needs the book to change, and why.
- [book.lock.json](book.lock.json): the book commit everything here is checked against.

```bash
npm test                                   # the engine against the fixtures (Node 22)
npm run flows                              # the builder in Chromium, its files checked by the book
python3 conformance/generate.py --check    # the fixtures against the book (Python 3.11)
python3 conformance/roundtrip.py           # the book reads what the engine writes
```

To run the site locally, serve the repository's root as static files (for example
`python3 -m http.server`) and open `index.html`. There is no build step.

## v2: the solution builder

A second page, at [`/v2/`](https://snowch.github.io/sizing-and-tco-builder/v2/), for a presales
engineer who has never seen a model file. It starts from the question (a competitive TCO, a
sizing, a business case) and the customer's notes, finds candidate inputs in the notes for the
engineer to confirm, and builds the answer as customer → requirements → options → answer. Every
number keeps its origin, every result has a *Why?*, and the files it writes are the same model
files as v1, checked by the same toolkit.

The notes can be read by a small language model on the device (WebLLM over WebGPU, downloaded
once when asked for) as an optional accelerator. It only proposes candidates, each with the
sentence it came from; nothing reaches the model until the engineer confirms it, and the page
works in full without it. For what the notes do not give, the page asks one question at a time,
in its own fixed words, and reads each answer the same way. [prompts/model-from-notes.md](prompts/model-from-notes.md) does the
same job in any Claude chat, writing a whole model file for the builder to check.

### With an assistant: the builder as a service

`npx sizing-and-tco-builder serve` runs the engine as a local process: the page at
`http://127.0.0.1:8765/v2/`, the solutions behind it, and an MCP server (over stdio for Claude
Desktop or Claude Code, over HTTP for an intranet host). The assistant reads specifications,
spreadsheets and web pages and *suggests* figures, each with its origin and evidence; a
suggestion without them is refused, and none enters the model until the engineer confirms it in
the page. Nothing crosses the firewall for a local client. [server/README.md](server/README.md)
has the setup and the tools.

## Licence

MIT; see [LICENSE](LICENSE). The vendored YAML package keeps its own ISC licence
([vendor/](vendor/README.md)).
