"""Repeatable live CSH checks. Uses synthetic inputs and a separate Hermes worker."""

import argparse
import json
import os
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    artifact = args.artifact.resolve()
    artifact.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HERMES_DISABLE_LAZY_INSTALLS": "1"}
    cases = {
        "route": {"task": "Reply with exactly JEV_WORKER_OK. Do not use tools or modify files.", "harness": "hermes"},
        "evaluate": {"task": "Check worker progress", "latest_output": "I cannot continue until the user provides the input file."},
        "skills": {"task": "Review a Python implementation", "candidates": [
            {"name": "dignified-python", "description": "Production Python implementation and review standards"},
            {"name": "paper-writing", "description": "Draft academic papers"}]},
        "triage": {"task": "Classify the failed request", "error": "HTTP 401 Unauthorized: invalid API key"},
    }
    report = {"checks": {}, "status": "failed"}
    try:
        for command, payload in cases.items():
            result = subprocess.run(
                ["hermes", "jev", command], input=json.dumps(payload), text=True,
                capture_output=True, check=True, env=env, cwd=root, timeout=30,
            )
            value = json.loads(result.stdout)
            assert value.get("model", "").startswith("jev-"), value
            assert "usage" in value, value
            report["checks"][command] = value
        prompt = artifact.parent / "worker-smoke-prompt.txt"
        prompt.write_text(cases["route"]["task"], encoding="utf-8")
        result = subprocess.run(
            ["hermes", "jev", "worker", "--harness", "hermes", "--cwd", str(artifact.parent),
             "--prompt-file", str(prompt)], text=True, capture_output=True,
            check=True, env=env, timeout=150,
        )
        assert "JEV_WORKER_OK" in result.stdout, result.stdout[:300]
        receipts = []
        for line in result.stderr.splitlines():
            if line.startswith("{"):
                value = json.loads(line)
                if value.get("kind") == "route":
                    receipts.append(value)
        assert receipts, "Worker route receipt missing"
        report["checks"]["worker"] = {"route": receipts[0], "output": result.stdout.strip(), "exit_code": result.returncode}
        result = subprocess.run(
            ["hermes", "jev", "watch", "--once", "--include-codex"], text=True,
            capture_output=True, check=True, env=env, timeout=60,
        )
        report["checks"]["watch"] = json.loads(result.stdout)
        assert not report["checks"]["watch"]["errors"], report["checks"]["watch"]
        report["status"] = "passed"
    except Exception as exc:
        report["error"] = type(exc).__name__
        raise
    finally:
        artifact.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "artifact": str(artifact)}))


if __name__ == "__main__":
    main()
