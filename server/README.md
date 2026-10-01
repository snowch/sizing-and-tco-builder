# The builder as a service: MCP for an assistant, the page for the engineer

The builder's engine runs as one local process. An assistant (Claude Desktop, Claude Code, or
any client that speaks the Model Context Protocol) reads specifications, spreadsheets, notes
and web pages and calls the server's tools; the engine does the arithmetic; the engineer sees
every proposed figure in the page, with its origin and evidence, and confirms or rejects it.

The rule the page keeps, the server keeps: **no tool writes a figure into the model.** An
assistant can only *suggest* one, and a suggestion with no origin or no evidence is refused.
A suggestion sits beside the input, marked unconfirmed, until the engineer decides.

## Run it

```sh
npx sizing-and-tco-builder serve          # from a clone: node bin/cli.js serve
```

That serves the page at `http://127.0.0.1:8765/v2/`, the solutions at `/api/solutions`, and the
MCP endpoint at `POST /mcp`, all on localhost. Solutions are folders under
`~/sizing-and-tco-solutions` (or `--dir`), each with `state.json` and, once written, the model
and scenario files the toolkit checks.

```
--dir <folder>   where solutions live
--port <n>       8765 by default; another is taken if that one is busy
--host <addr>    127.0.0.1 by default; 0.0.0.0 to listen for the intranet
--token <text>   required on every /api and /mcp request, as `Authorization: Bearer <text>`
```

## Claude Desktop

Claude Desktop launches a local server itself and talks to it over stdio. The `mcp` command
does that, and serves the page alongside so `open_in_page` has somewhere to point. Add to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sizing-and-tco-builder": {
      "command": "node",
      "args": ["/path/to/sizing-and-tco-builder/bin/cli.js", "mcp", "--dir", "/path/to/solutions"]
    }
  }
}
```

With `npx` from the repository instead of a clone: `"command": "npx", "args": ["-y",
"github:snowch/sizing-and-tco-builder", "mcp"]`.

## Claude Code

```sh
claude mcp add sizing-and-tco-builder -- node /path/to/sizing-and-tco-builder/bin/cli.js mcp
```

or, against a `serve` already running: `claude mcp add --transport http sizing-and-tco-builder
http://127.0.0.1:8765/mcp`.

## What crosses the firewall

Nothing, for a local client. Claude Desktop and Claude Code run on the engineer's machine, launch
the server there, and speak to it over a pipe or localhost; the assistant's own requests go out
to its API as they would anyway, carrying what the assistant chose to send it (the notes it was
given, the tool results it read). The solutions never leave the machine unless the assistant
quotes them.

An intranet host (`--host 0.0.0.0 --token …`) lets several engineers open one page and one set
of solutions, and lets a client on another desk reach `/mcp`; still nothing crosses the
firewall. Claude.ai's web and mobile apps are the one client that cannot reach a server inside
a firewall: they connect only to an endpoint reachable from the internet that speaks OAuth,
which this server does not. For that, run it where claude.ai can reach it, behind a gateway
that adds the OAuth, or use the desktop app instead.

## The tools

| tool | what it does |
| --- | --- |
| `list_questions` | the questions, the roles each starts with, the parts, the origins |
| `start_solution` | a folder for the question, title and notes; nothing is read from the notes |
| `list_solutions`, `describe_solution` | what exists and how it stands |
| `set_parts` | infra, software, services: values already entered are kept |
| `describe_inputs` | every input per scope, with unit, value, origin, evidence and any suggestion |
| `missing_inputs` | required then optional, each with the question the page would ask |
| `suggest_inputs` | figures with origin and evidence; refused without them; never written in |
| `withdraw_suggestions` | take suggestions back |
| `confirm_suggestions` | on the engineer's say-so, naming who; the provenance records it |
| `set_option`, `add_option`, `remove_option` | rename, parts covered, same as ours |
| `set_requirement_note`, `set_notes` | written requirements; the notes as given |
| `evaluate` | every option's answer from confirmed figures; `provisional: true` applies the suggestions to a copy and says which |
| `explain` | a number's formula in words and with the numbers in, down to the inputs and their origins |
| `what_if` | every option's answer with some figures changed, from a copy |
| `write_files` | the model and scenario files, from confirmed figures, with the toolkit's verdict |
| `open_in_page` | where the engineer sees it |

The protocol is JSON-RPC 2.0 by hand (`server/mcp.js`): `initialize`, `tools/list`,
`tools/call`, `ping`, one message per line over stdio or one per POST over HTTP, with JSON
responses. The server keeps no session: a request can be replayed, and any client that speaks
the tools methods can use it.

## In the page

Open `/v2/?solution=NAME`. The state lives on the server; every change is saved there with the
version it was read at, and the page asks every couple of seconds whether the assistant has
moved the record on. A suggested figure appears under its empty field with its origin, the
evidence and Confirm and Reject; a banner counts them; the header chip shows the link and how
many wait. Confirming writes the value where a typed one goes, with the evidence and a note that
the assistant suggested it and the page confirmed it.

Nothing of this changes the page without `?solution=`: it keeps its state in the browser and
works offline as before.
