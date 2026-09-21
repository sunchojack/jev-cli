# jev-mcp

A tiny MCP server that gives AI agents (and any MCP client) direct access to
TypeSafe's **Jev** — a model that answers questions with a probability
distribution instead of prose.

Two ways to use Jev here:

- **CLI** (`jev`) — ask Jev from your terminal (jev "is 2 = 2?"), rather that write a curl request manually.
- **MCP server** (`judge`) — let an agent call it as a tool (save tokens on skill callup).

## Why a CLI, not curl

The raw TypeSafe API is callable with a single `curl`, but curl means managing
a JSON body. This repo's `jev` CLI is meant to be easier to start with: it just needs a key (env or
Keychain) plus a question and some state.

Run `jev --help` anytime to see the full option list.

```bash
jev "Is this a Python import line?" --state "import pandas as pd"
# → {"answer": {"type":"noul","noul":0.99}}
```

CLI startup: `node bin/jev.mjs` (or the `jev` symlink on PATH), key from
`TYPESAFE_API_KEY` or macOS Keychain (service `typesafe-api-key`).

## What the server does

**Problem:** TypeSafe's "Jev skill" is a set of
instructions that tells an agent *how* to call the Jev API — the agent still has
to write the request, handle auth, and parse the response itself every time.
`jev-mcp` packages all of that into a ready-made tool, so an agent just calls
`judge` and gets the answer back. 

**What it does:** exposes one MCP tool, `judge(state, questions)`, which sends
your input to Jev and returns a typed answer with probabilities (yes/no `noul`,
`choice`, or `score`).

**Gating:** `mcp__jev__judge` is opt-in, *not automatic* — an agent only invokes it
when the caller explicitly asks for a Jev judgment or a machine-actionable
probability distribution is required.

## Register the MCP server in an agent

Run it (any MCP client can spawn it):

```bash
node index.js
```

Register it once, then use `judge` like any other tool:

- **opencode** — in `~/.config/opencode/opencode.json`:
  ```json
  "mcp": {
    "jev": { "type": "local", "command": ["node", "/path/to/jev/index.js"], "enabled": true }
  }
  ```
- **codex** — in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.jev]
  command = "node"
  args = ["/path/to/jev/index.js"]
  ```
- Replace `/path/to/jev-mcp` with wherever you keep the repo.

## Auth

No environment setup needed on macOS: the key is read from the Keychain
(service `typesafe-api-key`, account `$USER`). If `TYPESAFE_API_KEY` is set in
the environment, that is used instead. The key is never printed.

## Using `judge`

`judge(state, questions)` — `state` is the content to judge (string, object, or
array); `questions` is a map of `{ <id>: { type, instructions, criteria? } }`.

**Yes/no (noul):**
```json
{
  "state": "import pandas as pd",
  "questions": { "is_py": { "type": "noul", "instructions": "Is this a Python import line?" } }
}
```
→ `{"is_py": {"type": "noul", "noul": 0.99}}`

**Pick one of several (choice):**
```json
{
  "state": "payouts failing for 3 days",
  "questions": {
    "dept": {
      "type": "choice",
      "instructions": "Which team handles this?",
      "criteria": { "billing": "payments/refunds", "technical": "bugs/outages", "sales": "pricing" }
    }
  }
}
```
→ `{"dept": {"type": "choice", "choice": "technical", "probabilities": {"billing": 0.1, "technical": 0.88, "sales": 0.02}, "confidence": 0.84}}`

**Rate along a scale (score):**
```json
{
  "state": "payouts failing for 3 days",
  "questions": {
    "frustration": { "type": "score", "instructions": "How frustrated is the customer?", "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```
→ `{"frustration": {"type": "score", "score": 1.05, "legend": {"0":"Calm","1":"Frustrated","2":"Very angry"}, "probabilities": {"0":0.0,"1":0.95,"2":0.05}, "confidence": 0.92}}`

Ask several independent questions in one `state` — they are answered in
parallel. Set your own threshold in code (e.g. treat `noul >= 0.9` as yes);
thresholds belong to the caller, not the model.

## Use cases

- Routing / classification: pick a handler from a defined set
- Verification / gates: noul checks over code or text ("is this a Python
  import?", "does this violate policy?")
- Reranking / evidence relevance: judge candidate relevance, consume top ones
- Composite scoring: score dimensions once, tune weights/thresholds in code
- Extraction with selection: pick the intended value from candidates in source

## Wire format

The full request/response contract lives in the
[TypeSafe API docs](https://docs.typesafe.ai/api). `judge` mirrors it; answer
keys match the question ids you pass.
