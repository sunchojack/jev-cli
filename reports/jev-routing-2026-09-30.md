# Jev routing and coding comparison: September 30, 2026

The former uncertainty policy bought Astra without evidence that the task needed it. The revised built-in policy falls back to Luna/medium.
Explicit catalogs and model pins remain authoritative. Mandatory validation and review still determine success.

## Cost and checked results

Each scenario has two generations per model. All 24 original outputs passed the frozen checks.
The revised policies use twelve new live routing decisions paired with those same outputs. They do not rerun the workers.
One additional real Hermes worker passed 22 input-validation checks in a temporary profile with tools disabled.

| Policy, six paired executions | Checks passed | Public-rate equivalent | Mean seconds |
|---|---:|---:|---:|
| Fixed Luna | 6/6 | $0.001600 | 10.66 |
| Fixed Aqueduct | 6/6 | $0.006010 | 15.52 |
| Fixed Sol | 6/6 | $0.026822 | 21.33 |
| Fixed Astra | 6/6 | $0.146910 | 15.57 |
| Former built-in Jev | 6/6 | $0.075912 | 20.67 |
| Former custom Jev | 6/6 | $0.147050 | 15.83 |
| Revised builtin Jev | 6/6 | $0.001743 | 10.94 |
| Revised custom Jev | 6/6 | $0.001742 | 10.93 |

The revised built-in policy costs 98.8% less than fixed Astra under these rate assumptions. Routing still costs about 9% more than fixed Luna.
Jev selected Luna in all twelve revised decisions. Two built-in decisions used the low-confidence fallback.
This sample supports an economical starting policy. It does not establish an advantage over fixed Luna.

| Scenario, revised built-in | Checks passed | Public-rate equivalent | Savings against Astra |
|---|---:|---:|---:|
| routine-validation | 2/2 | $0.000317 | 98.4% |
| pooled-data | 2/2 | $0.001043 | 98.8% |
| authorization | 2/2 | $0.000384 | 99.0% |

## Limits and evidence

The scenarios cover input validation, cross-year aggregation, and tenant authorization. They do not cover repository-scale refactors or difficult research.
Six declared defective implementations failed the frozen checks before generation. Passing checks establish this coverage, not complete correctness.
Routing adds about 0.27 seconds per decision here. Worker times and tokens come from the frozen earlier generations.
The rates are dollars per million input/output tokens. Luna uses $0.10/$0.50, Sol $2/$10, Astra $10/$50, and DeepSeek Flash $0.15/$0.60.
The Jev reference uses $0.042 per million input tokens and free output. Actual CSH account charges remain unavailable.
These public-rate equivalents are not account savings. Subscription billing, cache pricing, and upstream model identity can change the comparison.

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing/), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), [OpenCode Zen](https://opencode.ai/docs/zen/).
[Raw decisions, totals, and live worker evidence](jev-routing-2026-09-30.json) include the frozen generation file checksum.
The complete earlier generation corpus remains in `/tmp/jev-evaluation-20260930/coding-results.json`.

## Implementation verification

The isolated checkout passed 725 Node tests, 15 native plugin checks, 20 watcher checks, and the routing CLI E2E.
The routing E2E detected the missing inventory, former Astra fallback, and silently substituted task pins before their fixes.
Profiles A/B/A stayed separate. Invalid catalogs and unresolved pins refused launch. Dry-run started no worker.
No live profiles, services, or existing sessions were changed during testing. The live smoke observes only its own temporary Hermes profile.

Run `tests/routing_integration.py` with the Hermes environment Python and `--hermes-root PATH --artifact PATH`.
Run `tests/live_smoke.py` with `--source-profile PATH --hermes-root PATH --artifact PATH` for a real, scoped request.
The live smoke reads the source provider configuration and key. It creates and removes a separate profile. It does not use the installed profile launcher.
