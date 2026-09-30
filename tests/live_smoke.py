"""Live CSH E2E in a temporary profile; never observe or modify active sessions.

Faults: candidate plugin not loaded; uncertainty launches Astra; worker output
fails bounded checks; evaluator provenance missing; live profile or keys leak.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from dotenv import dotenv_values


TASK = ('Implement function parseYear(value) in plain JavaScript. Return null for null, undefined '
        'or a blank string. Accept a number only if it is a safe integer in 1900..2100 inclusive. '
        'Accept a trimmed string only if it consists of exactly four ASCII digits and its numeric '
        'year is in that interval. Reject every other value by throwing an Error. Do not coerce '
        'booleans, arrays or objects. Do not use partial parsing or mutate input. '
        'Return only function code, no imports, exports, Markdown or prose. Do not use tools.')
CHECKS = r'''
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8') + '\nthis.fn=parseYear;', context, {timeout:1000});
const call = value => { context.value=value; return vm.runInContext('fn(value)', context, {timeout:1000}); };
for (const [value,want] of [[null,null],[undefined,null],[' \t',null],[1900,1900],[2100,2100],[' 2021 ',2021]]) assert.equal(call(value),want);
for (const value of [true,false,[],{},2021.5,NaN,Infinity,1899,2101,'2021x','20.21','20210','+2021','２０２１','1e3']) assert.throws(()=>call(value));
console.log(JSON.stringify({passed:true,valid:6,rejected:16}));
'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--source-profile", type=Path, required=True, help="Read-only provider configuration and scoped key source")
    parser.add_argument('--hermes-root', type=Path, default=Path('/home/arsenev/.hermes/hermes-agent'))
    args = parser.parse_args()
    sys.path.insert(0, str(args.hermes_root.resolve()))
    import hermes_yaml as yaml
    root = Path(__file__).resolve().parents[1]
    artifact = args.artifact.resolve()
    artifact.parent.mkdir(parents=True, exist_ok=True)
    cases = {
        "route": {"task": TASK, "harness": "hermes"},
        "evaluate": {"task": "Check worker progress", "latest_output": "I cannot continue until the user provides the input file."},
        "skills": {"task": "Review a Python implementation", "candidates": [
            {"name": "dignified-python", "description": "Production Python implementation and review standards"},
            {"name": "paper-writing", "description": "Draft academic papers"}]},
        "triage": {"task": "Classify the failed request", "error": "HTTP 401 Unauthorized: invalid API key"},
    }
    report = {"checks": {}, "status": "failed"}
    temporary = tempfile.TemporaryDirectory(prefix="jev-live-", dir=artifact.parent)
    try:
        home = Path(temporary.name)
        source = args.source_profile.resolve()
        config_bytes = (source / 'config.yaml').read_bytes()
        source_config = yaml.safe_load(config_bytes)
        provider = source_config['providers']['csh-subscriptions']
        assert provider.get('key_env') == 'CSH_AGENTIC_CODING_KEY'
        key = os.environ.get('CSH_AGENTIC_CODING_KEY') or dotenv_values(source / '.env').get('CSH_AGENTIC_CODING_KEY')
        assert key and '\n' not in key and '\r' not in key, 'Scoped worker key unavailable'
        (home / 'plugins').mkdir()
        (home / 'plugins/jev').symlink_to(root / 'plugins/jev')
        (home / 'codex').mkdir()
        (home / 'bin').mkdir()
        wrapper = home / 'bin/hermes'
        wrapper.write_text(f'#!{sys.executable}\nimport sys\nsys.path.insert(0, {str(args.hermes_root.resolve())!r})\n'
                           'from hermes_cli.main import main\nmain()\n', encoding='utf-8')
        wrapper.chmod(0o755)
        config = {'model': {'provider': 'csh-subscriptions', 'default': 'subscription-gpt-6-luna'},
                  'providers': {'csh-subscriptions': {k: v for k, v in provider.items() if k in {
                      'name', 'api', 'transport', 'default_model', 'discover_models', 'models', 'key_env'}}},
                  'platform_toolsets': {'cli': []}, 'agent': {'disabled_toolsets': ['all'], 'max_turns': 2},
                  'plugins': {'enabled': ['jev'], 'entries': {'jev': {'settings': {'timeout_ms': 12000, 'max_skills': 0}}}}}
        (home / 'config.yaml').write_text(json.dumps(config), encoding='utf-8')
        secret_file = home / '.env'
        secret_file.touch(mode=0o600)
        secret_file.write_text(f'CSH_AGENTIC_CODING_KEY={key}\nCODEX_HOME={home / "codex"}\n', encoding='utf-8')
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HERMES_', 'JEV_', 'TYPESAFE_'))
               and not any(s in k.upper() for s in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD'))
               and k != 'CODEX_HOME'}
        env.update(HERMES_HOME=str(home), HERMES_BUNDLED_PLUGINS=str(home / 'bundled'),
                   HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1', PATH=f'{home / "bin"}:{os.environ["PATH"]}')
        report['isolation'] = {'temporary_profile': True, 'candidate_plugin': str(root / 'plugins/jev'),
                               'codex_observation': False, 'worker_tools': []}
        inventory = subprocess.run(['hermes', 'jev', 'models'], capture_output=True, text=True,
                                   check=True, env=env, cwd=home, timeout=30)
        models = json.loads(inventory.stdout)
        assert next(e for e in models['catalogs']['hermes'] if e.get('fallback'))['model'] == 'subscription-gpt-6-luna'
        report['checks']['models'] = models
        for command, payload in cases.items():
            result = subprocess.run(
                ["hermes", "jev", command], input=json.dumps(payload), text=True,
                capture_output=True, check=True, env=env, cwd=home, timeout=30,
            )
            value = json.loads(result.stdout)
            assert value.get("model", "").startswith("jev-"), value
            assert "usage" in value, value
            report["checks"][command] = value
        verifier = artifact.parent / 'worker-checks.mjs'
        verifier.write_text(CHECKS, encoding='utf-8')
        prompt = artifact.parent / "worker-smoke-prompt.txt"
        prompt.write_text(cases["route"]["task"], encoding="utf-8")
        result = subprocess.run(
            ["hermes", "jev", "worker", "--harness", "hermes", "--cwd", str(artifact.parent),
             "--prompt-file", str(prompt)], text=True, capture_output=True,
            check=True, env=env, timeout=150,
        )
        assert key not in result.stdout + result.stderr, 'Credential escaped'
        code = result.stdout.strip()
        code_file = artifact.parent / 'worker-output.js'
        code_file.write_text(code, encoding='utf-8')
        checked = subprocess.run(['node', str(verifier), str(code_file)], text=True,
                                 capture_output=True, check=True, cwd=home, env=env, timeout=10)
        receipts = []
        for line in result.stderr.splitlines():
            if line.startswith("{"):
                value = json.loads(line)
                if value.get("kind") == "route":
                    receipts.append(value)
        assert receipts, "Worker route receipt missing"
        if receipts[0].get('fallback'):
            assert receipts[0]['route']['model'] == 'subscription-gpt-6-luna'
        report["checks"]["worker"] = {"route": receipts[0], "output": code, "checks": json.loads(checked.stdout), "exit_code": result.returncode}
        result = subprocess.run(
            ["hermes", "jev", "watch", "--once"], text=True,
            capture_output=True, check=True, env=env, timeout=60,
        )
        report["checks"]["watch"] = json.loads(result.stdout)
        assert not report["checks"]["watch"]["errors"], report["checks"]["watch"]
        assert (source / 'config.yaml').read_bytes() == config_bytes, 'Source profile changed'
        report["status"] = "passed"
    except Exception as exc:
        report["error"] = type(exc).__name__
        if isinstance(exc, subprocess.CalledProcessError):
            report['stderr'] = (exc.stderr or '')[-3000:].replace(key, '[redacted]')
            print(report['stderr'])
        raise
    finally:
        temporary.cleanup()
        artifact.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "artifact": str(artifact)}))


if __name__ == "__main__":
    main()
