"""Test-first CLI integration with isolated profiles and a loopback Jev fixture.

Faults: models is absent; catalogs never reach Node; uncertainty selects Astra;
profile B contaminates A; a pin guesses providers; an invalid catalog launches;
dry-run starts a worker; discovery leaks keys or advertises incompatible Codex
providers; prose pins bypass catalog membership; irrelevant skills cost a call.
No active profile, service, provider configuration or existing worker is changed.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-root', type=Path, required=True)
    parser.add_argument('--artifact', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    args.artifact.parent.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'requests': [], 'status': 'failed'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            report['requests'].append(body)
            answers = {}
            for key, question in body['questions'].items():
                choices = list(question['criteria'])
                selected = choices[-1]
                answers[key] = {'type': 'choice', 'choice': selected, 'confidence': 0.3,
                                'probabilities': {c: float(c == selected) for c in choices}}
            response = json.dumps({'model': 'jev-fixture', 'usage': {'input_tokens': 40, 'output_tokens': 8},
                                   'answers': answers}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='routing-', dir=args.artifact.parent) as directory:
            scratch = Path(directory)
            endpoint = f'http://127.0.0.1:{server.server_port}/systemone'
            node = Path(shutil.which('node')).resolve()
            bins = scratch / 'bin'
            bins.mkdir()
            capture = scratch / 'worker.json'
            fake = bins / 'hermes'
            fake.write_text(f'#!{sys.executable}\nimport json,os,sys\n'
                            'from pathlib import Path\n'
                            f'Path({str(capture)!r}).write_text(json.dumps({{"args":sys.argv[1:],"profile":os.environ.get("HERMES_HOME")}}))\n'
                            'print("WORKER_OK")\n', encoding='utf-8')
            fake.chmod(0o755)
            homes = {}
            configs = {}
            for name in ['A', 'B']:
                home = scratch / name
                (home / 'plugins').mkdir(parents=True)
                (home / 'plugins' / 'jev').symlink_to(root / 'plugins/jev')
                roster = home / 'plugins/routing-roster'
                roster.mkdir()
                (roster / 'plugin.yaml').write_text('name: routing-roster\nversion: 1.0.0\n', encoding='utf-8')
                names = [f'zygoforge-{i}' for i in range(7)] + ['pottery']
                registrations = ['from pathlib import Path', 'def register(ctx):']
                for skill_name in names:
                    skill = roster / f'{skill_name}.md'
                    description = 'Zygoforge compiler work' if skill_name.startswith('zygoforge') else 'Pottery kiln management'
                    skill.write_text(f'---\nname: {skill_name}\ndescription: {description}\n---\nFixture.\n', encoding='utf-8')
                    registrations.append(f'    ctx.register_skill({skill_name!r}, Path(__file__).parent / {skill.name!r}, description={description!r})')
                (roster / '__init__.py').write_text('\n'.join(registrations) + '\n', encoding='utf-8')
                providers = {'pool': {'api': endpoint, 'models': {
                    'subscription-gpt-6-luna': {'description': 'Bounded work with required checks.'},
                    'subscription-gpt-6-astra': {'description': 'Complex cross-module research.'}}}}
                config = {'model': {'provider': 'pool', 'default': 'subscription-gpt-6-astra'},
                          'providers': providers, 'plugins': {'enabled': ['jev', 'routing-roster'], 'entries': {'jev': {'settings': {
                              'endpoint': endpoint, 'node_path': str(node), 'timeout_ms': 2000, 'max_skills': 60}}}}}
                if name == 'B':
                    config['plugins']['entries']['jev']['settings']['routes'] = {'hermes': [
                        {'id': 'operator', 'model': 'Local/Small', 'provider': 'Local.Pool', 'reasoning': 'inherit',
                         'description': 'Explicit operator fallback.', 'fallback': True}]}
                (home / 'config.yaml').write_text(json.dumps(config), encoding='utf-8')
                codex = home / 'codex'
                codex.mkdir()
                (codex / 'config.toml').write_text('[model_providers.compatible]\nwire_api="responses"\n'
                                                  f'base_url="{endpoint}/"\n'
                                                  '[model_providers.incompatible]\nwire_api="chat"\n'
                                                  f'base_url="{endpoint}"\n', encoding='utf-8')
                config['providers']['response-pool'] = {'transport': 'codex_responses', 'api': endpoint,
                                                        'models': ['gpt-6-luna', {'id': 'gpt-6-sol'}]}
                (home / 'config.yaml').write_text(json.dumps(config), encoding='utf-8')
                (home / '.env').write_text(f'CSH_AGENTIC_CODING_KEY=fixture-key-{name}\nCODEX_HOME={codex}\n', encoding='utf-8')
                homes[name], configs[name] = home, config

            def cli(name, *command, payload=None, ok=True):
                clean = {k: v for k, v in os.environ.items() if not k.startswith(('HERMES_', 'TYPESAFE_', 'JEV_'))
                         and k not in {'CSH_AGENTIC_CODING_KEY', 'CSH_OPENAI_PULL_THROUGH_TOKEN'}}
                clean.update(HERMES_HOME=str(homes[name]), HERMES_BUNDLED_PLUGINS=str(scratch / 'bundled'),
                             HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1',
                             PYTHONPATH=str(args.hermes_root), PATH=f'{bins}:{node.parent}:/usr/bin:/bin')
                result = subprocess.run([sys.executable, '-c', 'from hermes_cli.main import main; main()',
                                         'jev', *command], input=json.dumps(payload) if payload is not None else '',
                                        text=True, capture_output=True, env=clean, cwd=scratch, timeout=30)
                assert (result.returncode == 0) == ok, (command, result.returncode, result.stdout[-1000:], result.stderr[-1500:])
                assert 'fixture-key-' not in result.stdout + result.stderr
                return result

            def check(name):
                report['checks'].append(name)

            for name in ['A', 'B', 'A']:
                inventory = json.loads(cli(name, 'models').stdout)
                entries = inventory['catalogs']['hermes']
                assert entries and sum(e.get('fallback') is True for e in entries) == 1
                assert next(e for e in entries if e.get('fallback'))['model'] == (
                    'Local/Small' if name == 'B' else 'subscription-gpt-6-luna')
                codex = inventory['catalogs']['codex']
                assert {e['provider'] for e in codex} == {'compatible'}
                assert {e['model'] for e in codex} == {'gpt-6-luna', 'gpt-6-sol'}
                assert next(e for e in codex if e.get('fallback'))['model'] == 'gpt-6-luna'
            assert not report['requests']
            check('local inventory and A-B-A isolation')
            for harness, model in [('hermes', 'subscription-gpt-6-luna'), ('codex', 'gpt-6-luna')]:
                result = subprocess.run([str(node), str(root / 'bin/jev-agent.mjs'), 'route'],
                                        input=json.dumps({'harness': harness, 'model': model,
                                                          'provider': 'operator-pool', 'reasoning': 'low'}),
                                        env={'PATH': str(node.parent)}, text=True, capture_output=True,
                                        check=True, timeout=10)
                receipt = json.loads(result.stdout)
                assert receipt['pinned'] is True and receipt['route']['provider'] == 'operator-pool'
            check('standalone known-model pin preserves an explicit provider')
            cli('A', 'skills', payload={'task': 'Zygoforge compiler work'})
            candidates = report['requests'][-1]['state']['candidates']
            assert len(candidates) == 5 and all('zygoforge-' in c['name'] for c in candidates)
            check('native roster caps relevant candidates at five despite a configured sixty')
            for name, model in [('A', 'subscription-gpt-6-luna'), ('B', 'Local/Small')]:
                receipt = json.loads(cli(name, 'route', payload={'task': 'Bounded implementation', 'harness': 'hermes'}).stdout)
                assert receipt['fallback'] is True and receipt['route']['model'] == model
            check('configured catalogs and low-confidence fallback reach real Node')
            prompt = scratch / 'prompt.txt'
            prompt.write_text('Produce the bounded result; no publication.', encoding='utf-8')
            flags = ('worker', '--harness', 'hermes', '--cwd', str(scratch), '--prompt-file', str(prompt))
            plan = json.loads(cli('A', *flags, '--dry-run').stdout)
            assert plan['route']['route']['model'] == 'subscription-gpt-6-luna' and not capture.exists()
            assert 'WORKER_OK' in cli('A', *flags).stdout
            worker = json.loads(capture.read_text(encoding='utf-8'))
            assert worker['profile'] == str(homes['A']) and 'subscription-gpt-6-luna' in worker['args']
            check('dry-run and launched worker preserve isolated profile')
            before = len(report['requests'])
            plan = json.loads(cli('A', *flags, '--model', 'subscription-gpt-6-astra', '--reasoning', 'low', '--dry-run').stdout)
            assert plan['route']['pinned'] is True and plan['route']['route']['provider'] == 'pool'
            assert plan['route']['route']['reasoning'] == 'low' and len(report['requests']) == before
            check('explicit pin bypasses evaluator and preserves provider/reasoning')
            prompt.write_text('--model subscription-gpt-6-astra', encoding='utf-8')
            cli('B', *flags, '--dry-run', ok=False)
            cli('B', 'route', payload={'task': prompt.read_text(), 'harness': 'hermes'}, ok=False)
            assert len(report['requests']) == before
            check('task-line pin outside catalog refuses without a decision or launch')
            prompt.write_text('Produce the bounded result; no publication.', encoding='utf-8')
            (homes['B'] / 'codex/config.toml').write_text('broken [', encoding='utf-8')
            plan = json.loads(cli('B', *flags, '--model', 'Local/Small', '--dry-run').stdout)
            assert plan['route']['route']['model'] == 'Local/Small'
            plan = json.loads(cli('A', *flags, '--model', 'subscription-gpt-6-luna', '--dry-run').stdout)
            assert plan['route']['route']['reasoning'] == 'medium'
            assert len(report['requests']) == before
            check('unrelated broken Codex config cannot block Hermes; bounded reasoning defaults')
            configs['B']['plugins']['entries']['jev']['settings']['routes']['hermes'][0]['fallback'] = False
            (homes['B'] / 'config.yaml').write_text(json.dumps(configs['B']), encoding='utf-8')
            cli('B', *flags, '--dry-run', ok=False)
            assert len(report['requests']) == before
            check('invalid explicit catalog fails before evaluation or launch')
            assert all('fixture-key-' not in json.dumps(r) for r in report['requests'])
        report['status'] = 'passed'
    except Exception as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        args.artifact.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'artifact': str(args.artifact)}))


if __name__ == '__main__':
    main()
