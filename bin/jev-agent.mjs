#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { JevError } from '../lib/client.mjs';
import { route, status, skills, triage, inventory, redact, reasoningValues } from '../lib/workflows.mjs';

const help = `jev-agent route|status|skills|triage|models < state.json
  State: task; optional latest_output, error, native_status.
  route also requires harness: hermes|codex.
  skills requires candidates: [{name, description}] (at most 100).
  Advisory results only; ready_for_review does not establish success.
  JEV_CONFIDENCE_THRESHOLD defaults to 0.75, an uncalibrated initial value.
  Task limit: 12000 characters; output/error: 4000 each. Oversize fails conservatively.

jev-agent worker --harness hermes|codex --cwd DIR --prompt-file FILE
  [--dry-run] [--read-only] [--model MODEL] [--provider PROVIDER] [--reasoning LEVEL]
  Model/provider pairs can come from a configured catalog. The built-in fallback is Luna/medium.
  Task pins require a complete directive line, such as --model gpt-6-astra.
  Ambiguous task model pins require --model. JEV_WORKER=1 prevents nested workers.
  Dry-run prints the plan with obvious credentials redacted.
  --read-only uses Codex sandbox read-only; Hermes read-only is unsupported and rejected.
  Transport: TYPESAFE_API_URL, TYPESAFE_API_KEY_ENV, TYPESAFE_MODEL, TYPESAFE_TIMEOUT_MS.`;

function workerOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(options, flag)) throw new JevError('Duplicate worker option');
    if (['--dry-run', '--read-only'].includes(flag)) options[flag] = true;
    else if (['--harness', '--cwd', '--prompt-file', '--model', '--provider', '--reasoning'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flag] = argv[++i];
    else throw new JevError('Invalid worker option');
  }
  if (!['hermes', 'codex'].includes(options['--harness']) || !options['--cwd'] || !options['--prompt-file']) throw new JevError('Worker needs --harness, --cwd and --prompt-file');
  if (options['--harness'] === 'hermes' && options['--read-only']) throw new JevError('Hermes --read-only is unsupported: the file toolset includes write_file and patch; no verified read-only tool option is available');
  if (options['--reasoning'] && !reasoningValues.includes(options['--reasoning'])) throw new JevError('Invalid reasoning value');
  return options;
}

async function worker(argv) {
  if (process.env.JEV_WORKER === '1') throw new JevError('Nested Jev workers are disabled');
  const options = workerOptions(argv);
  const cwd = resolve(options['--cwd']);
  let task;
  try {
    const promptStat = statSync(options['--prompt-file']);
    if (!statSync(cwd).isDirectory() || !promptStat.isFile() || promptStat.size > 65536) throw new Error();
    task = readFileSync(options['--prompt-file'], 'utf8');
  } catch { throw new JevError('Cannot read worker prompt or working directory'); }
  if (!task.trim() || task.includes('\0')) throw new JevError('Invalid worker prompt');
  const harness = options['--harness'];
  const receipt = await route({ task, harness, model: options['--model'], provider: options['--provider'], reasoning: options['--reasoning'] });
  if (receipt.requires_model) throw new JevError('Ambiguous task model pin; specify --model explicitly');
  const { model, provider, reasoning } = receipt.route;
  const args = harness === 'hermes'
    ? ['--cli', '-m', model, '--provider', provider, ...(reasoning === 'inherit' ? [] : ['--reasoning', reasoning]), 'chat', '-Q', '-q', task]
    : ['exec', '-m', model, '-c', `model_provider=${JSON.stringify(provider)}`,
        ...(reasoning === 'inherit' ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`]),
        ...(options['--read-only'] ? ['-s', 'read-only'] : []), '--', task];
  if (options['--dry-run']) { console.log(JSON.stringify({ route: receipt, command: harness, args: args.map(arg => redact(arg)), cwd: redact(cwd) })); return; }
  console.error(JSON.stringify(receipt));
  await new Promise((resolveChild, reject) => {
    let failed = false;
    const child = spawn(harness, args, { cwd, shell: false, stdio: 'inherit', env: { ...process.env, JEV_WORKER: '1' } });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', () => { failed = true; cleanup(); reject(new JevError('Worker could not start')); });
    child.once('close', (code, signal) => {
      cleanup();
      if (!failed) process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
      resolveChild();
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (['--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'worker') return worker(args);
  const workflow = { route, status, skills, triage, models: input => inventory(input.harness) };
  if (!Object.hasOwn(workflow, command) || args.length) throw new JevError('Use jev-agent --help for usage');
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 131072) throw new JevError('Workflow input too large');
  }
  let input;
  try { input = JSON.parse(text); } catch { throw new JevError('Invalid workflow JSON'); }
  console.log(JSON.stringify(await workflow[command](input)));
}

main().catch(error => { console.error(error instanceof JevError ? error.message : 'Jev agent failed'); process.exitCode = 1; });
