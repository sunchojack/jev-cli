// Price/time experiment for Jev routing across setups (live CSH endpoint).
// Measures per-decision input/output tokens and wall time for the routing call
// itself, then estimates downstream worker cost/savings vs an all-Astra baseline.
import { evaluate } from '../lib/client.mjs';

const env = {
  ...process.env,
  TYPESAFE_API_URL: process.env.TYPESAFE_API_URL ?? 'https://llm.ascii.ac.at/typesafe/v1/systemone',
  TYPESAFE_API_KEY_ENV: 'CSH_AGENTIC_CODING_KEY',
  TYPESAFE_MODEL: 'jev-latest',
  TYPESAFE_TIMEOUT_MS: '30000',
};

// Representative task battery spanning routine -> deep complexity.
const tasks = [
  { label: 'rename-var', state: 'Rename a local variable and update two call sites in this small module.' },
  { label: 'fix-test', state: 'One unit test is failing intermittently; investigate and fix the flake.' },
  { label: 'add-endpoint', state: 'Add a REST endpoint with auth and error handling to the service.' },
  { label: 'refactor-module', state: 'Refactor a 400-line module into smaller units without changing behavior.' },
  { label: 'security-review', state: 'Review this auth subsystem for security flaws and propose fixes.' },
  { label: 'ambiguous-spec', state: 'Requirements for this cross-cutting change are unclear and risky; design an approach.' },
];

// Setup: how routing decides the target model. Each returns criteria + label.
const setups = {
  // No catalog: 3 lanes. deep tasks pay Astra; routine/sol pay luna/sol.
  'jev-3lane': { lanes: ['routine', 'standard', 'deep'] },
  // Catalog with a cheap bulk model for routine + astra fallback.
  'jev-catalog-aqueduct': {
    catalog: [
      { id: 'aqueduct', model: 'tu_aq_deepseek-v4-flash-284b', provider: 'csh-aqueduct', reasoning: 'inherit', description: 'Cheap bulk flash model for routine mechanical work.', fallback: false },
      { id: 'astra', model: 'subscription-gpt-6-astra', provider: 'csh-subscriptions', reasoning: 'high', description: 'Top model for complex, ambiguous or high-risk work.', fallback: true },
    ],
  },
  // Catalog with subscription luna as the cheap tier + astra fallback.
  'jev-catalog-luna': {
    catalog: [
      { id: 'luna', model: 'subscription-gpt-6-luna', provider: 'csh-subscriptions', reasoning: 'medium', description: 'Subscription workhorse for bounded implementation.', fallback: false },
      { id: 'astra', model: 'subscription-gpt-6-astra', provider: 'csh-subscriptions', reasoning: 'high', description: 'Top model for complex, ambiguous or high-risk work.', fallback: true },
    ],
  },
};

function choice(lanes, selected) {
  return {
    type: 'choice',
    instructions: 'Which complexity lane does the task require?',
    criteria: Object.fromEntries(lanes.map(l => [l, `${l} lane`])),
  };
}

async function decide(setup, task) {
  const questions = setup.catalog
    ? { decision: { type: 'choice', instructions: 'Which configured route best fits the task?', criteria: Object.fromEntries(setup.catalog.map(e => [e.id, e.description])) } }
    : { decision: choice(setup.lanes, null) };
  const start = performance.now();
  const result = await evaluate({ state: task.state, questions, model: env.TYPESAFE_MODEL }, { env });
  const ms = performance.now() - start;
  return { ...result, decision_ms: ms, chosen: result.answers.decision.choice, confidence: result.answers.decision.confidence };
}

const reps = 2;
const rows = [];
for (const [setupName, setup] of Object.entries(setups)) {
  const seen = {};
  for (const task of tasks) {
    for (let r = 0; r < reps; r++) {
      const d = await decide(setup, task);
      rows.push({ setup: setupName, task: task.label, rep: r, decision_ms: Math.round(d.decision_ms), input: d.usage.input_tokens, output: d.usage.output_tokens, model: d.model, chosen: d.chosen, confidence: Number(d.confidence.toFixed(3)) });
    }
    await new Promise(r => setTimeout(r, 400));
  }
}
console.log(JSON.stringify(rows, null, 2));
