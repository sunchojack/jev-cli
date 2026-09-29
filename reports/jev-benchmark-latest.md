# Jev benchmark (first run)

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
Dollars per decision are unavailable for the actual routed setup. OpenCode reports $0 for these usage records; that is not billing evidence for subscription or Aqueduct routes. OpenAI says API billing is separate from ChatGPT subscriptions. Its public API price page does not list the specific GPT-6 Luna/Astra subscription model IDs used here, so their token cost cannot be calculated from public rates. TypeSafe has no public Jev evaluator price found. Sources: https://openai.com/api/pricing/ ; https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account ; https://api-docs.deepseek.com/quick_start/pricing .

For reference only: the official DeepSeek price page says legacy `deepseek-v4-flash` requests are served by DeepSeek-V4.1-Flash at the Flash rate: per million tokens, input cache-hit $0.003/$0.006 off/on peak, cache-miss $0.15/$0.30, output $0.60/$1.20. Peak hours vary by weekday UTC time. This is not the configured TU Aqueduct route's verified billing rate or necessarily its exact served model, so do not use it to price these benchmark decisions.

Measured evaluator token counts (about 436 for built-in routing, 424 for custom list, 545 for skills, 505 for status, 584 for triage) are reported instead of fabricated dollar savings. The prior experiment's assumed-price savings claims are withdrawn. Subscription fees are fixed account costs; per-token API charges, any subscription quota consumption/overage, and TypeSafe charges need account/provider billing data to establish.

Quality numbers are preliminary: 6 route scenarios and 3 examples per other workflow, repeated five times. Repeats measure variability, not additional independent task coverage. Labels were authored for this benchmark and are not blind expert ratings. This does not establish downstream model quality, coding success, or whether routing saves time overall; worker completion time is not measured.

## Run it
`JEV_BENCH_RUNS=5 node tests/benchmark_jev.mjs`
`node --test tests/benchmark_cases.test.mjs`

Cases: `tests/benchmark_cases.json`
Runner writes raw decisions and aggregates to `reports/jev-benchmark-latest.json`.
