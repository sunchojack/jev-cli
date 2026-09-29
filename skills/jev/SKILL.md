---
name: jev
description: Supervise tasks and route explicit worker launches.
version: 0.1.0
metadata:
  hermes:
    tags: [supervision, routing, triage]
    category: productivity
---

# Jev Skill

Use Jev to inspect supervision events, route an authorized worker, suggest optional skills, or classify failures.
The Node launcher selects a route before launch. Native completion, failure, and interruption facts take precedence over Jev predictions.
Jev advice never establishes verified success or controls lifecycle decisions.

## Prerequisites

Enable the native Jev plugin in the active Hermes profile. The checkout must contain Node-accessible `bin/jev-agent.mjs`.
The plugin resolves its checkout through symlinks and registers this skill as `jev:jev`.
If you copy the plugin elsewhere, set `cli_path` explicitly.

Optional configuration under `plugins.entries.jev.settings`:

```yaml
enabled: true
endpoint: https://llm.ascii.ac.at/typesafe/v1/systemone
key_env: CSH_AGENTIC_CODING_KEY
timeout_ms: 5000
threshold: 0.75
max_skills: 60
# cli_path: /absolute/path/to/jev-cli/bin/jev-agent.mjs
# node_path: /absolute/path/to/node
```

Hermes resolves credentials through its scoped secret API. Hermes workers receive scoped `CSH_AGENTIC_CODING_KEY`, independently of `key_env`.
Codex workers receive scoped `CSH_OPENAI_PULL_THROUGH_TOKEN` for `csh_openai_pull_through`.
The launcher preserves `HOME`, active `HERMES_HOME`, and any scoped `CODEX_HOME` override without changing profile or provider configuration.

## How to Run

Use `terminal` for commands and `write_file` for short JSON inputs and worker prompts. Replace example paths before use.

```sh
hermes jev status
hermes jev models
hermes jev route < /absolute/path/route.json
hermes jev skills < /absolute/path/task.json
hermes jev triage < /absolute/path/failure.json
hermes jev evaluate < /absolute/path/status-evidence.json
hermes jev watch --once
hermes jev watch --interval 60
hermes jev worker --harness hermes --cwd /absolute/workspace --prompt-file /absolute/path/task.txt --dry-run
hermes jev worker --harness codex --cwd /absolute/workspace --prompt-file /absolute/path/review.txt --read-only --dry-run
```

Decision commands read a JSON object with `task`. `route` also requires `harness`:

```json
{"task":"Inspect a small Python change","harness":"hermes"}
```

Optional evidence fields: `latest_output`, `error`, `native_status`.
`skills` obtains the Hermes roster unless input supplies `candidates` with `name` and `description`.
Local lexical matching ranks the optional shortlist without a model call. Mandatory workflows remain excluded and authoritative.
`evaluate` calls the Node status classifier. `status` reads local events. `/jev` shows status and instructions without launching work.

## Route Inventory and Explicit Selection

`hermes jev models` lists the configured route inventory, not verified provider access.
By default, `route` and `worker` discover local Hermes providers and models, including configured Aqueduct and CodexLB entries.
Codex workers use compatible configured entries for their harness.
Discovery uses configuration names. Capability descriptions remain unverified, with no assumed price or quality ranking.

Optional plugin `routes` is a dictionary by harness: `{hermes: [...], codex: [...]}`.
Edit these catalogs to supply trusted capability descriptions and a conservative fallback.
Standalone Node accepts a catalog array through `JEV_ROUTES_JSON`.
Each entry has `id`, `model`, `provider`, `reasoning`, and `description`. Exactly one entry per catalog must have `fallback: true`.
Malformed explicit catalogs fail loudly instead of silently selecting defaults.
Without an available catalog, the three built-in routes are Luna/medium, Sol/medium, and Astra/high. Their fallback is Astra/high.
With a catalog, uncertainty uses its designated fallback. `route` never changes a running session.

Worker selection: `--model ID [--provider NAME] --reasoning none|minimal|low|medium|high|xhigh|max|ultra|inherit`.
Catalog model IDs are not restricted to the three built-in families.
If a model occurs under multiple providers, specify `--provider`.
An explicit model selection bypasses Jev and preserves the supplied model, provider, and reasoning.
`inherit` omits reasoning overrides from the worker command so the harness retains its own configuration.

Prepare `task.txt`, then inspect this Aqueduct example:

```sh
hermes jev worker --harness hermes --cwd "$PWD" --prompt-file task.txt \
  --provider csh-aqueduct --model tu_aq_deepseek-v4-flash-284b --reasoning inherit --dry-run
```

Dry-run prints the plan without launching a worker. Automatic routing can still call Jev.
If provider access works, repeat the command without `--dry-run` for an authorized real request.
A dry-run does not verify access. A known CodexLB HTTP 401 means its configured entries are not verified accessible.
`--read-only` selects the Codex read-only sandbox. Hermes rejects this flag because its file tools permit writes.

## Worker Procedure

1. Read task instructions and native status. Use `research-guardian` and `freeze-clues` to establish the applicable task contract.
2. Put scope, invariants, required checks, and expected evidence in the worker prompt. For Python work, reference `dignified-python`.
3. Inspect `models`, then run `worker --dry-run`. Preserve explicit selections and resolve provider ambiguity before launch.
4. If authorized and provider access works, launch the worker through the supported harness CLI.
5. Use `hunt-faults` for independent review against the contract. Inspect actual check results and artifacts before reporting success.
6. Use `seal-records` only for explicitly authorized landing work. Worker completion grants no commit, push, or merge authority.

Load these installed skills by name, not relative sibling paths. Applicable instructions determine their use, not Jev suggestions.
If an optional suggestion fits, load it with `skill_view`. `pensieve` memory is optional and never a prerequisite.

## Native Supervision

`watch --once` reads recent sessions from the active profile's Hermes `state.db` and records one pass.
`watch --interval 60` repeats in the foreground until interrupted. Hooks never start the watcher.
Source databases open read-only. The watcher neither attaches to processes nor changes their models.
Changed snapshots can receive bounded advice. Unchanged snapshots use local checkpoints without another request.
`--include-codex` adds snapshots that cannot establish Codex activity or completion.

Hooks record native child outcomes, activity, failures, approval waits, responses, and explicit turn outcomes.
API and successful tool activity use local sampling without Jev calls. Failures and child stops can receive separate advice.
Later activity or completion does not resolve earlier attention or failure evidence. Native completion still requires review.

## Boundaries

- Existing sessions can use terminal commands after installation. Stock `delegate_task` is not automatically routed, and sessions are not auto-adopted.
- Gateway hot-load activates handlers. Frozen tools and prompt sections wait for a new session.
- Hooks never launch workers, grant approvals, retry workers, stop sessions, send chat messages, or change boards.
- `pre_verify` returns `None`. It neither requests continuation nor blocks completion.
- Verification triage uses at most 1,600 response characters without paths or code blocks. These claims do not prove checks passed.
- Missing evidence remains unknown. Current Hermes supplies no separate task or criteria fields to verification hooks.
- Hooks fail soft. Duplicate decisions, rapid events, and endpoint failures temporarily suppress calls. Low confidence does not start an outage cooldown.
- Decision calls have a maximum 12-second deadline. Workers have no plugin-imposed execution deadline. Nested Jev workers are disabled.
- SQLite writers serialize with a two-second lock deadline. Lock errors skip observations without blocking tools.
- Set `enabled: false` to stop callbacks at their next invocation. Set `max_skills: 0` to disable skill hints only.
- Exclude credentials, full prompts, complete tool output, and provider request objects from decision inputs.

## Verification

`hermes jev status` summarizes `<HERMES_HOME>/state/jev/events.sqlite3`.
The store retains fewer than 1,000 metadata events. Limits bound logical data, not SQLite file size or filesystem capacity.
Events retain IDs, timestamps, process IDs, native facts, and available model, usage, route, confidence, and probability metadata.
Local shortcuts and unavailable judgments can omit evaluator metadata. Stored events exclude prompts, tool output, error bodies, and keys.
Native outcomes and predictions remain separate. Reduced legacy exit events do not establish turn outcomes.
Native `error`, `failed`, `blocked`, `interrupted`, `timeout`, `timed_out`, `crashed`, and `cancelled` remain authoritative despite optimistic predictions.
API reasons such as `auth`, `billing`, `rate_limit`, and `upstream_blocked` remain separate `native_reason` facts.
