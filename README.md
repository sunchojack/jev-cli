# jev-cli

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
npm install --global @sunchojack/jev-cli
export TYPESAFE_API_KEY="your-key"
jev "Is this a Python import line?" --state "import pandas as pd"
```

The install puts `jev` and `jev-mcp` on your path. The `jev` command prints
Jev's answer as JSON.

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

## CLI options

The question is the only required argument:

```bash
jev "Is P = NP?"
```

- `--state "<content>"` — content to evaluate.
- `--file <path>` — read the content to evaluate from a file instead.
- `--type noul|choice|score` — judgment type; defaults to `noul`.
- `--criteria "<values>"` — define the alternatives or scale; format depends
  on the judgment type.
- `--id <name>` — name the answer in the returned JSON; defaults to `answer`.
- `--help` or `-h` — show the built-in help.

Examples:

```bash
# verify a coding or data claim
jev "Is this a Python import line?" --state "import polars as pl" --id is_import

# classify an observation into a research category
jev "Which mechanism best fits this trade-flow change?" \
  --state "Exports rise while the unit value falls after a tariff reduction." \
  --type choice \
  --criteria "price|change driven by prices,quantity|change driven by quantities,composition|change driven by product mix" \
  --id mechanism

# score evidence on an ordinal scale
jev "How strongly does this observation support the hypothesis?" \
  --state "The estimated effect is positive in the baseline and four robustness specifications." \
  --type score \
  --criteria "Not at all,Partly,Strongly" \
  --id support

# evaluate a paper, note, or dataset saved on disk
jev "Is this evidence relevant to the identification strategy?" \
  --file evidence-note.md \
  --id relevant
```

## CSH Hermes integration

The native [Hermes plugin](plugins/jev/__init__.py) uses
`https://llm.ascii.ac.at/typesafe/v1/systemone` and selects the scoped secret
`CSH_AGENTIC_CODING_KEY`. It resolves the CLI from the source checkout.
Link the plugin and [shared skill](skills/jev/SKILL.md) to this checkout:

```bash
ln -s /home/arsenev/jev-cli/plugins/jev ~/.hermes/plugins/jev
ln -s /home/arsenev/jev-cli/skills/jev ~/.codex/skills/jev
hermes plugins enable jev
```

The parent directories must exist, and the link destinations must be unused.
Gateway hot activation is available for plugin handlers. Never restart active
sessions for installation. Existing CLI processes cannot externally reload
plugin hooks. Watcher and terminal commands work immediately after enablement.
Frozen tools and prompt sections wait for a new session.

Plugin defaults come from source. Optional overrides use
`plugins.entries.jev.settings` in the active Hermes profile:

```yaml
enabled: true
endpoint: https://llm.ascii.ac.at/typesafe/v1/systemone
key_env: CSH_AGENTIC_CODING_KEY
timeout_ms: 5000
threshold: 0.75
max_skills: 5
cli_path: ""  # Resolve bin/jev-agent.mjs from the checkout.
node_path: node
```

The confidence threshold `0.75` is an initial, uncalibrated policy value.
Jev has four roles:

- **Routing:** select a launch-time model and reasoning level for an explicit worker.
- **Status:** classify progress as advice. Native outcomes remain authoritative.
- **Skills:** suggest optional skills without replacing mandatory instructions.
- **Triage:** classify failures and possible verification gaps without controlling lifecycle.

```bash
hermes jev status
hermes jev models
hermes jev route < route.json
hermes jev skills < task.json
hermes jev triage < failure.json
hermes jev evaluate < status-evidence.json
hermes jev worker --harness hermes --cwd /absolute/workspace --prompt-file /absolute/task.txt --dry-run
hermes jev worker --harness codex --cwd /absolute/workspace --prompt-file /absolute/task.txt --read-only --dry-run
hermes jev watch --once --include-codex
hermes jev watch --interval 60
```

`route`, `skills`, `triage`, and `evaluate` read JSON objects from stdin.
Each needs `task`, such as `{"task":"Inspect a small change","harness":"hermes"}`.
`route` also needs `harness`. Optional evidence fields are `latest_output`,
`error`, and `native_status`. `skills` discovers candidates unless supplied.
`status` reads local events only. `evaluate` invokes the status classifier.

### Route inventory and worker selection

`hermes jev models` lists the configured route inventory. It does not verify
provider access. By default, `route` and `worker` discover providers and models
from the local Hermes configuration, including configured Aqueduct and CodexLB
entries. Codex workers use compatible configured entries for their harness.
Discovery uses configuration names. Capability descriptions remain unverified,
with no assumed price or quality ranking.
Discovery prefers configured Luna as the fallback, then the active default, then
the first entry. Luna and Sol use medium reasoning unless metadata specifies otherwise.
Other models inherit reasoning. Codex discovery requires a Hermes
`codex_responses` transport and a Codex Responses provider with the same base URL.

Optional `routes` under `plugins.entries.jev.settings` supplies catalogs by
harness: `{hermes: [...], codex: [...]}`. Edit these catalogs to provide trusted
capability descriptions and a conservative fallback. Each entry contains `id`,
`model`, `provider`, `reasoning`, and `description`. Exactly one entry in each
catalog must have `fallback: true`.

This example shows the structure. Select the fallback and describe capabilities
from local evidence before use:

```yaml
routes:
  hermes:
    - id: aqueduct-flash
      model: tu_aq_deepseek-v4-flash-284b
      provider: csh-aqueduct
      reasoning: inherit
      description: Configured Aqueduct entry. Capabilities are unverified.
    - id: bounded
      model: subscription-gpt-6-luna
      provider: csh-subscriptions
      reasoning: medium
      description: Bounded work with clear requirements and required checks.
      fallback: true
    - id: deep
      model: subscription-gpt-6-astra
      provider: csh-subscriptions
      reasoning: high
      description: Complex work that requires deeper analysis.
  codex:
    - id: bounded
      model: gpt-6-luna
      provider: csh_openai_pull_through
      reasoning: medium
      description: Bounded work with clear requirements and required checks.
      fallback: true
```

For standalone Node, `JEV_ROUTES_JSON` supplies the catalog array for the selected
harness, rather than the plugin dictionary. Its shape is
`[{"id":"...","model":"...","provider":"...","reasoning":"inherit","description":"...","fallback":true}]`.
Malformed explicit catalogs fail loudly. They do not silently select defaults.
If the catalog is unavailable, the three built-in routes apply:

| Route | Hermes model | Codex model | Reasoning |
|---|---|---|---|
| routine | `subscription-gpt-6-luna` | `gpt-6-luna` | medium |
| standard | `subscription-gpt-6-sol` | `gpt-6-sol` | medium |
| deep | `subscription-gpt-6-astra` | `gpt-6-astra` | high |

Their providers are `csh-subscriptions` for Hermes and `csh_openai_pull_through`
for Codex. Their fallback is Luna/medium, including low confidence and endpoint
failures. With a catalog, uncertainty selects its designated fallback instead.
Explicit catalogs remain authoritative, including a deliberately configured Astra fallback.
Task-line pins also require catalog membership. Unresolved pins cannot launch a worker.

Start bounded work on an economical route and keep validation and review mandatory.
Use deeper analysis for a demonstrated need. Low confidence alone does not justify an upgrade.
Optional skill hints send at most five candidates with a positive lexical match.
If no candidate matches, automatic hints make no evaluator request.

`worker --harness hermes|codex` applies a route to a new process. Explicit selection
uses `--model ID [--provider NAME] --reasoning none|minimal|low|medium|high|xhigh|max|ultra|inherit`.
Catalog model IDs are not restricted to the three built-in families.
If a model occurs under multiple providers, `--provider` is required.
An explicit model selection bypasses Jev and preserves the supplied model,
provider, and reasoning. `inherit` omits reasoning overrides from the worker
command so the harness retains its own configuration.

Prepare `task.txt` with the worker prompt, then inspect this Aqueduct example:

```bash
hermes jev worker --harness hermes --cwd "$PWD" --prompt-file task.txt \
  --provider csh-aqueduct --model tu_aq_deepseek-v4-flash-284b --reasoning inherit --dry-run
```

Dry-run prints the plan without launching a worker. Automatic routing can still
call Jev. If provider access works, repeat the command without `--dry-run` for an
authorized real request. A dry-run does not verify access. A known CodexLB HTTP
401 means its configured entries are not verified accessible.

`--read-only` selects the Codex read-only sandbox. Hermes rejects this flag
because its file tools permit writes. Stock `delegate_task` is not automatically
routed. Neither `route` nor the hooks change a running session's model.
The watcher reads source databases read-only and records local observations.
Changed snapshots can receive Jev advice. Codex snapshots cannot prove activity
or completion. Completion claims mean ready for review, not verified success.

### Task contract and review

Use the installed skills by name, without relative sibling links:

- `research-guardian` and `freeze-clues`: establish the applicable task contract
  before a worker launch. Include scope, invariants, required checks, and expected
  evidence in the prompt.
- `dignified-python`: reference it in a Python worker's prompt.
- `hunt-faults`: review independently against the contract and inspect actual
  check results and artifacts. Jev advice and worker claims do not replace checks.
- `seal-records`: use only for explicitly authorized landing work.
  Worker completion grants no commit, push, or merge authority.
- `pensieve`: optional memory, never a prerequisite.

Applicable instructions determine skill use. Jev suggestions do not change
mandatory workflows. See the [usage skill](skills/jev/SKILL.md) for native
supervision boundaries and retained evidence.

### Raw CLI transport

For raw CLI requests, select the CSH transport explicitly:

```bash
export TYPESAFE_API_URL=https://llm.ascii.ac.at/typesafe/v1/systemone
export TYPESAFE_API_KEY_ENV=CSH_AGENTIC_CODING_KEY
jev --request request.json --full
jev --request - --full < request.json
```

The selected key must exist in the CLI environment. `--request FILE|-` accepts
native `{state, questions, model?}` JSON. `--full` preserves response metadata,
including model and usage, alongside answers and their probabilities.

### Local watcher service

This machine runs the watcher through `hermes-jev-watch.service` in the user service manager.
It scans every 60 seconds and classifies at most six changed sessions per scan.
The activity window is 30 minutes. The service includes Codex snapshots.

```bash
systemctl --user status hermes-jev-watch.service
journalctl --user -u hermes-jev-watch.service -n 10 --no-pager
```

The service file is `~/.config/systemd/user/hermes-jev-watch.service`.
It starts a separate observer. It does not restart Hermes or control workers.

### Repeat the checks

```bash
node --test tests/transport.test.mjs tests/workflows.test.mjs
~/.hermes/hermes-agent/venv/bin/python -B tests/hermes_plugin_integration.py --plugin plugins/jev --artifact node_modules/.cache/hermes-integration.json
~/.hermes/hermes-agent/venv/bin/python -B tests/watch_integration.py --plugin plugins/jev --artifact node_modules/.cache/watch-integration.json
python3 tests/live_smoke.py --artifact node_modules/.cache/live-smoke.json
```

The first three checks use local fixtures. The live check calls CSH Jev and starts a separate Hermes worker with a synthetic prompt.
Its JSON artifact records all four decisions, the selected worker route, the worker response, and the watcher result.

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
    "jev": { "type": "local", "command": ["jev-mcp"], "enabled": true }
  }
  ```
- **codex** — in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.jev]
  command = "jev-mcp"
  ```

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

The core CLI and MCP server send judgments to Jev and return the answers.
The Hermes integration adds the workflows described above. Other callers can build:

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
