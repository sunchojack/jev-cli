#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate, JevError } from '../lib/client.mjs';

function csv(s) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function buildQuestion(type, args) {
  const question = { type, instructions: args.question };
  if (type === 'choice') {
    question.criteria = Object.create(null);
    for (const opt of csv(args.criteria)) {
      const [name, ...rest] = opt.split('|');
      question.criteria[name.trim()] = rest.join('|').trim() || null;
    }
    if (!Object.keys(question.criteria).length) throw new JevError('choice needs --criteria "opt|desc,opt2|desc"');
    return question;
  }
  if (type === 'score') {
    const levels = csv(args.criteria);
    if (levels.length < 2) throw new JevError('score needs --criteria "level1,level2,..." (>=2)');
    question.criteria = levels;
    return question;
  }
  // noul
  if (args.criteria) {
    const c = csv(args.criteria);
    if (c.length >= 2) { question.criteria = { true: c[0], false: c[1] }; }
    else throw new JevError('noul --criteria should be "yes-desc,no-desc"');
  }
  return question;
}

function parseArgs(argv) {
  const a = { question: null, state: '', type: 'noul', criteria: null, id: 'answer' };
  const read = (i) => { if (i >= argv.length) throw new JevError('missing value'); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--request') a.request = read(++i);
    else if (k === '--full') a.full = true;
    else if (k === '--state') a.state = read(++i);
    else if (k === '--type') a.type = read(++i);
    else if (k === '--criteria') a.criteria = read(++i);
    else if (k === '--id') a.id = read(++i);
    else if (k === '--file') a.state = readFileSync(read(++i), 'utf8');
    else if (!k.startsWith('-')) a.question = a.question ?? k;
    else throw new JevError('unknown option; use --help');
  }
  if (a.request && (a.question || argv.some(k => ['--state', '--file', '--type', '--criteria', '--id'].includes(k)))) throw new JevError('--request cannot be combined with legacy question options');
  if (!a.question && !a.request) throw new JevError('usage: jev "<question>" [options] or jev --request FILE|- [--full]');
  return a;
}

const help = `jev — ask Jev for a judgment (probability distribution)

EXAMPLES
  jev "Is this a Python import line?" --state "import pandas as pd"
  jev "Which team handles this?" --type choice --state "payouts failing" \\
      --criteria "billing|payments,technical|outages,sales|pricing"
  jev "How frustrated is the customer?" --type score --state "payouts failing" \\
      --criteria "Calm,Frustrated,Very angry"
  jev "Is this handoff multi-file?" --file AGENT_HANDOFF.md
  jev --request request.json --full
  jev --request - < request.json

NOTES
  - criteria format differs by type (see examples).
  - --request accepts native {state, questions, model?}; --full retains model and usage.
  - TYPESAFE_API_URL defaults to https://api.typesafe.ai/v1/systemone.
  - TYPESAFE_API_KEY_ENV selects a credential env var (default TYPESAFE_API_KEY).
  - Legacy credential fallback: macOS Keychain service typesafe-api-key.
  - TYPESAFE_MODEL defaults to jev-latest; request model takes precedence.
  - TYPESAFE_TIMEOUT_MS defaults to 8000 (maximum 120000); redirects are rejected.
  - Threshold belongs in your code, not the model: treat noul >= 0.9 as yes.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  const args = parseArgs(argv);
  let body;
  if (args.request) {
    try { body = JSON.parse(readFileSync(args.request === '-' ? 0 : args.request, 'utf8')); }
    catch { throw new JevError('Cannot read native JSON request'); }
  } else {
    if (args.type !== 'noul' && !args.criteria) throw new JevError('choice and score need --criteria');
    body = { state: args.state, questions: { [args.id]: buildQuestion(args.type, args) } };
  }
  const data = await evaluate(body, { keychain: true });
  console.log(JSON.stringify(args.full ? data : data.answers, null, 2));
}

main().catch((e) => { console.error(e instanceof JevError ? e.message : 'Jev input or request failed'); process.exitCode = 1; });
