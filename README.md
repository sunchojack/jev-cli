# jev-mcp

A tiny Model Context Protocol (MCP) server that gives AI agents and other MCP
clients access to TypeSafe's **Jev** — a model that answers questions with a
probability distribution instead of prose.

> Unofficial community CLI and MCP wrapper for TypeSafe Jev. Not affiliated
> with or endorsed by TypeSafe.

Two ways to use Jev here:

- **CLI** — ask Jev from your terminal instead of writing a `curl` request.
- **MCP server** (`judge`) — let an MCP client call Jev as a tool.

## Quick start

You need Node.js 20 or later and a TypeSafe API key.

```bash
git clone https://github.com/sunchojack/jev-mcp.git
cd jev-mcp
npm install
npm link
export TYPESAFE_API_KEY="your-key"
jev "Is this a Python import line?" --state "import pandas as pd"
```

`npm link` puts `jev` on your path. The last command prints Jev's answer as
JSON.

## Why a CLI, not curl

The raw TypeSafe API is callable with a single `curl`, but `curl` means managing
a JSON body. This repo's CLI takes a question and some state, then builds the
request for you.

Run `jev --help` to see the full option list.

```bash
jev "Is this a Python import line?" --state "import pandas as pd"
# → {"answer": {"type":"noul","noul":0.99}}
```

The CLI reads the key from `TYPESAFE_API_KEY` or the macOS Keychain.

## What the server does

**Problem:** TypeSafe's "Jev skill" is a set of instructions that tells an
agent *how* to call the Jev API. The agent still has to write the request,
handle authentication, and parse the response each time. `jev-mcp` packages
that into a ready-made tool, so an agent calls `judge` and gets the answer.

This does not replace the skill's guidance on when and how to use Jev. It gives
an MCP client a direct tool for making the call.

**What it does:** exposes one MCP tool, `judge(state, questions)`, which sends
your input to Jev and returns a typed answer with probabilities (yes/no `noul`,
`choice`, or `score`).

The tool description tells agents to use `judge` only for an explicit Jev
request or a machine-actionable probability distribution. The MCP client still
controls whether the tool is available to the agent.

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
Replace `/path/to/jev` with the absolute path to this repo.

## Auth

Set `TYPESAFE_API_KEY` before you start the CLI or MCP server:

```bash
export TYPESAFE_API_KEY="your-key"
```

On macOS, you can instead store the key in Keychain with service
`typesafe-api-key` and account `$USER`. If both are available,
`TYPESAFE_API_KEY` takes precedence. The key is not printed by this repo.

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

You can ask several independent questions about one `state` in the same
request. Set your own threshold in code (for example, treat `noul >= 0.9` as
yes). Thresholds belong to the caller, not the model.

## Patterns you can build

This repo only sends judgments to Jev and returns the answers. Your code must
implement any routing, ranking, or scoring workflow around those answers.

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
