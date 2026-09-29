# Jev routing: price/time experiment — 2026-09-29

## What was measured
Live Jev routing decisions against the real CSH endpoint
(`https://llm.ascii.ac.at/typesafe/v1/systemone`, key from `CSH_AGENTIC_CODING_KEY`)
for a 6-task battery (rename-var .. ambiguous-spec), 2 reps each = 12 decisions per setup,
3 setups = 36 live calls. Measures the *decision overhead* Jev adds per routed task
(input/output tokens + wall time), then estimates downstream worker cost and savings
vs an all-Astra (no-Jev) baseline.

## Runtime
Experiment script: `node tests/live_price_experiment.mjs` (writes JSON).
Analysis: `node tests/analyze_price.mjs` (prints this table).
Finished in well under the window; no quota failures.

## Results

### Decision overhead (live)
setup                decisions  ms/decision  input_tok  output_tok  routing distribution
jev-3lane            12         250          338        38          routine 2, standard 6, deep 4
jev-catalog-aqueduct 12         276          342        32          aqueduct 2, astra 10
jev-catalog-luna     12         293          340        32          luna 4, astra 8

The routing decision itself is cheap: ~370 tokens and ~0.25–0.29 s per task regardless
of setup.

### Estimated cost per task ($, ASSUMED prices — see caveats)
baseline no-Jev all-Astra                   0.58500
jev-3lane            total 0.25565          -> 56% saving
jev-catalog-aqueduct total 0.13549          -> 77% saving
jev-catalog-luna     total 0.11880          -> 80% saving

## Assumptions / caveats (method details)
- Worker token volumes per lane are assumed (routine 6k/1.2k, standard 8k/2.5k,
  deep 15k/6k input/output). Prices per M tokens are illustrative:
  astra 15/60, sol 6/25, luna 3/12, aqueduct 0.27/1.10. Exact subscription
  $/token is NOT verified — treat totals as order-of-magnitude, not billing.
- Decision evaluator (jev_latest) cost treated as zero/external; its token cost is
  tiny relative to any worker.
- Savings come almost entirely from how often Jev routes a task off Astra.
  Here catalog-luna routed off-Astra most (least astra cost), so it looked best;
  a battery weighted to genuinely trivial tasks would favor the cheap tiers more,
  a benchmark/security-heavy one less.
- n=12 per setup on handpicked tasks; distribution is not a workload guarantee.

## Artifacts / state
- Raw live measurements: `reports/2026-09-29_jev_price_raw.json`
- Analysis script: `tests/analyze_price.mjs`, experiment: `tests/live_price_experiment.mjs`
- This run performed with the live endpoint; implementation+docs commit the same day.
