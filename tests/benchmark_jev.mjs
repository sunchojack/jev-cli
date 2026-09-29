#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { route, skills, status, triage } from '../lib/workflows.mjs';

const cases = JSON.parse(readFileSync(new URL('./benchmark_cases.json', import.meta.url), 'utf8'));
const runs = Number(process.env.JEV_BENCH_RUNS ?? 2);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('JEV_BENCH_RUNS must be 1..10');
const env = {
  ...process.env,
  TYPESAFE_API_URL: process.env.TYPESAFE_API_URL ?? 'https://llm.ascii.ac.at/typesafe/v1/systemone',
  TYPESAFE_API_KEY_ENV: process.env.TYPESAFE_API_KEY_ENV ?? 'CSH_AGENTIC_CODING_KEY',
  TYPESAFE_MODEL: process.env.TYPESAFE_MODEL ?? 'jev-latest',
  TYPESAFE_TIMEOUT_MS: process.env.TYPESAFE_TIMEOUT_MS ?? '30000',
};
const catalog = [
  { id: 'aqueduct', model: 'tu_aq_deepseek-v4-flash-284b', provider: 'csh-aqueduct', reasoning: 'inherit', description: 'Cheap capable model for routine or bounded work.' },
  { id: 'luna', model: 'subscription-gpt-6-luna', provider: 'csh-subscriptions', reasoning: 'medium', description: 'Stronger model for normal implementation and debugging.' },
  { id: 'astra', model: 'subscription-gpt-6-astra', provider: 'csh-subscriptions', reasoning: 'high', description: 'Most capable model for risky or ambiguous work.', fallback: true },
];
const modes = ['current-fixed-aqueduct', 'jev-three-choice', 'jev-custom-list', 'explicit-aqueduct-pin'];
const output = [];

function expectedFor(kind, expected) { return expected; }
function actualFor(kind, result, mode) {
  if (kind === 'route') {
    const route = result.route ?? result;
    if (mode === 'jev-custom-list') return ({ aqueduct: 'routine', luna: 'standard', astra: 'deep' })[route.id] ?? route.model;
    if (route.lane) return route.lane;
    if (route.model?.includes('astra')) return 'deep';
    if (route.model?.includes('sol')) return 'standard';
    if (route.model?.includes('luna')) return 'routine';
    return route.model;
  }
  if (kind === 'skills') return result.suggestions?.[0] ?? 'none';
  if (kind === 'status') return result.status;
  return result.category;
}

async function evaluateCase(item, mode) {
  if (item.kind === 'route' && (mode === 'current-fixed-aqueduct' || mode === 'explicit-aqueduct-pin')) {
    const result = { route: { model: 'tu_aq_deepseek-v4-flash-284b', provider: 'csh-aqueduct', reasoning: 'inherit' }, fallback: false };
    return { result, ms: 0, tokensIn: 0, tokensOut: 0, evaluator: null, decision: mode === 'current-fixed-aqueduct' ? 'no routing decision (current fixed model)' : 'pinned; Jev bypassed' };
  }
  if (item.kind !== 'route' && mode !== 'jev-three-choice') return null;
  const start = performance.now();
  let result;
  if (item.kind === 'route') {
    const selectedCatalog = mode === 'jev-custom-list' ? catalog : undefined;
    result = await route({ task: item.task, harness: 'hermes' }, { env: { ...env, ...(selectedCatalog ? { JEV_ROUTES_JSON: JSON.stringify(selectedCatalog) } : {}) } });
  } else {
    const input = { task: item.task, latest_output: item.latest_output, error: item.error, native_status: item.native_status, candidates: item.candidates };
    const fn = { skills, status, triage }[item.kind];
    result = await fn(input, { env });
  }
  const ms = performance.now() - start;
  return { result, ms, tokensIn: result.usage?.input_tokens ?? 0, tokensOut: result.usage?.output_tokens ?? 0, evaluator: result.model ?? null, decision: result.choice ?? result.suggestions?.[0] ?? result.status ?? result.category ?? result.route?.id ?? result.route?.lane ?? 'unknown' };
}

for (const item of cases) {
  for (const mode of modes) {
    if (item.kind !== 'route' && mode !== 'jev-three-choice') continue;
    for (let rep = 0; rep < runs; rep++) {
      try {
        const measured = await evaluateCase(item, mode);
        const actual = actualFor(item.kind, measured.result, mode);
        // A fixed model makes no tier choice; do not score it against a routing-label gold set.
        const correct = item.kind === 'route' && ['current-fixed-aqueduct', 'explicit-aqueduct-pin'].includes(mode)
          ? null : actual === expectedFor(item.kind, item.expected);
        output.push({ case: item.id, kind: item.kind, mode, rep, expected: item.expected,
          actual, correct,
          decision_ms: Math.round(measured.ms), input_tokens: measured.tokensIn, output_tokens: measured.tokensOut,
          evaluator: measured.evaluator, decision: measured.decision,
          fallback: measured.result.fallback ?? false, error: measured.result.reason ?? null });
      } catch (error) {
        output.push({ case: item.id, kind: item.kind, mode, rep, expected: item.expected, actual: null,
          correct: false, decision_ms: null, input_tokens: null, output_tokens: null, evaluator: null,
          error: String(error.message).slice(0, 300) });
      }
    }
  }
}
const summary = {};
for (const row of output) {
  const key = `${row.kind}/${row.mode}`;
  const s = summary[key] ??= { decisions: 0, scored: 0, correct: 0, fallbacks: 0, transport_errors: 0, total_ms: 0, total_input: 0, total_output: 0 };
  s.decisions++; s.scored += Number(row.correct !== null); s.correct += Number(row.correct === true);
  s.fallbacks += Number(row.fallback); s.transport_errors += Number(row.error !== null && !['low_confidence', 'unknown_choice'].includes(row.error));
  s.total_ms += row.decision_ms ?? 0; s.total_input += row.input_tokens ?? 0; s.total_output += row.output_tokens ?? 0;
}
for (const s of Object.values(summary)) {
  s.accuracy = s.scored ? Number((s.correct / s.scored).toFixed(3)) : null;
  s.mean_ms = s.decisions ? Math.round(s.total_ms / s.decisions) : 0;
  s.mean_input_tokens = s.decisions ? Math.round(s.total_input / s.decisions) : 0;
  s.mean_output_tokens = s.decisions ? Math.round(s.total_output / s.decisions) : 0;
}
for (const [key, s] of Object.entries(summary)) {
  if (key.startsWith('route/') && s.scored === 0) s.accuracy = null;
}
const report = { generated_at: new Date().toISOString(), baseline_evidence: 'OpenCode stats, prior 30 days: build agent most used; TU Aqueduct V4 Flash highest model session count, Astra xhigh next. Session cost fields report zero and are not billing evidence.', runs_per_case: runs, task_cases: cases.length, rows: output, summary,
  price_note: 'Subscription marginal token billing is unavailable; usage/token counts are reported, not converted to dollars. Jev evaluator cost is also unknown.' };
const path = process.env.JEV_BENCH_OUT ?? new URL('../reports/jev-benchmark-latest.json', import.meta.url).pathname;
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: path, runs_per_case: runs, task_cases: cases.length, summary, price_note: report.price_note }, null, 2));
