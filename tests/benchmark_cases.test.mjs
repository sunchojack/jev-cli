import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = JSON.parse(await readFile(new URL('./benchmark_cases.json', import.meta.url), 'utf8'));

test('benchmark cases use supported Jev workflows with explicit expected outputs', () => {
  assert.equal(cases.length, 15);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) {
    assert.ok(['route', 'skills', 'status', 'triage'].includes(item.kind), item.id);
    assert.equal(typeof item.task, 'string');
    assert.equal(typeof item.expected, 'string');
  }
});

test('routing gold labels span routine, standard and deep work', () => {
  assert.deepEqual(new Set(cases.filter(item => item.kind === 'route').map(item => item.expected)),
    new Set(['routine', 'standard', 'deep']));
});

test('skill cases constrain suggestions to supplied candidate names', () => {
  for (const item of cases.filter(item => item.kind === 'skills')) {
    assert.ok(item.candidates.some(candidate => candidate.name === item.expected), item.id);
  }
});

test('native failure is not benchmarked as an evaluator decision', () => {
  assert.ok(cases.every(item => item.kind !== 'status' || !['failed', 'blocked', 'interrupted', 'error'].includes(item.native_status)));
});
