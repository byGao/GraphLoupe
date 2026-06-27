# Security & privacy

GraphLoupe is a **debugger**: to show you a LangGraph running, it has to load and
run that graph. Because that is a sensitive thing for a tool to do, here is exactly
what it does, what it does *not* do, and where today's safety boundary is. We would
rather you (or your AI assistant) trust this tool because the threat model is
written down than because it looks polished.

## TL;DR

- **100 % local. No telemetry, no analytics, no "phone home."** The only network
  traffic is a WebSocket on `localhost` between the VS Code extension and the Python
  sidecar. Your graph, your code, and your prompts never leave your machine.
- **No credentials are ever requested or stored.** GraphLoupe has no API-key field.
- **Graph *discovery* never executes your code** — it is a static AST scan.
- **Graph *execution* runs in an isolated subprocess**, not in your IDE.
- **Open source, MIT, no install-time scripts** (no `postinstall`/`preinstall`).

## What GraphLoupe runs, and how it's isolated

| Action | What happens | Isolation |
|--------|--------------|-----------|
| **Select Graph** (discovery) | Your project is **AST-scanned** for a graph factory. **No code is imported or executed.** | N/A — nothing runs |
| **Run** | The chosen `package.module:callable` is imported and run by a **separate sidecar worker subprocess**, with a load timeout. A crash or hang is contained and surfaced as `graph_load_failed` instead of taking down the IDE. | Process isolation + timeout |

## Data & privacy

- **No telemetry / analytics / crash reporting.** Verifiable in the source: there are
  no calls to any analytics SDK and no outbound HTTP — the only socket is the local
  extension↔sidecar WebSocket.
- **Your code never leaves the machine.** The sidecar reads your graph from local
  disk and streams *events* (node names, state snapshots, token counts) back to the
  webview over that local socket. Nothing is uploaded.
- **Credentials stay yours.** GraphLoupe never asks for an API key. If your graph
  itself calls a real model, it uses your project's own credentials exactly as a
  normal `python` run of your code would — GraphLoupe does not add, read, or store
  them. **Manual inference** needs no key at all: *you* paste a prompt into *your own*
  chat session and paste the answer back.

## Where the boundary is today (read this)

Process isolation + a timeout protect you from a **buggy or runaway** graph — a crash,
an infinite loop, a hang — not from **deliberately malicious** code. The worker runs
your graph with your normal OS user privileges, so a hostile graph could read files
or make network calls just like any script you run yourself.

**Therefore: only point GraphLoupe at graphs you already trust enough to run yourself**
(typically your own project). Do not use it to "safely inspect" untrusted third-party
graph code — that sandbox does not exist yet.

Hardening on the roadmap (see the project backlog): least-privilege worker env
(whitelist `process.env` so a graph can't read your keys), a Workspace-Trust-style
confirmation before loading a new path, runtime resource limits, and an opt-in
OS-level sandbox.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
reporting: the repo's **Security → Report a vulnerability** tab (private security
advisory). Include repro steps and the affected version. We'll acknowledge and work a
fix before any public disclosure.
