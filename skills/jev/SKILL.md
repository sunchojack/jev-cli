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

Jev supplies advisory status, optional skill suggestions, and failure classifications.
The Node launcher selects the model and reasoning level before an explicit worker launch.
Code owns lifecycle decisions. Native completion, failure, and interruption facts always take precedence over Jev predictions.

## When to Use

- Inspect recent local supervision events.
- Select a launch-time route for a new, explicitly requested worker.
- Request optional skill suggestions or classify a failure or review concern.

## Prerequisites

The native Jev plugin must be enabled for the active Hermes profile.
Node and `bin/jev-agent.mjs` must exist in the Jev checkout.
Hermes resolves `CSH_AGENTIC_CODING_KEY` through its scoped secret API.
An explicit Hermes worker receives this scoped key even when `key_env` selects a different Jev credential.
The default endpoint is `https://llm.ascii.ac.at/typesafe/v1/systemone`.
An explicit Codex worker also receives the scoped `CSH_OPENAI_PULL_THROUGH_TOKEN` for the `csh_openai_pull_through` provider.
The launcher preserves `HOME`, the active `HERMES_HOME`, and the scoped `CODEX_HOME` override when present.
It does not modify the launch profile or provider configuration.

Plugin configuration lives under `plugins.entries.jev.settings`:

```yaml
plugins:
  enabled: [jev]
  entries:
    jev:
      settings:
        enabled: true
        endpoint: https://llm.ascii.ac.at/typesafe/v1/systemone
        key_env: CSH_AGENTIC_CODING_KEY
        timeout_ms: 5000
        threshold: 0.75
        max_skills: 60
        # cli_path: /absolute/path/to/jev-cli/bin/jev-agent.mjs
        # node_path: /absolute/path/to/node
```

The plugin resolves the checkout from its own file location, including symlinks.
If the plugin directory is copied elsewhere, configure `cli_path` explicitly.
The plugin registers this skill as `jev:jev` when the checkout skill file exists.

## How to Run

Use `terminal` for these commands. Use `write_file` to prepare short JSON inputs and worker prompt files.
Replace the example paths with actual files and directories.

```sh
hermes jev status
hermes jev watch --once
hermes jev watch --interval 60
hermes jev route < /absolute/path/route.json
hermes jev skills < /absolute/path/task.json
hermes jev triage < /absolute/path/failure.json
hermes jev evaluate < /absolute/path/status-evidence.json
hermes jev worker --harness hermes --cwd /absolute/workspace --prompt-file /absolute/path/task.txt --dry-run
hermes jev worker --harness hermes --cwd /absolute/workspace --prompt-file /absolute/path/task.txt
hermes jev worker --harness codex --cwd /absolute/workspace --prompt-file /absolute/path/review.txt --read-only
```

Input examples:

```json
{"task":"Inspect a small Python change","harness":"hermes"}
```

```json
{"task":"Find useful optional skills for this Python change"}
```

```json
{"task":"Review the failed build","error":"Compiler reports a missing dependency"}
```

```json
{"task":"Review worker progress","native_status":"failed","latest_output":"Build failed"}
```

`skills` obtains the current Hermes roster unless the JSON supplies `candidates` with `name` and `description` fields.
Local lexical matching ranks optional skill names and descriptions against the current task before the shortlist limit applies.
This ranking makes no model call. Jev receives the shortlist and the catalog, eligible, and shortlist counts.
Mandatory workflows remain excluded from optional suggestions. A suggestion never replaces required instructions.
`evaluate` calls the Node status classifier. `status` reads only local persisted events.
`/jev` shows local status and instructions. It never launches work.

### Read-only supervision

`watch --once` reads recent sessions from the active profile's Hermes `state.db` and records one observation pass.
`watch --interval 60` repeats that pass every 60 seconds until interrupted.
The command runs explicitly in the foreground. Hooks never start it automatically.
The watcher opens source databases read-only. It covers already-running sessions without attaching to their processes or changing their models.
Changed snapshots can receive bounded Jev status advice. Unchanged snapshots use local checkpoints instead of another request.
`--include-codex` enables optional Codex snapshots. These snapshots do not establish whether a Codex session is active or complete.

### Native activity hooks

| Hook | Recorded evidence |
|---|---|
| `subagent_start` | Child started, with parent and child session IDs. |
| `pre_api_request` | API activity, sampled per session without a Jev request. |
| Successful `post_tool_call` | Tool progress, sampled per session without a Jev request. |
| Failed `post_tool_call` | Native failure and optional triage from a bounded, redacted error or output excerpt. |
| `pre_approval_request` | Approval waiting, with attention required. |
| `post_approval_response` | Approval response and end of that wait, without granting approval. |
| `api_request_error` | Native failure reason and optional triage, stored separately. |
| `subagent_stop` | Native child outcome, plus optional status and triage advice. |
| `pre_llm_call` | Optional skill suggestions. |
| `pre_verify` | Advisory verification triage. |
| `on_session_end` | Explicit native turn outcome fields. |

Activity sampling permits one fact of each sampled kind per session every five seconds.
Local status retains timestamped attention and failure evidence. Later activity or completion does not prove that an earlier problem is resolved.
Native completion still requires review. It does not establish verified success.

## Quick Reference

| Lane | Model family | Reasoning |
|---|---|---|
| routine | Luna | medium |
| standard | Sol | medium |
| deep | Astra | high |

The Node launcher selects explicit harness-specific provider and model identifiers.
Uncertainty selects the deep route. `route` alone supplies advice and never changes a running session.

## Procedure

1. Read the task instructions and native status first.
2. Use local `status` for recorded facts.
3. Send only short, relevant evidence for a decision.
4. If a skill suggestion is relevant, load it with `skill_view`.
5. Preserve mandatory instructions and required workflows regardless of the suggestions.
6. For an authorized worker, prepare the prompt file with `write_file`.
7. Run `worker --dry-run` to inspect the planned route and command.
8. Run `worker` to launch the new process through the supported harness CLI.
9. Evaluate its returned evidence before you report success.

## Pitfalls

- Existing sessions can use these commands immediately through their existing `terminal` tool after installation.
- Existing sessions are not auto-adopted. Stock `delegate_task` does not use Jev routing.
- Gateway plugin hot-load activates handlers. Frozen tools and prompt sections wait for a new session.
- Hooks never launch workers, grant approvals, retry, stop sessions, send chat messages, or change boards.
- `pre_verify` records advice and returns `None`. It never requests continuation or blocks completion.
- Verification advice includes up to 1,600 characters from the final response, with paths and code blocks omitted.
- Explicit hook task or criteria fields contribute up to 600 characters each. Current Hermes supplies no separate task or criteria fields.
- These excerpts are claims for triage, not proof that checks passed. Missing evidence remains unknown.
- Hooks fail soft. Duplicate decisions, rapid repeated events, and endpoint failures suppress further calls temporarily.
- Successful decision identities expire after five minutes. Repeated duplicates do not extend that deadline.
- Decision identities include turn, tool-call, and API-request IDs. Failed attempts release their identities for retry after cooldown.
- Low-confidence advice does not start an outage cooldown. Network, timeout, HTTP, and invalid-response failures start a 30-second cooldown.
- Decision calls have a maximum 12-second deadline. Explicit workers have no plugin-imposed execution deadline.
- SQLite writers serialize with a two-second lock deadline. Lock errors skip the observation without blocking a tool.
- Set `settings.enabled: false` to stop callbacks at their next invocation. Set `max_skills: 0` to disable skill hints only.
- Do not include credentials, full prompts, complete tool output, or provider request objects in decision inputs.

## Verification

Use `hermes jev status` to inspect the profile-local SQLite event summary.
The database is `<HERMES_HOME>/state/jev/events.sqlite3`, with fewer than 1,000 metadata events and at most 512 guards.
Each event's JSON occupies at most 4,096 bytes. Retained event JSON occupies at most 2,000,000 bytes in total.
The plugin prunes before insertion to reserve space. These limits bound logical event data, not SQLite file size or filesystem capacity.
Events retain unique IDs, timestamps, process IDs, native facts, and available model, usage, route, confidence, and probability metadata.
Probability metadata retains the five highest valid probabilities and the original entry count.
Successful Node judgments supply Jev model, usage, and probabilities. Local shortcuts and unavailable judgments can omit these fields.
Skill events also retain catalog, eligible, and shortlist counts. Fallback events retain recognized reason codes.
They exclude prompt text, tool output, error bodies, and keys.
Native outcomes and predicted classifications remain separate. A reduced legacy exit event does not establish a turn outcome.
Native child `error`, `failed`, `blocked`, `interrupted`, `timeout`, `timed_out`, `crashed`, and `cancelled` states remain authoritative despite optimistic predictions.
Recognized API reasons, including `auth`, `billing`, `rate_limit`, and `upstream_blocked`, remain separate `native_reason` facts.
