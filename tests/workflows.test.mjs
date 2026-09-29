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
      return [id, { type: 'choice', choice, confidence, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? (keys.length === 1 ? 1 : 0.99) : 0.01 / Math.max(1, keys.length - 1)])) }];
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
