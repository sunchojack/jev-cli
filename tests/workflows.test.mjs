import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Failure inventory and fixture assumptions: FAILURE_MODES.md.
// Corrected contract: Hermes read-only must reject before fetch/spawn; normal deep launches remain supported.
// Additional failures: lost evaluator provenance, descriptive "model" treated as a pin, unsupported pins silently ignored.
// Reviewed failures: native failure aliases contact Jev; negation/short/provider pins misroute; Hermes query lacks quiet mode.
// Catalog/explicit-route failure inventory (test-first, CLI integration only):
// - Catalogs are ignored, truncated, case-folded, or mixed with the three legacy lane IDs.
// - Low confidence, outages, or fabricated choices escape the single declared catalog fallback.
// - Invalid JSON/schema, duplicate IDs, >100 entries, or missing/multiple fallbacks reach fetch/spawn.
// - Explicit pins bypass catalog validation/membership, guess an ambiguous provider, or contact Jev.
// - Custom identifiers lose case/punctuation; unsafe model/provider values reach a worker/config argument.
// - Reasoning values are narrowed, inherit is forwarded literally, or Codex config values lack JSON quoting.
// Contract: env only; exactly one fallback:true; provider needs model; all nine reasoning values in both harnesses.
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const guard = 'data:text/javascript,' + encodeURIComponent(`
  import assert from 'node:assert/strict';
  import cp from 'node:child_process';
  import { appendFileSync, writeFileSync } from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const audit = event => { if (process.env.TEST_AUDIT) appendFileSync(process.env.TEST_AUDIT, JSON.stringify({ event }) + '\\n'); };
  if (process.env.TEST_AUDIT) { writeFileSync(process.env.TEST_AUDIT, ''); audit('preload'); }
  let forbidden = false;
  function prohibit() { forbidden = true; throw Error('advice must not spawn processes; workers must not use a shell'); }
  process.on('exit', () => { if (forbidden) process.exitCode = 1; });
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = cp[name];
    cp[name] = (...args) => {
      audit('process');
      if (process.env.TEST_COMMAND === 'triage' || args.some(arg => arg && typeof arg === 'object' && arg.shell)) prohibit();
      if (process.env.TEST_CAPTURE) assert.ok(['hermes', 'codex'].some(h => args[0] === h || args[0] === process.env.PATH + '/' + h), 'only fake workers are allowed');
      return original(...args);
    };
  }
  cp.exec = cp.execSync = () => { audit('process'); prohibit(); };
  syncBuiltinESMExports();
  const live = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    audit('fetch');
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('TEST_EXTERNAL_NETWORK_BLOCKED');
    return live(input, init);
  };
`);
async function run(command, state, env, flags = []) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYPESAFE_|JEV_|TEST_)/.test(k) && !['CSH_AGENTIC_CODING_KEY', 'NODE_OPTIONS'].includes(k)));
  const child = exec(process.execPath, ['--import', guard, 'bin/jev-agent.mjs', command, ...flags], { cwd: root, env: { ...clean, TYPESAFE_API_KEY: 'workflow-test-key', TYPESAFE_TIMEOUT_MS: '150', TEST_COMMAND: command, ...env }, timeout: 5000 });
  child.child.stdin.on('error', () => {}); child.child.stdin.end(state === undefined ? '' : JSON.stringify(state));
  const result = await child; return { ...result, value: command === 'worker' && !flags.includes('--dry-run') ? null : JSON.parse(result.stdout) };
}
async function endpoint(t, selected, confidence = 0.95, fault, provenance = { model: 'jev-workflow-fixture', usage: { input_tokens: 10, output_tokens: 5 } }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push(body);
    if (fault === 'network') return req.socket.destroy();
    if (fault === 'timeout') return;
    if (fault === 'malformed') return res.end('{not-json');
    if (fault === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); return res.end(); }
    if (fault === 'outage') { res.writeHead(503); return res.end('private-error-body'); }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: selected === 'none' ? 0.01 : 0.99 }];
      const keys = Object.keys(q.criteria ?? {});
      const choice = selected === 'none' ? keys.find(key => /^(none|no_skills?)$/i.test(key)) ?? 'none' : selected;
      // An unknown choice must be the only response defect, not an invalid probability sum too.
      const winner = keys.includes(choice) ? choice : keys[0];
      return [id, { type: 'choice', choice, confidence, probabilities: Object.fromEntries(keys.map(key => [key, key === winner ? (keys.length === 1 ? 1 : 0.99) : 0.01 / Math.max(1, keys.length - 1)])) }];
    }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...provenance, answers }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, env: { TYPESAFE_API_URL: `http://127.0.0.1:${server.address().port}/typesafe/v1/systemone` } };
}
function route(harness, lane) {
  const family = { routine: 'luna', standard: 'sol', deep: 'astra' }[lane];
  return { lane, model: `${harness === 'hermes' ? 'subscription-' : ''}gpt-6-${family}`, provider: harness === 'hermes' ? 'csh-subscriptions' : 'csh_openai_pull_through', reasoning: lane === 'deep' ? 'high' : 'medium' };
}
function assertRoute(value, harness, lane, fallback) {
  assert.equal(value.kind, 'route'); assert.equal(value.fallback, fallback);
  for (const [key, expected] of Object.entries(route(harness, lane))) assert.equal(value.route[key], expected, key);
}
test('route maps every lane for both harnesses at the 0.75 threshold', async t => {
  for (const harness of ['hermes', 'codex']) for (const lane of ['routine', 'standard', 'deep']) await t.test(`${harness}/${lane}`, async t => {
    const { env, calls } = await endpoint(t, lane, 0.75);
    assertRoute((await run('route', { task: 'route-001', harness }, env)).value, harness, lane, false);
    assert.ok(calls.length > 0); assert.ok(JSON.stringify(calls[0].state).includes('route-001'));
  });
});
test('route fails deep on low confidence, invalid choice, malformed JSON, timeout, redirect and outage', async t => {
  for (const harness of ['hermes', 'codex']) for (const fault of ['low', 'invalid', 'malformed', 'timeout', 'redirect', 'outage', 'network']) await t.test(`${harness}/${fault}`, async t => {
    const { env, calls } = await endpoint(t, fault === 'invalid' ? 'invented' : 'routine', fault === 'low' ? 0.749 : 0.95, fault);
    assertRoute((await run('route', { task: 'route-002', harness }, env)).value, harness, 'deep', true);
    assert.ok(calls.length > 0); if (fault === 'redirect') assert.equal(calls.length, 1);
  });
});
test('status remains advisory and respects explicit native failure', async t => {
  for (const status of ['working', 'waiting_for_input', 'blocked', 'ready_for_review', 'unclear']) await t.test(status, async t => {
    const { env } = await endpoint(t, status);
    const { value } = await run('status', { task: 'status-001', latest_output: 'Worker says finished', native_status: 'finished' }, env);
    assert.equal(value.kind, 'status'); assert.equal(value.status, status); assert.equal(typeof value.needs_attention, 'boolean');
    assert.notEqual(value.success, true);
  });
  for (const native_status of ['failed', 'blocked', 'interrupted', 'error', 'timeout', 'timed_out', 'crashed', 'cancelled']) await t.test(native_status, async t => {
    const { env, calls } = await endpoint(t, 'ready_for_review');
    const dir = await mkdtemp(join(tmpdir(), 'jev-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const audit = join(dir, 'attempts.jsonl');
    const { value } = await run('status', { task: 'status-002', latest_output: 'All done!', native_status }, { ...env, TEST_AUDIT: audit });
    assert.equal(value.kind, 'status'); assert.ok(['blocked', 'unclear'].includes(value.status)); assert.equal(value.needs_attention, true);
    assert.equal(value.source, 'native'); assert.notEqual(value.success, true); assert.deepEqual(calls, []);
    assert.deepEqual((await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [{ event: 'preload' }]);
  });
});
test('skills suggests only supplied names or none and does not erase mandatory task text', async t => {
  for (const selection of ['python', 'none', 'invented']) await t.test(selection, async t => {
    const { env, calls } = await endpoint(t, selection);
    const state = { task: 'skills-001: Mandatory: preserve AGENTS.md instructions.', candidates: [{ name: 'python', description: 'Python implementation' }] };
    const { value } = await run('skills', state, env);
    assert.equal(value.kind, 'skills'); assert.ok(Array.isArray(value.suggestions));
    assert.ok(value.suggestions.every(name => name === 'python')); assert.equal(new Set(value.suggestions).size, value.suggestions.length);
    if (selection === 'none') assert.deepEqual(value.suggestions, []);
    assert.ok(JSON.stringify(calls[0]).includes(state.task));
  });
});
test('triage emits only the defined advisory categories', async t => {
  for (const category of ['authentication', 'quota', 'dependency', 'code_defect', 'missing_verification', 'user_decision', 'none', 'unclear']) await t.test(category, async t => {
    const { env } = await endpoint(t, category);
    const { value } = await run('triage', { task: 'triage-001', latest_output: 'fixture output', error: 'fixture error' }, env);
    assert.equal(value.kind, 'triage'); assert.equal(value.category, category); assert.equal(typeof value.needs_attention, 'boolean');
  });
});
test('workflow receipts preserve evaluator model and usage on accepted and low-confidence responses', async t => {
  const cases = [
    ['route', 'routine', { harness: 'hermes' }], ['status', 'working', { latest_output: 'In progress' }],
    ['skills', 'python', { candidates: [{ name: 'python', description: 'Python work' }] }],
    ['triage', 'dependency', { latest_output: 'Dependency unavailable', error: 'Import failed' }],
  ];
  for (const [command, selection, state] of cases) for (const confidence of [0.95, 0.74]) await t.test(`${command}/${confidence}`, async t => {
    const provenance = { model: `jev-resolved-${command}-${confidence}`, usage: { input_tokens: 123, output_tokens: confidence === 0.95 ? 17 : 29 } };
    const { env, calls } = await endpoint(t, selection, confidence, undefined, provenance);
    const { value } = await run(command, { task: 'provenance-001', ...state }, { ...env, TYPESAFE_MODEL: 'jev-requested-alias' });
    assert.equal(calls.length, 1); assert.equal(calls[0].model, 'jev-requested-alias');
    assert.equal(value.kind, command); assert.equal(value.model, provenance.model); assert.deepEqual(value.usage, provenance.usage);
    assert.equal(value.fallback, confidence < 0.75);
    if (command === 'route') assertRoute(value, 'hermes', confidence < 0.75 ? 'deep' : 'routine', confidence < 0.75);
  });
});
function flag(args, ...names) { const index = args.findIndex(arg => names.includes(arg)); return index < 0 ? undefined : args[index + 1]; }
async function workerFixture(t, task) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-worker-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'work space'); await mkdir(cwd);
  const capture = join(dir, 'capture.jsonl'), marker = join(dir, 'SHELL_EXECUTED'), file = join(dir, 'prompt file.txt');
  const prompt = task ?? `worker-001; $(printf exploited > '${marker}')\nKeep "quotes" and $HOME literal.`; await writeFile(file, prompt);
  for (const harness of ['hermes', 'codex']) await writeFile(join(dir, harness), `#!${process.execPath}
    const fs = require('node:fs'); const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_CAPTURE, JSON.stringify({ args, cwd: process.cwd(), input: args.includes(process.env.TEST_PROMPT) ? '' : fs.readFileSync(0, 'utf8') }) + '\\n');
    const i = args.findIndex(a => a === '-o' || a === '--output-last-message');
    if (i >= 0) { fs.writeFileSync(args[i + 1], 'fixture last worker output\\n'); console.log('progress only'); }
    else console.log('fixture last worker output');
  `, { mode: 0o755 });
  return { cwd, capture, marker, file, prompt, env: { PATH: dir, TEST_CAPTURE: capture, TEST_PROMPT: prompt, TEST_AUDIT: join(dir, 'attempts.jsonl') } };
}
test('worker selects arguments before spawn, preserves literal prompts and cwd, and honors dry-run/Codex read-only', async t => {
  const { cwd, capture, marker, file, prompt, env: workerEnv } = await workerFixture(t);
  for (const harness of ['hermes', 'codex']) for (const lane of ['routine', 'standard', 'deep']) await t.test(`${harness}/${lane}`, async t => {
    const { env, calls } = await endpoint(t, lane);
    Object.assign(env, workerEnv);
    const args = ['--harness', harness, '--cwd', cwd, '--prompt-file', file, ...(harness === 'codex' && lane === 'deep' ? ['--read-only'] : [])];
    const before = await readFile(capture, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const { value: dry } = await run('worker', undefined, env, [...args, '--dry-run']);
    assert.equal(dry.cwd, cwd); assert.equal(basename(dry.command), harness); assert.ok(Array.isArray(dry.args));
    const planned = dry.route.route ?? dry.route;
    for (const [key, expected] of Object.entries(route(harness, lane))) assert.equal(planned[key], expected);
    assert.ok(dry.args.some(arg => arg === planned.reasoning || arg.replaceAll('"', '') === `model_reasoning_effort=${planned.reasoning}`));
    assert.equal(await readFile(capture, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), before);
    const result = await run('worker', undefined, env, args); assert.equal(result.stdout.trim(), 'fixture last worker output');
    const records = (await readFile(capture, 'utf8')).trim().split('\n'); assert.equal(records.length, before ? before.trim().split('\n').length + 1 : 1);
    const spawned = JSON.parse(records.at(-1)); assert.equal(spawned.cwd, cwd);
    for (const expected of [route(harness, lane).model, harness === 'hermes' ? route(harness, lane).provider : `model_provider="${route(harness, lane).provider}"`]) {
      assert.ok(dry.args.some(arg => arg.replaceAll('"', '') === expected.replaceAll('"', '')));
    }
    assert.ok(spawned.args.includes(prompt) || spawned.input === prompt); assert.equal(flag(spawned.args, '-m', '--model'), route(harness, lane).model);
    if (harness === 'hermes') {
      assert.equal(flag(spawned.args, '--provider'), 'csh-subscriptions'); assert.equal(flag(spawned.args, '--reasoning'), route(harness, lane).reasoning);
      // Installed Hermes parser: -Q is boolean quiet; -q/--query consumes TASK. Bare "-Q TASK" is invalid.
      for (const argv of [dry.args, spawned.args]) {
        const chat = argv.indexOf('chat'); assert.ok(chat >= 0);
        assert.ok(argv.slice(chat + 1).includes('-Q')); assert.equal(flag(argv.slice(chat + 1), '-q', '--query'), prompt);
      }
    } else {
      assert.ok(spawned.args.includes('exec'));
      const config = spawned.args.filter((_, i) => ['-c', '--config'].includes(spawned.args[i - 1])).map(s => s.replaceAll('"', '').replaceAll("'", ''));
      assert.ok(config.includes('model_provider=csh_openai_pull_through')); assert.ok(config.includes(`model_reasoning_effort=${route(harness, lane).reasoning}`));
      if (lane === 'deep') assert.equal(flag(spawned.args, '-s', '--sandbox'), 'read-only');
    }
    const logged = result.stderr.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(logged.some(value => (value.route?.route ?? value.route ?? value).model === route(harness, lane).model));
    const attempts = (await readFile(workerEnv.TEST_AUDIT, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    assert.ok(attempts.includes('fetch')); assert.ok(attempts.includes('process'));
    assert.ok(calls.length >= 2); assert.ok(calls.every(body => JSON.stringify(body.state).includes('worker-001')));
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });
});
test('Hermes read-only rejects before network or process attempts, including dry-run', async t => {
  for (const dry of [false, true]) await t.test(dry ? 'dry-run' : 'launch', async t => {
    const worker = await workerFixture(t, 'Read the project files');
    const { env, calls } = await endpoint(t, 'deep');
    const args = ['--harness', 'hermes', '--cwd', worker.cwd, '--prompt-file', worker.file, '--read-only', ...(dry ? ['--dry-run'] : [])];
    await assert.rejects(run('worker', undefined, { ...env, ...worker.env }, args), error => {
      assert.equal(error.code, 1); assert.equal(error.killed, false); assert.equal(error.stdout, '');
      assert.match(error.stderr, /hermes/i); assert.match(error.stderr, /read-only/i); assert.match(error.stderr, /unsupported|not supported|cannot|unavailable/i);
      return true;
    });
    assert.deepEqual(calls, []);
    assert.deepEqual((await readFile(worker.env.TEST_AUDIT, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [{ event: 'preload' }]);
    await assert.rejects(access(worker.capture), { code: 'ENOENT' });
  });
});
test('descriptive model wording routes and launches while unsupported pins require explicit --model', async t => {
  for (const harness of ['hermes', 'codex']) await t.test(harness, async t => {
    const worker = await workerFixture(t, 'Fit a regression model');
    const { env, calls } = await endpoint(t, 'standard');
    const configured = { ...env, ...worker.env };
    const args = ['--harness', harness, '--cwd', worker.cwd, '--prompt-file', worker.file];
    const { value } = await run('route', { task: worker.prompt, harness }, configured);
    assertRoute(value, harness, 'standard', false); assert.notEqual(value.requires_model, true);
    assert.equal((await run('worker', undefined, configured, args)).stdout.trim(), 'fixture last worker output');
    assert.equal(calls.length, 2); assert.ok(calls.every(body => JSON.stringify(body.state).includes(worker.prompt)));
    const before = await readFile(worker.capture, 'utf8'); const spawned = JSON.parse(before.trim());
    assert.equal(spawned.cwd, worker.cwd); assert.equal(flag(spawned.args, '-m', '--model'), route(harness, 'standard').model);
    assert.ok(spawned.args.includes(worker.prompt) || spawned.input === worker.prompt);
    const pin = 'Use claude-opus-4 to fit a regression model'; await writeFile(worker.file, pin);
    const pinnedRoute = (await run('route', { task: pin, harness }, configured)).value;
    assert.equal(pinnedRoute.kind, 'route'); assert.equal(pinnedRoute.requires_model, true);
    await assert.rejects(run('worker', undefined, configured, args), error => {
      assert.equal(error.code, 1); assert.equal(error.killed, false); assert.equal(error.stdout, ''); assert.match(error.stderr, /--model/); return true;
    });
    assert.equal(await readFile(worker.capture, 'utf8'), before);
    assert.ok(!(await readFile(worker.env.TEST_AUDIT, 'utf8')).includes('"event":"process"'));
    const model = route(harness, 'deep').model;
    assert.equal((await run('worker', undefined, { ...configured, TEST_PROMPT: pin }, [...args, '--model', model])).stdout.trim(), 'fixture last worker output');
    const records = (await readFile(worker.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2); assert.equal(flag(records[1].args, '-m', '--model'), model); assert.equal(records[1].cwd, worker.cwd);
    assert.ok(records[1].args.includes(pin) || records[1].input === pin);
  });
});
test('negated, short, provider-qualified and prose-adjacent pins never silently select Luna', async t => {
  for (const harness of ['hermes', 'codex']) for (const [label, task, lane] of [
    ['negated', 'Do not use gpt-6-luna. Review this security design.', 'deep'],
    ['short flag', '-m subscription-gpt-6-astra', 'deep'],
    ['provider prefix', `Use ${route(harness, 'deep').provider}/${route(harness, 'deep').model} for this review`, 'deep'],
    ['trailing prose', 'Use gpt-6-sol and summarize this file', 'standard'],
  ]) await t.test(`${harness}/${label}`, async t => {
    const worker = await workerFixture(t, task);
    const { env } = await endpoint(t, label === 'negated' ? 'deep' : 'routine');
    const configured = { ...env, ...worker.env };
    const args = ['--harness', harness, '--cwd', worker.cwd, '--prompt-file', worker.file];
    const { value } = await run('route', { task, harness }, configured);
    assert.equal(value.kind, 'route'); assert.notEqual(value.route.model, route(harness, 'routine').model);
    const needsModel = value.requires_model === true || value.needs_model === true;
    if (needsModel) {
      await assert.rejects(run('worker', undefined, configured, args), error => { assert.equal(error.code, 1); assert.equal(error.killed, false); assert.match(error.stderr, /--model/); return true; });
      await assert.rejects(access(worker.capture), { code: 'ENOENT' });
      assert.ok(!(await readFile(worker.env.TEST_AUDIT, 'utf8')).includes('"event":"process"'));
    } else {
      assert.equal(value.route.model, route(harness, lane).model);
      assert.equal((await run('worker', undefined, configured, args)).stdout.trim(), 'fixture last worker output');
      const spawned = JSON.parse((await readFile(worker.capture, 'utf8')).trim());
      assert.equal(flag(spawned.args, '-m', '--model'), route(harness, lane).model);
    }
    const canonical = route(harness, 'deep').model;
    assert.equal((await run('worker', undefined, configured, [...args, '--model', canonical])).stdout.trim(), 'fixture last worker output');
    const records = (await readFile(worker.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, needsModel ? 1 : 2); assert.equal(flag(records.at(-1).args, '-m', '--model'), canonical);
    assert.equal(records.at(-1).cwd, worker.cwd); assert.ok(records.at(-1).args.includes(task) || records.at(-1).input === task);
  });
});

// Independent fixture values deliberately differ from the legacy model/provider families.
function catalogFixture() {
  return [
    { id: 'Aqueduct.Fast', model: 'Team/Aqueduct:v2.1_Custom-model', provider: 'Aqueduct/Primary:v1.2_pool-test', reasoning: 'low', description: 'Quick bounded implementation.' },
    { id: 'aqueduct.fast', model: 'team/aqueduct-v2.1_custom', provider: 'Aqueduct:Secondary.v1_pool', reasoning: 'medium', description: 'General implementation.', fallback: false },
    { id: 'Catalog.Safe', model: 'Team/Anchor-v3', provider: 'Local:Reserve.v2_pool', reasoning: 'inherit', description: 'Conservative fallback for uncertainty.', fallback: true },
  ];
}
const catalogEnv = entries => ({ JEV_ROUTES_JSON: JSON.stringify(entries) });
const reasoningValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'inherit'];
function assertCatalogRoute(value, entry, fallback) {
  assert.equal(value.kind, 'route'); assert.equal(value.fallback, fallback);
  for (const key of ['id', 'model', 'provider', 'reasoning']) assert.equal(value.route[key], entry[key], key);
}
function assertCatalogQuestion(calls, entries) {
  assert.equal(calls.length, 1);
  const questions = Object.values(calls[0].questions);
  assert.equal(questions.length, 1); assert.equal(questions[0].type, 'choice');
  assert.deepEqual(Object.keys(questions[0].criteria).sort(), entries.map(entry => entry.id).sort());
  for (const entry of entries) assert.ok(JSON.stringify(questions[0].criteria[entry.id]).includes(entry.description), entry.id);
}
async function auditEvents(worker) {
  return (await readFile(worker.env.TEST_AUDIT, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
}
async function assertRejectedBeforeEffects(command, state, env, flags, worker, calls, diagnostic) {
  await assert.rejects(run(command, state, { ...env, ...worker.env }, flags), error => {
    assert.equal(error.code, 1); assert.equal(error.killed, false); assert.equal(error.stdout, '');
    assert.match(error.stderr, diagnostic); return true;
  });
  assert.deepEqual(calls, []); assert.deepEqual(await auditEvents(worker), ['preload']);
  await assert.rejects(access(worker.capture), { code: 'ENOENT' });
  await assert.rejects(access(worker.marker), { code: 'ENOENT' });
}
function workerFlags(worker, harness) {
  return ['--harness', harness, '--cwd', worker.cwd, '--prompt-file', worker.file];
}
function assertWorkerArgs(args, harness, expected, prompt) {
  assert.equal(flag(args, '-m', '--model'), expected.model);
  assert.equal(args.filter(arg => ['-m', '--model'].includes(arg)).length, 1);
  if (harness === 'hermes') {
    assert.equal(flag(args, '--provider'), expected.provider);
    assert.equal(args.filter(arg => arg === '--provider').length, 1);
    assert.ok(args.includes('chat')); assert.ok(args.includes('-Q')); assert.equal(flag(args, '-q', '--query'), prompt);
    if (expected.reasoning === 'inherit') assert.ok(!args.some(arg => /^--reasoning(?:=|$)/.test(arg)));
    else { assert.equal(flag(args, '--reasoning'), expected.reasoning); assert.equal(args.filter(arg => arg === '--reasoning').length, 1); }
  } else {
    assert.ok(args.includes('exec'));
    const configs = args.filter((_, i) => ['-c', '--config'].includes(args[i - 1]));
    assert.deepEqual(configs.filter(arg => /^model_provider\s*=/.test(arg)), [`model_provider=${JSON.stringify(expected.provider)}`]);
    const reasoning = configs.filter(arg => /^model_reasoning_effort\s*=/.test(arg));
    assert.deepEqual(reasoning, expected.reasoning === 'inherit' ? [] : [`model_reasoning_effort=${JSON.stringify(expected.reasoning)}`]);
    if (expected.reasoning === 'inherit') assert.ok(!args.some(arg => /model_reasoning_effort\s*=/.test(arg)));
  }
}
async function exerciseWorker(worker, harness, env, expected, extraFlags, calls, requestsPerRun = 0) {
  const flags = [...workerFlags(worker, harness), ...extraFlags];
  const configured = { ...env, ...worker.env };
  const { value: dry } = await run('worker', undefined, configured, [...flags, '--dry-run']);
  assert.equal(dry.cwd, worker.cwd); assert.equal(basename(dry.command), harness);
  for (const key of ['model', 'provider', 'reasoning']) assert.equal((dry.route.route ?? dry.route)[key], expected[key], key);
  if (expected.id !== undefined) assert.equal((dry.route.route ?? dry.route).id, expected.id);
  assertWorkerArgs(dry.args, harness, expected, worker.prompt);
  assert.equal(calls.length, requestsPerRun);
  assert.deepEqual(await auditEvents(worker), ['preload', ...Array(requestsPerRun).fill('fetch')]);
  await assert.rejects(access(worker.capture), { code: 'ENOENT' });
  const result = await run('worker', undefined, configured, flags);
  assert.equal(result.stdout.trim(), 'fixture last worker output');
  const records = (await readFile(worker.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1); assert.equal(records[0].cwd, worker.cwd);
  assertWorkerArgs(records[0].args, harness, expected, worker.prompt);
  assert.ok(records[0].args.includes(worker.prompt) || records[0].input === worker.prompt);
  const receipt = result.stderr.trim().split('\n').map(line => JSON.parse(line)).find(value => value.kind === 'route');
  assert.ok(receipt);
  for (const key of ['model', 'provider', 'reasoning']) assert.equal(receipt.route[key], expected[key], key);
  if (expected.id !== undefined) assert.equal(receipt.route.id, expected.id);
  assert.equal(calls.length, requestsPerRun * 2);
  assert.deepEqual(await auditEvents(worker), ['preload', ...Array(requestsPerRun).fill('fetch'), 'process']);
  await assert.rejects(access(worker.marker), { code: 'ENOENT' });
}

test('catalog route sends exact case-sensitive IDs and selects each entry at the confidence threshold', async t => {
  const entries = catalogFixture();
  for (const harness of ['hermes', 'codex']) for (const entry of entries) await t.test(`${harness}/${entry.id}`, async t => {
    const { env, calls } = await endpoint(t, entry.id, 0.75);
    const { value } = await run('route', { task: 'catalog-001: inspect this change', harness }, { ...env, ...catalogEnv(entries) });
    assertCatalogQuestion(calls, entries); assertCatalogRoute(value, entry, false);
  });
});
test('catalog route accepts one through 100 entries without truncating candidates', async t => {
  for (const size of [1, 100]) await t.test(String(size), async t => {
    const entries = Array.from({ length: size }, (_, index) => ({ ...catalogFixture()[0], id: `Route.${index}`, model: `Team/Aqueduct-${index}`, fallback: index === 0 }));
    const selected = entries.at(-1);
    const { env, calls } = await endpoint(t, selected.id);
    const { value } = await run('route', { task: 'catalog-size', harness: 'codex' }, { ...env, ...catalogEnv(entries) });
    assertCatalogQuestion(calls, entries); assertCatalogRoute(value, selected, false);
  });
});
test('catalog route uses only the declared fallback for uncertainty, fabricated choices and transport failures', async t => {
  const entries = catalogFixture(), fallback = entries[2];
  for (const harness of ['hermes', 'codex']) for (const fault of ['low', 'fabricated', 'legacy-deep', 'wrong-case', 'outage', 'network', 'timeout', 'malformed', 'redirect']) await t.test(`${harness}/${fault}`, async t => {
    const selected = { fabricated: 'Fabricated/Injected', 'legacy-deep': 'deep', 'wrong-case': 'AQUEDUCT.FAST' }[fault] ?? entries[0].id;
    const { env, calls } = await endpoint(t, selected, fault === 'low' ? 0.749 : 0.95, fault);
    const { value } = await run('route', { task: 'catalog-fallback', harness }, { ...env, ...catalogEnv(entries) });
    assertCatalogQuestion(calls, entries); assertCatalogRoute(value, fallback, true);
  });
});
test('catalog worker dry-run and launch honor selected and fallback entries including inherit', async t => {
  const entries = catalogFixture();
  for (const harness of ['hermes', 'codex']) for (const fault of ['accepted', 'low', 'fabricated', 'outage']) await t.test(`${harness}/${fault}`, async t => {
    const worker = await workerFixture(t);
    const { env, calls } = await endpoint(t, fault === 'fabricated' ? 'InjectedModel' : entries[0].id, fault === 'low' ? 0.74 : 0.95, fault);
    await exerciseWorker(worker, harness, { ...env, ...catalogEnv(entries) }, fault === 'accepted' ? entries[0] : entries[2], [], calls, 1);
  });
});

test('explicit custom Aqueduct worker accepts low and inherit without contacting Jev, with or without a catalog', async t => {
  for (const harness of ['hermes', 'codex']) for (const withCatalog of [false, true]) for (const reasoning of ['low', 'inherit']) await t.test(`${harness}/${withCatalog ? 'catalog' : 'no catalog'}/${reasoning}`, async t => {
    const worker = await workerFixture(t);
    const entries = catalogFixture(), expected = { ...entries[0], reasoning };
    if (!withCatalog) delete expected.id;
    const { env, calls } = await endpoint(t, 'deep', 0.99, 'outage');
    await exerciseWorker(worker, harness, { ...env, ...(withCatalog ? catalogEnv(entries) : {}) }, expected,
      ['--model', expected.model, '--provider', expected.provider, '--reasoning', reasoning], calls);
  });
});
test('explicit known models infer the legacy provider without a catalog and accept every reasoning value', async t => {
  for (const harness of ['hermes', 'codex']) for (const reasoning of reasoningValues) await t.test(`${harness}/${reasoning}`, async t => {
    const worker = await workerFixture(t);
    const expected = { ...route(harness, 'standard'), reasoning };
    const { env, calls } = await endpoint(t, 'deep', 0.99, 'outage');
    await exerciseWorker(worker, harness, env, expected, ['--model', expected.model, '--reasoning', reasoning], calls);
  });
});
test('explicit catalog models resolve a unique match and provider disambiguates a shared model', async t => {
  for (const harness of ['hermes', 'codex']) for (const selection of ['unique', 'primary', 'secondary']) await t.test(`${harness}/${selection}`, async t => {
    const worker = await workerFixture(t);
    const entries = catalogFixture();
    if (selection !== 'unique') entries[1].model = entries[0].model;
    const expected = entries[selection === 'secondary' ? 1 : 0];
    const { env, calls } = await endpoint(t, 'deep');
    await exerciseWorker(worker, harness, { ...env, ...catalogEnv(entries) }, expected,
      ['--model', expected.model, ...(selection === 'unique' ? [] : ['--provider', expected.provider])], calls);
  });
});
test('catalog entries accept every reasoning value and pass it through to both harnesses', async t => {
  for (const harness of ['hermes', 'codex']) for (const reasoning of reasoningValues) await t.test(`${harness}/${reasoning}`, async t => {
    const worker = await workerFixture(t);
    const entries = catalogFixture(); entries[0].reasoning = reasoning;
    const { env, calls } = await endpoint(t, entries[0].id);
    await exerciseWorker(worker, harness, { ...env, ...catalogEnv(entries) }, entries[0], [], calls, 1);
  });
});
test('route JSON accepts explicit model, provider and reasoning without requesting a choice', async t => {
  for (const harness of ['hermes', 'codex']) for (const selection of ['custom pair', 'catalog pair', 'catalog unique', 'known model']) for (const reasoning of ['low', 'inherit']) await t.test(`${harness}/${selection}/${reasoning}`, async t => {
    const worker = await workerFixture(t);
    const entries = catalogFixture(), withCatalog = selection.startsWith('catalog');
    const expected = { ...(selection === 'known model' ? route(harness, 'routine') : entries[0]), reasoning };
    const state = { task: worker.prompt, harness, model: expected.model, reasoning,
      ...(['custom pair', 'catalog pair'].includes(selection) ? { provider: expected.provider } : {}) };
    const { env, calls } = await endpoint(t, 'deep', 0.99, 'outage');
    const { value } = await run('route', state, { ...env, ...worker.env, ...(withCatalog ? catalogEnv(entries) : {}) });
    assert.equal(value.kind, 'route'); assert.equal(value.fallback, false);
    for (const key of ['model', 'provider', 'reasoning']) assert.equal(value.route[key], expected[key], key);
    if (withCatalog) assert.equal(value.route.id, expected.id);
    assert.deepEqual(calls, []); assert.deepEqual(await auditEvents(worker), ['preload']);
    await assert.rejects(access(worker.capture), { code: 'ENOENT' });
  });
});

test('invalid catalogs reject route, pinned route, worker and pinned dry-run before fetch or spawn', async t => {
  const entries = catalogFixture();
  const invalid = [
    ['malformed JSON', '{not-json'], ['empty env', ''], ['blank env', '   '],
    ...[null, {}, 'routes', 1, [], [null], [[]]].map(value => [`invalid shape ${JSON.stringify(value)}`, JSON.stringify(value)]),
    ['duplicate IDs', JSON.stringify([entries[0], { ...entries[1], id: entries[0].id }, entries[2]])],
    ['101 entries', JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ ...entries[0], id: `Route.${index}`, fallback: index === 0 })))],
    ['no fallback', JSON.stringify(entries.map(entry => ({ ...entry, fallback: false })))],
    ['two fallbacks', JSON.stringify(entries.map((entry, index) => ({ ...entry, fallback: index !== 1 })))],
    ['nonboolean fallback', JSON.stringify([{ ...entries[0], fallback: 'true' }, entries[2]])],
    ['invalid reasoning', JSON.stringify([{ ...entries[0], reasoning: 'turbo' }, entries[2]])],
    ['unsafe model', JSON.stringify([{ ...entries[0], model: 'Aqueduct;touch' }, entries[2]])],
    ['unsafe provider', JSON.stringify([{ ...entries[0], provider: 'Pool";injected=true' }, entries[2]])],
    ['control in model', JSON.stringify([{ ...entries[0], model: 'Aqueduct\u0000Injected' }, entries[2]])],
    ['leading dash provider', JSON.stringify([{ ...entries[0], provider: '-Pool' }, entries[2]])],
  ];
  for (const key of ['id', 'model', 'provider', 'reasoning', 'description']) {
    const missing = { ...entries[0] }; delete missing[key];
    invalid.push([`missing ${key}`, JSON.stringify([missing, entries[2]])]);
    invalid.push([`nonstring ${key}`, JSON.stringify([{ ...entries[0], [key]: 42 }, entries[2]])]);
    if (key !== 'description') invalid.push([`empty ${key}`, JSON.stringify([{ ...entries[0], [key]: '' }, entries[2]])]);
  }
  for (const harness of ['hermes', 'codex']) for (const mode of ['route', 'pinned route', 'worker', 'pinned dry-run']) for (const [label, json] of invalid) await t.test(`${harness}/${mode}/${label}`, async t => {
    const worker = await workerFixture(t);
    const { env, calls } = await endpoint(t, 'routine');
    const known = route(harness, 'routine');
    const command = mode.includes('route') ? 'route' : 'worker';
    const state = command === 'route' ? { task: worker.prompt, harness, ...(mode === 'pinned route' ? { model: known.model } : {}) } : undefined;
    const flags = command === 'worker' ? [...workerFlags(worker, harness), ...(mode === 'pinned dry-run' ? ['--model', known.model, '--dry-run'] : [])] : [];
    await assertRejectedBeforeEffects(command, state, { ...env, JEV_ROUTES_JSON: json }, flags, worker, calls, /catalog|JEV_ROUTES_JSON|routes/i);
  });
});
test('explicit resolution rejects missing providers, ambiguous models and pairs outside the catalog before effects', async t => {
  for (const harness of ['hermes', 'codex']) {
    const entries = catalogFixture(), shared = entries.map((entry, index) => index === 1 ? { ...entry, model: entries[0].model } : entry);
    const cases = [
      ['custom needs provider', undefined, { model: entries[0].model }, /provider/i],
      ['provider needs model', undefined, { provider: entries[0].provider }, /model/i],
      ['catalog provider needs model', entries, { provider: entries[0].provider }, /model/i],
      ['ambiguous model', shared, { model: entries[0].model }, /ambig|provider/i],
      ['unknown model', entries, { model: 'Team/Absent' }, /model|catalog|route/i],
      ['crossed pair', entries, { model: entries[0].model, provider: entries[1].provider }, /provider|catalog|route/i],
      ['unknown provider', entries, { model: entries[0].model, provider: 'Missing:Pool' }, /provider|catalog|route/i],
      ['model case mismatch', entries, { model: entries[0].model.toUpperCase(), provider: entries[0].provider }, /model|catalog|route/i],
      ['legacy model outside catalog', entries, { model: route(harness, 'deep').model }, /model|catalog|route/i],
      ['legacy pair outside catalog', entries, { model: route(harness, 'deep').model, provider: route(harness, 'deep').provider }, /model|provider|catalog|route/i],
      ['unsupported reasoning', undefined, { model: route(harness, 'routine').model, reasoning: 'turbo' }, /reasoning/i],
    ];
    for (const mode of ['route', 'worker', 'dry-run']) for (const [label, catalog, fields, diagnostic] of cases) await t.test(`${harness}/${mode}/${label}`, async t => {
      const worker = await workerFixture(t);
      const { env, calls } = await endpoint(t, 'routine');
      const command = mode === 'route' ? 'route' : 'worker';
      const state = command === 'route' ? { task: worker.prompt, harness, ...fields } : undefined;
      const flags = command === 'worker' ? [...workerFlags(worker, harness), ...Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value]), ...(mode === 'dry-run' ? ['--dry-run'] : [])] : [];
      await assertRejectedBeforeEffects(command, state, { ...env, ...(catalog ? catalogEnv(catalog) : {}) }, flags, worker, calls, diagnostic);
    });
  }
});
test('unsafe explicit model and provider tokens reject before network or worker launch', async t => {
  const invalid = [
    ['empty', ''], ['space', 'Team Aqueduct'], ['tab', 'Team\tAqueduct'], ['newline', 'Team\nAqueduct'],
    ['control', 'Team\u0001Aqueduct'], ['DEL', 'Team\u007fAqueduct'], ['leading dash', '-Aqueduct'],
    ['semicolon', 'Aqueduct;touch'], ['substitution', 'Aqueduct$(id)'], ['backticks', 'Aqueduct`id`'],
    ['pipe', 'Aqueduct|id'], ['ampersand', 'Aqueduct&id'], ['redirection', 'Aqueduct>output'],
    ['double quote', 'Aqueduct"Injected'], ['single quote', "Aqueduct'Injected"], ['backslash', 'Aqueduct\\Injected'],
  ];
  for (const harness of ['hermes', 'codex']) for (const command of ['route', 'worker']) for (const field of ['model', 'provider']) for (const [label, value] of invalid) await t.test(`${harness}/${command}/${field}/${label}`, async t => {
    const worker = await workerFixture(t);
    const { env, calls } = await endpoint(t, 'routine');
    const fields = { model: catalogFixture()[0].model, provider: catalogFixture()[0].provider, reasoning: 'low', [field]: value };
    const state = command === 'route' ? { task: worker.prompt, harness, ...fields } : undefined;
    const flags = command === 'worker' ? [...workerFlags(worker, harness), ...Object.entries(fields).flatMap(([key, token]) => [`--${key}`, token])] : [];
    await assertRejectedBeforeEffects(command, state, env, flags, worker, calls, /model|provider|option|invalid/i);
  });
});
