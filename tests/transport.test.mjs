import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Failure inventory and interface limits: FAILURE_MODES.md. No public API calls.
// Reviewed failures: CSH selector leaks before host validation; structured legends and rounded scores rejected.
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const secret = 'test-secret-never-print';
const request = { state: { id: 'transport-001', text: ['native', 'state'] }, questions: {
  yes: { type: 'noul', instructions: { question: 'Relevant?' } },
  lane: { type: 'choice', instructions: 'Pick', criteria: { routine: null, deep: 'Complex' } },
  score: { type: 'score', instructions: ['Rate'], criteria: ['Low', 'High'] },
} };
const envelope = { model: 'jev-fixture-1', answers: {
  yes: { type: 'noul', noul: 0.9 },
  lane: { type: 'choice', choice: 'routine', probabilities: { routine: 0.95, deep: 0.05 }, confidence: 0.8 },
  score: { type: 'score', score: 0.9, legend: { 0: 'Low', 1: 'High' }, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.8 },
}, usage: { input_tokens: 42, output_tokens: 17 } };
const guard = 'data:text/javascript,' + encodeURIComponent(`
  import assert from 'node:assert/strict';
  import { appendFileSync, writeFileSync } from 'node:fs';
  if (process.env.TEST_AUDIT) writeFileSync(process.env.TEST_AUDIT, '');
  const live = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (process.env.TEST_AUDIT) appendFileSync(process.env.TEST_AUDIT, JSON.stringify({ url: url.href }) + '\\n');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (process.env.TEST_DEFAULT_ENDPOINT === '1') {
      assert.equal(url.href, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(JSON.parse(init.body).model, 'jev-latest');
      assert.equal(init.headers.Authorization ?? new Headers(init.headers).get('authorization'), 'Bearer ${secret}');
      return Promise.resolve(Response.json(${JSON.stringify(envelope)}));
    }
    if (process.env.TEST_HTTP_RELAY && url.href === 'https://llm.ascii.ac.at/typesafe/v1/systemone') return live(process.env.TEST_HTTP_RELAY, init);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('TEST_EXTERNAL_NETWORK_BLOCKED');
    return live(input, init);
  };
`);
async function run(args, env, input = '') {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYPESAFE_|TEST_)/.test(k) && !['CSH_AGENTIC_CODING_KEY', 'CSH_OPENAI_PULL_THROUGH_TOKEN', 'ASCII_AGENTIC_CODING_KEY', 'NODE_OPTIONS'].includes(k)));
  const child = exec(process.execPath, ['--import', guard, ...args], { cwd: root, env: { ...clean, TYPESAFE_API_KEY: secret, ...env }, timeout: 12000 });
  child.child.stdin.on('error', () => {});
  child.child.stdin.end(input);
  try { return { code: 0, ...await child }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
function json(result) { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }
async function evaluate(env, value = request) {
  return json(await run(['--input-type=module', '-e', `
    import { inspect } from 'node:util';
    const { evaluate } = await import('./lib/client.mjs');
    try { console.log(JSON.stringify({ ok: true, value: await evaluate(${JSON.stringify(value)}) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, error: inspect(error) })); }
  `], env));
}
async function endpoint(t, reply = (_body, res) => res.end(JSON.stringify(envelope))) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ body, url: req.url, method: req.method, headers: req.headers });
    res.setHeader('content-type', 'application/json'); reply(body, res, req);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, env: { TYPESAFE_API_URL: `http://127.0.0.1:${server.address().port}/typesafe/v1/systemone?fixture=transport-001` } };
}
test('evaluate preserves the complete envelope, native request, exact endpoint and credential selector', async t => {
  const { env, calls } = await endpoint(t);
  assert.deepEqual(await evaluate({ ...env, TYPESAFE_MODEL: 'env-model', TYPESAFE_API_KEY_ENV: 'CSH_AGENTIC_CODING_KEY', CSH_AGENTIC_CODING_KEY: secret, TYPESAFE_API_KEY: 'wrong-key' }), { ok: true, value: envelope });
  assert.deepEqual(calls[0].body, { ...request, model: 'env-model' });
  assert.equal(calls[0].url, '/typesafe/v1/systemone?fixture=transport-001');
  assert.equal(calls[0].method, 'POST'); assert.match(calls[0].headers['content-type'], /application\/json/);
  assert.equal(calls[0].headers.authorization, `Bearer ${secret}`);
  assert.equal((await evaluate({ ...env, TYPESAFE_MODEL: 'env-model' }, { ...request, model: 'request-model' })).ok, true);
  assert.equal(calls[1].body.model, 'request-model');
  assert.deepEqual(await evaluate({ TEST_DEFAULT_ENDPOINT: '1' }), { ok: true, value: envelope });
});
test('evaluate rejects malformed full responses, including defects outside the selected answer', async t => {
  const defects = {
    'invalid JSON': () => 'not-json-private-body',
    'missing model': e => { delete e.model; }, 'missing usage': e => { delete e.usage; },
    'invalid usage': e => { e.usage.input_tokens = -1; }, 'missing answer': e => { delete e.answers.score; },
    'wrong type': e => { e.answers.yes = e.answers.lane; },
    'string probability': e => { e.answers.yes.noul = '0.9'; }, 'out of range': e => { e.answers.yes.noul = 1.1; },
    'unknown choice': e => { e.answers.lane.choice = 'invented'; },
    'negative probability': e => { e.answers.lane.probabilities.deep = -0.1; },
    'invalid distribution': e => { e.answers.lane.probabilities.deep = 0.8; },
    'missing confidence': e => { delete e.answers.lane.confidence; },
    'invalid confidence': e => { e.answers.score.confidence = 2; },
    'missing legend': e => { delete e.answers.score.legend; }, 'invalid score': e => { e.answers.score.score = 99; },
    'null score': e => { e.answers.score.score = null; }, 'string score': e => { e.answers.score.score = '0.9'; },
  };
  for (const [name, mutate] of Object.entries(defects)) await t.test(name, async t => {
    const value = structuredClone(envelope); const raw = mutate(value) ?? JSON.stringify(value);
    const { env, calls } = await endpoint(t, (_body, res) => res.end(raw));
    const result = await evaluate(env); assert.equal(result.ok, false, name); assert.equal(calls.length, 1);
    assert.ok(!result.error.includes('not-json-private-body'));
  });
});
test('CSH credential aliases reject non-CSH destinations before fetch and allow the exact CSH URL through a local relay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-credential-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const selector of ['CSH_OPENAI_PULL_THROUGH_TOKEN', 'ASCII_AGENTIC_CODING_KEY']) await t.test(selector, async t => {
    const { env, calls } = await endpoint(t); const audit = join(dir, selector);
    const configured = { TYPESAFE_API_KEY_ENV: selector, [selector]: secret, TYPESAFE_API_KEY: 'wrong-key', TEST_AUDIT: audit };
    for (const url of [undefined, 'https://api.typesafe.ai/v1/systemone', 'https://llm.ascii.ac.at.evil.invalid/typesafe/v1/systemone', 'https://llm.ascii.ac.at:444/typesafe/v1/systemone']) await t.test(url ?? 'default endpoint', async () => {
      const result = await evaluate({ ...configured, ...(url ? { TYPESAFE_API_URL: url } : {}) });
      assert.equal(await readFile(audit, 'utf8'), '', 'credential host must be rejected before any fetch attempt');
      assert.equal(result.ok, false); assert.match(result.error, /CSH|endpoint/); assert.ok(!result.error.includes(secret)); assert.equal(calls.length, 0);
    });
    for (const url of [env.TYPESAFE_API_URL, 'https://llm.ascii.ac.at/typesafe/v1/systemone']) await t.test(url.startsWith('http:') ? 'loopback' : 'CSH HTTPS relayed locally', async () => {
      assert.deepEqual(await evaluate({ ...configured, TYPESAFE_API_URL: url, TEST_HTTP_RELAY: env.TYPESAFE_API_URL }), { ok: true, value: envelope });
      assert.equal(calls.at(-1).headers.authorization, `Bearer ${secret}`);
      assert.deepEqual(JSON.parse((await readFile(audit, 'utf8')).trim()), { url });
    });
  });
});
test('structured score criteria retain object-valued legends', async t => {
  const value = structuredClone(request), response = structuredClone(envelope);
  value.questions.score.criteria = [{ label: 'Low', rubric: { evidence: 'absent' } }, { label: 'High', rubric: { evidence: 'present' } }];
  response.answers.score.legend = Object.fromEntries(value.questions.score.criteria.map((level, i) => [i, level]));
  const { env, calls } = await endpoint(t, (_body, res) => res.end(JSON.stringify(response)));
  assert.deepEqual(await evaluate(env, value), { ok: true, value: response }); assert.deepEqual(calls[0].body.questions, value.questions);
});
test('rounded distributions and finite scores need not exactly match recomputed expectations', async t => {
  const value = { state: 'rounding-001', questions: {
    lane: { type: 'choice', instructions: 'Pick', criteria: { a: null, b: null, c: null } },
    score: { type: 'score', instructions: 'Rate', criteria: ['Low', 'Medium', 'High'] },
  } };
  const response = { ...envelope, answers: {
    lane: { type: 'choice', choice: 'a', probabilities: { a: 0.334, b: 0.334, c: 0.333 }, confidence: 0.01 },
    score: { type: 'score', score: 1.23, legend: { 0: 'Low', 1: 'Medium', 2: 'High' }, probabilities: { 0: 0.10, 1: 0.56, 2: 0.34 }, confidence: 0.3 },
  } };
  for (const id of ['lane', 'score']) await t.test(id, async t => {
    const input = { ...value, questions: { [id]: value.questions[id] } };
    const output = { ...response, answers: { [id]: response.answers[id] } };
    const { env, calls } = await endpoint(t, (_body, res) => res.end(JSON.stringify(output)));
    assert.deepEqual(await evaluate(env, input), { ok: true, value: output }); assert.equal(calls.length, 1);
  });
});
test('distribution sum tolerance scales by option count and caps at five percent', async t => {
  for (const [n, drift, accepted] of [[3, 0.014, true], [3, 0.016, false], [20, 0.049, true], [20, 0.051, false]]) for (const sign of [-1, 1]) await t.test(`${n} options / ${sign * drift}`, async t => {
    const keys = Array.from({ length: n }, (_, i) => `option_${i}`);
    const value = { state: 'tolerance-001', questions: { pick: { type: 'choice', instructions: 'Pick', criteria: Object.fromEntries(keys.map(key => [key, null])) } } };
    const response = { ...envelope, answers: { pick: { type: 'choice', choice: keys[0], confidence: 0.01, probabilities: Object.fromEntries(keys.map(key => [key, (1 + sign * drift) / n])) } } };
    const { env, calls } = await endpoint(t, (_body, res) => res.end(JSON.stringify(response)));
    const result = await evaluate(env, value); assert.equal(result.ok, accepted); assert.equal(calls.length, 1);
    if (accepted) assert.deepEqual(result.value, response);
  });
});
test('HTTP errors, redirects and network failures reject without exposing secrets or response bodies', async t => {
  for (const fault of ['401', '429', '500', 'redirect', 'disconnect']) await t.test(fault, async t => {
    let followed = 0;
    const target = await endpoint(t, (_body, res) => { followed++; res.end(JSON.stringify(envelope)); });
    const { env, calls } = await endpoint(t, (_body, res, req) => {
      if (fault === 'disconnect') return req.socket.destroy();
      res.statusCode = fault === 'redirect' ? 307 : Number(fault);
      if (fault === 'redirect') res.setHeader('location', target.env.TYPESAFE_API_URL);
      res.end(`private-response-body ${secret}`);
    });
    const result = await evaluate(env); assert.equal(result.ok, false); assert.ok(calls.length > 0);
    assert.ok(!result.error.includes(secret)); assert.ok(!result.error.includes('private-response-body'));
    assert.equal(followed, 0);
  });
});
test('configured and default timeouts bound real stalled HTTP responses', async t => {
  for (const ms of [80, 8000]) await t.test(`${ms}ms`, async t => {
    const { env, calls } = await endpoint(t, () => {});
    const start = performance.now();
    const result = await evaluate(ms === 8000 ? env : { ...env, TYPESAFE_TIMEOUT_MS: String(ms) });
    const elapsed = performance.now() - start;
    assert.equal(result.ok, false); assert.equal(calls.length, 1);
    assert.ok(elapsed >= ms * 0.8 && elapsed < ms + 2500, `elapsed ${elapsed}ms`);
  });
});
test('CLI retains answers-only output and supports native request files, stdin and --full', async t => {
  const { env, calls } = await endpoint(t, (body, res) => res.end(JSON.stringify({ ...envelope, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, envelope.answers[id] ?? envelope.answers.yes])) })));
  await t.test('legacy answers-only', async () => assert.deepEqual(json(await run(['bin/jev.mjs', 'Relevant?', '--state', 'text'], env)), { answer: envelope.answers.yes }));
  const dir = await mkdtemp(join(tmpdir(), 'jev-transport-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'request with spaces.json'); await writeFile(file, JSON.stringify(request));
  for (const source of ['-', file]) for (const full of [false, true]) await t.test(`${source === '-' ? 'stdin' : 'file'}/${full ? 'full' : 'answers'}`, async () => {
    const result = json(await run(['bin/jev.mjs', '--request', source, ...(full ? ['--full'] : [])], env, source === '-' ? JSON.stringify(request) : ''));
    assert.deepEqual(result, full ? envelope : envelope.answers);
    assert.deepEqual(calls.at(-1).body, { ...request, model: 'jev-latest' });
  });
});
test('MCP judge uses configured transport and retains answers-only text', async t => {
  const { env, calls } = await endpoint(t);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'judge', arguments: request } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const result = await run(['index.js'], env, input); assert.equal(result.code, 0, result.stderr);
  const response = result.stdout.trim().split('\n').map(line => JSON.parse(line)).find(value => value.id === 2);
  assert.ok(response?.result && !response.result.isError, result.stdout);
  assert.deepEqual(JSON.parse(response.result.content[0].text), envelope.answers);
  assert.deepEqual(calls[0].body, { ...request, model: 'jev-latest' });
});
