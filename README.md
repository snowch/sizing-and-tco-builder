# Model Builder

A browser tool that guides you through building a sizing and TCO model of your own system, and
writes the same YAML model files as the book *Sizing and TCO*
([snowch/sizing-and-tco](https://github.com/snowch/sizing-and-tco)). It asks the book's questions
at the moment they matter, starting from the answer you are being asked for, and never fills in a
number for you.

**Status: the rules engine is built and agrees with the book on every case; the interface is
next.** See [PLAN.md](PLAN.md).

- [PLAN.md](PLAN.md): the reading of the design, the milestones, the technology and the open
  questions.
- [conformance/](conformance/README.md): how the builder's rules are held to the book's own
  toolkit, case by case.
- [BOOK-REQUESTS.md](BOOK-REQUESTS.md): what the builder needs the book to change, and why.
- [book.lock.json](book.lock.json): the book commit everything here is checked against.

```bash
npm test                                   # the engine against the fixtures (Node 22)
python3 conformance/generate.py --check    # the fixtures against the book (Python 3.11)
python3 conformance/roundtrip.py           # the book reads what the engine writes
```
