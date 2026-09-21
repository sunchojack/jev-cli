# jev-mcp

A tiny MCP server that gives AI agents (and any MCP client) direct access to
TypeSafe's **Jev** — a model that answers questions with a probability
distribution instead of prose.

**What it does:** exposes one tool, `judge(state, questions)`, which sends your
input to Jev and returns a typed answer with probabilities (yes/no `noul`,
`choice`, or `score`).

**What it is not:** this is not documentation. TypeSafe's "Jev skill" is a set of
instructions that tells an agent *how* to call the Jev API — the agent still has
to write the request, handle auth, and parse the response itself every time.
`jev-mcp` packages all of that into a ready-made tool, so an agent just calls
`judge` and gets the answer back.

## Quick start

Run it (any MCP client can spawn it):

```bash
node index.js
```

Or register it in your agent once, then use `judge` like any other tool:

- **opencode** — in `~/.config/opencode/opencode.json`:
  ```json
  "mcp": {
    "jev": { "type": "local", "command": ["node", "/path/to/jev-mcp/index.js"], "enabled": true }
  }
  ```
- **codex** — in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.jev]
  command = "node"
  args = ["/path/to/jev-mcp/index.js"]
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
