# jev-mcp

Standalone MCP server exposing a single `judge` tool that calls TypeSafe's Jev
(`POST https://api.typesafe.ai/v1/systemone`) and returns typed answers with
probabilities. Not tied to any agent harness any client can consume it.

## Startup

```bash
node ~/.local/bin/jev-mcp/index.js
```

No key needed in the environment. The server resolves the API key at startup,
never printing it:

1. `TYPESAFE_API_KEY` env var, if set
2. macOS Keychain generic password, service `typesafe-api-key`, account `$USER`
   (same source as the `secret-export TYPESAFE_API_KEY typesafe-api-key` line in
   `~/.zshrc`)

Already verified live (empty env, straight from Keychain):
`require("fs")` -> `is_js.noul = 0.97`

## The tool: `judge`

`judge(state, questions)` -> typed answers + probabilities

- `state`: string | object | array — the content to evaluate
- `questions`: object map of `{ <id>: { type, instructions, criteria? } }`,
  where `type` is `noul`, `choice`, or `score`

It mirrors the TypeSafe API one-to-one; answer keys match the question ids you
pass. Thresholds belong in the calling code, not the model.

### Examples

Noul (yes/no, returns `noul` 0..1):
```json
{
  "state": "import pandas as pd",
  "questions": { "is_py": { "type": "noul", "instructions": "Is this a Python import line?" } }
}
```

Choice (returns `choice` + `probabilities` + `confidence`):
```json
{
  "state": "Help! payouts failing for 3 days",
  "questions": {
    "dept": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "payments/refunds", "technical": "bugs/outages", "sales": "pricing" }
    }
  }
}
```

Score (returns `score` + `legend` + `probabilities` + `confidence`):
```json
{
  "state": "Help! payouts failing for 3 days",
  "questions": {
    "frustration": { "type": "score", "instructions": "How frustrated is the customer?", "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

Call multiple independent questions in one `judge` call — Jev answers them in
parallel and cannot see one another's answers.

## How to call it

### As an MCP tool (any agent)

Point any MCP client at the server. It registers the tool as `judge` (clients
that namespace tools, e.g. dsh, show it as `mcp__jev__judge`).

One caveat: some clients scrub ambient `*KEY*` env vars when spawning stdio
(dsh does). Since the server reads from Keychain, it works without an env key —
but if you prefer env, set `TYPESAFE_API_KEY` in that client's `env`, not the
ambient shell.

### With a raw MCP client (node)

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('index.js', import.meta.url).pathname],
  env: {},  // empty: key comes from Keychain
});
const client = new Client({ name: 'c', version: '0.0.0' });
await client.connect(transport);

const res = await client.callTool({
  name: 'judge',
  arguments: { state: 'import pandas as pd', questions: { is_py: { type: 'noul', instructions: 'Is this a Python import line?' } } },
});
console.log(res.content[0].text);
```

## Forwarding agents to it

The server is already registered in the local agent configs so they discover
`judge` automatically (as `mcp__jev__judge` where the client namespaces):

- **opencode** — `~/.config/opencode/opencode.json`:
  ```json
  "mcp": {
    "jev": { "type": "local", "command": ["node", "/Users/aleksandrarsenev/.local/bin/jev-mcp/index.js"], "enabled": true }
  }
  ```
- **codex** — `~/.codex/config.toml`:
  ```toml
  [mcp_servers.jev]
  command = "node"
  args = ["/Users/aleksandrarsenev/.local/bin/jev-mcp/index.js"]
  ```

For any other client (dsh profile, Claude Code, Cursor), register the same
command/args:
- command: `node`
- args: `['/Users/aleksandrarsenev/.local/bin/jev-mcp/index.js']`
- transport: `stdio`
- env: (optional) `{ TYPESAFE_API_KEY: <key> }` only if you bypass Keychain

Example dsh registration shape:
```yaml
- id: mcp-jev
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: jev
    transport: stdio
    command: node
    args: ['/Users/aleksandrarsenev/.local/bin/jev-mcp/index.js']
```

## Use cases

- Routing / classification: pick a handler from a defined set
- Verification / gates: noul checks over code or text ("is this a Python
  import?", "does this violate policy?")
- Reranking / evidence relevance: judge candidate relevance, consume top ones
- Composite scoring: score dimensions once, tune weights/thresholds in code
- Extraction with selection: pick the intended value from candidates in source
