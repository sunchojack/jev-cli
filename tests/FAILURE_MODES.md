# Test-first failure inventory

These tests precede production implementation. They use Node's built-in test runner, local HTTP servers, CLI subprocesses, and fake worker executables.

## Failure inventory

- Transport changes the configured URL, selects the wrong credential, or ignores model precedence.
- Transport omits the timeout or follows redirects with credentials.
- An HTTP error, invalid JSON, or nested error exposes credentials or response text.
- Validation accepts missing envelope fields, missing answers, type mismatches, invalid probabilities, invalid confidence, or invalid scores.
- CLI changes the legacy output or loses native JSON state, questions, model, or usage.
- MCP bypasses shared transport behavior or changes its answers-only response.
- Routing selects the wrong model, provider, or reasoning level.
- Routing accepts confidence below 0.75 or uses the selected probability instead of confidence.
- Invalid responses, redirects, disconnections, timeouts, or outages bypass the deep fallback.
- A model judgment turns “finished” into authoritative success or overrides an explicit native failure.
- Skill selection returns names outside the candidate set or drops mandatory task instructions.
- Triage returns an undefined category or starts an approval subprocess.
- A worker starts during dry-run, receives the wrong arguments, loses its working directory, or executes prompt text through a shell.
- A read-only worker lacks its harness-specific restriction.
- Launcher output contains progress instead of the last worker output, or lacks a JSON route record on stderr.

## Fixture boundaries

The transport fixtures follow https://docs.typesafe.ai/api, inspected on 2026-09-29.
The response contains `model`, `answers`, and `usage`. Question IDs are deterministic for transport and MCP fixtures.
Workflow fixtures echo the question IDs from each request. They do not assert private question names or instruction wording.
Categorical workflows use native choice responses. Skill fixtures support choice responses or independent noul responses.
The low-confidence fixture deliberately separates `confidence` from the chosen probability.

All live HTTP requests target `127.0.0.1` on an ephemeral port.
A fetch preload rejects public URLs, including the CSH URL. Default-endpoint inspection returns a local in-memory response.
The preload also checks `redirect: 'error'` and an abort signal for transport calls.
These checks instrument the fetch boundary. The other transport cases use real HTTP connections.
The worker preload rejects shell execution through Node's child-process interface. Fake executables record the actual arguments and working directory.
The triage preload rejects child-process calls, including approval commands. This check does not cover external services or Python hooks.
No fixture reads a real credential or invokes a real worker.

## Interface decisions and limits

- The user selected `node bin/jev-agent.mjs worker` as the launcher entrypoint.
- Model precedence is request model, then `TYPESAFE_MODEL`, then `jev-latest`.
- Native status fixtures use strings. Failed and interrupted states permit `blocked` or `unclear`, with attention required.
- The contract does not define every `needs_attention` mapping. Other cases assert a boolean without inventing a mapping.
- The contract permits optional skill suggestions. Positive fixtures do not require selection of every relevant candidate.
- Mandatory-instruction coverage checks preservation of task text. Hook-level enforcement needs a separate Hermes plugin integration test.
- The shared client's optional `options` argument has no frozen schema. Tests use the environment interface only.
- The exact CSH HTTPS endpoint is not contacted. Local fixtures verify full-path preservation and the CSH credential selector.
- MCP uses newline-delimited JSON-RPC over stdio. Its test requires the declared runtime dependencies.
- Plugin registration, helper recursion avoidance, hook side effects, `hermes jev`, and hot-load remain unverified here.
- Input-validation policy, skill suggestion bounds, and worker failure exit codes need separate interface decisions.

## Run and retain evidence

From the repository root, run:

```sh
node --test tests/transport.test.mjs tests/workflows.test.mjs
```

Install the declared dependencies before the MCP test:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

For a repeatable JSON artifact, use the built-in runner with an inline reporter:

```sh
node --input-type=module -e 'import {mkdir} from "node:fs/promises"; await mkdir("node_modules/.cache",{recursive:true});'
node --test --test-reporter='data:text/javascript,export default async function* (source) { const events=[]; for await (const e of source) { if (["test:pass","test:fail","test:summary"].includes(e.type)) events.push(e); } yield JSON.stringify({schema:1,events},(_,v)=>v instanceof Error?{name:v.name,message:v.message,code:v.code,cause:v.cause}:v,2)+"\n"; }' --test-reporter-destination=node_modules/.cache/jev-test-results.json tests/transport.test.mjs tests/workflows.test.mjs
```

The artifact records each result and error. Durations vary between runs. The command returns a nonzero status if any test fails.
The artifact remains under the ignored `node_modules` directory.
Before implementation, failures from missing entrypoints and unsupported flags are expected. A failing import is never accepted as a transport rejection.
