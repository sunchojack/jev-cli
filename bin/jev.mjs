#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', 'typesafe-api-key', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('TypeSafe API key not found (set TYPESAFE_API_KEY or store it in Keychain as service typesafe-api-key)');
  }
}

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
    question.criteria = {};
    for (const opt of csv(args.criteria)) {
      const [name, ...rest] = opt.split('|');
      question.criteria[name.trim()] = rest.join('|').trim() || null;
    }
    if (!Object.keys(question.criteria).length) throw new Error('choice needs --criteria "opt|desc,opt2|desc"');
    return question;
  }
  if (type === 'score') {
    const levels = csv(args.criteria);
    if (levels.length < 2) throw new Error('score needs --criteria "level1,level2,..." (>=2)');
    question.criteria = levels;
    return question;
  }
  // noul
  if (args.criteria) {
    const c = csv(args.criteria);
    if (c.length >= 2) { question.criteria = { true: c[0], false: c[1] }; }
    else throw new Error('noul --criteria should be "yes-desc,no-desc"');
  }
  return question;
}

function parseArgs(argv) {
  const a = { question: null, state: '', type: 'noul', criteria: null, id: 'answer' };
  const read = (i) => { if (i >= argv.length) throw new Error('missing value'); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--state') a.state = read(++i);
    else if (k === '--type') a.type = read(++i);
    else if (k === '--criteria') a.criteria = read(++i);
    else if (k === '--id') a.id = read(++i);
    else if (k === '--file') a.state = readFileSync(read(++i), 'utf8');
    else if (!k.startsWith('-')) a.question = a.question ?? k;
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.question) throw new Error('usage: jev "<question>" [--state "str"|--file path] [--type noul|choice|score] [--criteria ...] [--id name]');
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

NOTES
  - criteria format differs by type (see examples).
  - Key from TYPESAFE_API_KEY env or macOS Keychain (service typesafe-api-key).
  - Threshold belongs in your code, not the model: treat noul >= 0.9 as yes.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  const args = parseArgs(argv);
  const question = buildQuestion(args.type, args);
  const body = { state: args.state, model: MODEL, questions: { [args.id]: question } };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(JSON.stringify(data.answers, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
