# Jev benchmark (first run)

This September 29 snapshot uses the former Astra fallback. The revised policy
and coding comparison are in [the September 30 report](jev-routing-2026-09-30.md).

## Why this exists
The earlier price estimate was not a real model-cost comparison: it assumed worker prices and token volumes without running workers. Do not use its claimed 56–80% savings. This suite replaces it.

## Baseline picked from actual use
OpenCode's local usage stats for the last 30 days show `build` as the most-used agent; TU Aqueduct DeepSeek V4 Flash appears most often, followed by GPT-6 Astra (often xhigh). Session cost is recorded as $0, which does not establish zero billing. This benchmark uses that common build setup as the baseline. Stats source: `/home/arsenev/.local/share/opencode/opencode.db`, read-only query; `opencode stats --days 30` corroborated build-heavy use and unavailable cost accounting.

## What was tested
15 labeled coding/triage/status/skill cases, each repeated five times against the live Jev endpoint. It measures Jev decision latency and usage tokens; route and advisory labels are compared with the case's stated expected outcome. The fixed Aqueduct baseline and explicit pin make no routing choice, so route accuracy is N/A for them. This is a routing/advisory benchmark, not an end-to-end code-generation benchmark.

| Jev function / setup | Decisions | Label match | Mean decision time | Mean input/output tokens |
|---|---:|---:|---:|---:|
| Built-in 3-choice model route | 30 | 20/30 (67%) | 249 ms | 398 / 38 |
| Custom 3-model list route (Aqueduct/Luna/Astra) | 30 | 14/30 (47%) | 265 ms | 383 / 41 |
| Optional skill suggestions | 15 | 15/15 (100%) | 255 ms | 494 / 51 |
| Worker status classification | 15 | 15/15 (100%) | 263 ms | 447 / 58 |
| Failure triage category | 15 | 15/15 (100%) | 263 ms | 500 / 84 |
| Fixed Aqueduct build / explicit Aqueduct pin | 60 total | N/A (no decision) | 0 ms Jev overhead | 0 / 0 Jev tokens |

No transport errors occurred. The built-in route fell back to Astra on 10/30 decisions; the custom list fell back to its Astra entry on 16/30. That conservatism materially changes selected models and should be considered alongside match rate.

## Price and limits
This run measured Jev evaluator usage only; it did not run worker jobs, so it cannot establish end-to-end savings. The actual `csh-subscriptions` and `csh-aqueduct` account charges/quotas are not exposed in the benchmark. OpenAI's official API rate card does list API-equivalent rates for the base GPT-6 models (prices per million tokens, standard short context): Astra $10 input / $50 output; Luna $0.10 input / $0.50 output. Cached input is $1.00 / $0.01 respectively; long-context pricing is higher. These are direct API list rates, not the actual rate for your subscription-backed CSH routes. ChatGPT subscription allowance is separate from metered API billing. Sources: https://developers.openai.com/api/docs/pricing/ ; https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account .

For DeepSeek V4 Flash, the official provider price is $0.15/M cache-miss input and $0.60/M output off-peak; $0.30/M and $1.20/M peak, with cheaper cached input. OpenCode Go also lists DeepSeek V4 Flash as a subscription model. Neither verifies the exact `tu_aq_deepseek-v4-flash-284b` Aqueduct route's served upstream model or billing, so these rates are reference-only, not applied to this run. Sources: https://api-docs.deepseek.com/quick_start/pricing ; https://opencode.ai/docs/go/ . OpenCode Zen has a separate per-request rate card, but that does not apply unless the route is through Zen: https://opencode.ai/docs/zen/ .

TypeSafe/OpenCode Zen documents `jev-1.13` at $0.042/M input and free output, and a limited-time `jev-1.13-free`. This benchmark requested `jev-latest` and received model label `jev-1.13`; the label match does not establish that Zen is the serving/billing route, so actual evaluator dollars remain unknown. Source: https://opencode.ai/docs/zen/ .

Measured evaluator tokens (about 436 per built-in route decision, 424 custom list, 545 skills, 505 status, 584 triage) are reported as actual. The earlier 56–80% worker-savings claims are withdrawn: they used assumed worker volumes/rates, not observed runs. Subscription usage, overage, CSH gateway pricing, and TypeSafe charges require the account-specific billing records to price accurately.

Quality numbers are preliminary: 6 route scenarios and 3 examples per other workflow, repeated five times. Repeats measure variability, not additional independent task coverage. Labels were authored for this benchmark and are not blind expert ratings. This does not establish downstream model quality, coding success, or whether routing saves time overall; worker completion time is not measured.

## Run it
`JEV_BENCH_RUNS=5 node tests/benchmark_jev.mjs`
`node --test tests/benchmark_cases.test.mjs`

Cases: `tests/benchmark_cases.json`
Runner writes raw decisions and aggregates to `reports/jev-benchmark-latest.json`.
