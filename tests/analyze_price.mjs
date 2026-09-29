import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync('/tmp/jev_price_raw.json', 'utf8'));
const bySetup = {};
for (const r of rows) (bySetup[r.setup] ??= []).push(r);

const agg = {};
for (const [name, rs] of Object.entries(bySetup)) {
  const n = rs.length;
  const avg = k => Math.round(rs.reduce((s, r) => s + r[k], 0) / n);
  const chosen = {};
  for (const r of rs) chosen[r.chosen] = (chosen[r.chosen] ?? 0) + 1;
  agg[name] = { n, decision_ms: avg('decision_ms'), input_tokens: avg('input'), output_tokens: avg('output'), decision_tokens: avg('input') + avg('output'), chosen };
}

// Label-driven cost model per M tokens (illustrative; exact subscription prices unverified).
const PRICE = { // $/M tokens [input, output]
  'subscription-gpt-6-astra': [15, 60],   // assumed top-tier
  'subscription-gpt-6-sol':   [6, 25],
  'subscription-gpt-6-luna':  [3, 12],
  'tu_aq_deepseek-v4-flash-284b': [0.27, 1.10], // DeepSeek-flash class (local/cheap)
  jev_latest: [0, 0], // decision evaluator; treat as fixed external
};
function workerCost(model, input, output) {
  const [pi, po] = PRICE[model] ?? [0, 0];
  return (input / 1e6) * pi + (output / 1e6) * po;
}

// Estimate a typical worker run's tokens (task + result) per complexity class.
// Assumed worker: ~6k input prompt, ~1.5k output for routine, more for deep.
const WORK = { routine: [6000, 1200], standard: [8000, 2500], deep: [15000, 6000] };

function setupCost(name) {
  const s = agg[name];
  const distribution = s.chosen; // fraction landing on each judged lane/entry
  const total = s.n;
  let decisionCost = 0;
  let workerCostSum = 0;
  for (const [lane, count] of Object.entries(distribution)) {
    const model = lane === 'routine' ? 'subscription-gpt-6-luna'
      : lane === 'standard' ? 'subscription-gpt-6-sol'
      : lane === 'deep' ? 'subscription-gpt-6-astra'
      : lane === 'aqueduct' ? 'tu_aq_deepseek-v4-flash-284b'
      : lane === 'luna' ? 'subscription-gpt-6-luna'
      : 'subscription-gpt-6-astra';
    const [wi, wo] = WORK[lane === 'routine' ? 'routine' : lane === 'standard' ? 'standard' : lane === 'deep' ? 'deep' : 'routine'];
    workerCostSum += (count / total) * workerCost(model, wi, wo);
  }
  decisionCost = workerCost('jev_latest', s.input_tokens, s.output_tokens);
  return { distribution: s.chosen, decision_ms: s.decision_ms, perTask: decisionCost, workerPerTask: workerCostSum, totalPerTask: decisionCost + workerCostSum };
}

// Baseline: no Jev, every task to Astra high.
function baseline() {
  const [wi, wo] = WORK.deep;
  return workerCost('subscription-gpt-6-astra', wi, wo);
}
const base = baseline();
const setupCostObj = Object.fromEntries(Object.entries(agg).map(([name]) => [name, setupCost(name)]));

console.log('== Decision overhead (live Jev calls) ==');
for (const [name, s] of Object.entries(agg)) {
  console.log(`${name}: n=${s.n} decision_ms=${s.decision_ms} in=${s.input_tokens} out=${s.output_tokens} tokens=${s.decision_tokens} distribution=${JSON.stringify(s.chosen)}`);
}
console.log('\n== Estimated cost per task ($, assumed prices) ==');
console.log('baseline no-Jev all-Astra:', base.toFixed(5));
for (const [name, c] of Object.entries(setupCostObj)) {
  const sv = (1 - c.totalPerTask / base) * 100;
  console.log(`${name}: decision=${c.perTask.toFixed(5)} worker=${c.workerPerTask.toFixed(5)} total=${c.totalPerTask.toFixed(5)} vs baseline=${(100 - sv).toFixed(0)}% (saving ${sv.toFixed(0)}%)`);
}
