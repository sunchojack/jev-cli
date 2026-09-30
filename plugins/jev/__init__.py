"""Native Hermes observers. Node owns judgments and explicit worker launches."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
import tomllib
import uuid
from contextlib import contextmanager
from pathlib import Path

import hermes_yaml as yaml

from agent.secret_scope import get_secret, is_multiplex_active
from hermes_constants import get_hermes_home, get_hermes_home_override
from hermes_platform.resolver import locate_command
from hermes_platform.resolver.known_dirs import homebrew_dirs, node_tool_dirs
from tools.environments.local import served_profile_child_env

DEFAULTS = {
    "enabled": True, "endpoint": "https://llm.ascii.ac.at/typesafe/v1/systemone",
    "key_env": "CSH_AGENTIC_CODING_KEY", "timeout_ms": 5000, "threshold": 0.75,
    "max_skills": 5, "cli_path": "", "node_path": "node", "routes": None,
}
STATUSES = {"working", "waiting_for_input", "blocked", "ready_for_review", "unclear"}
CATEGORIES = {"authentication", "quota", "dependency", "code_defect",
              "missing_verification", "user_decision", "none", "unclear"}
WORKFLOWS = {"research-guardian", "solemn-vigil", "scoop-evidence", "freeze-clues",
             "forge-changes", "hunt-faults", "seal-records", "reconcile-oracle-ledgers"}
UNAVAILABLE_REASONS = {"network_error", "timeout", "http_error", "invalid_response"}
NATIVE_FAILURES = {"failed", "blocked", "interrupted", "error", "timeout", "timed_out", "crashed", "cancelled"}
NATIVE_REASONS = {
    "auth", "auth_permanent", "billing", "rate_limit", "upstream_rate_limit", "upstream_blocked",
    "overloaded", "server_error", "timeout", "ssl_cert_verification", "context_overflow",
    "payload_too_large", "image_too_large", "image_corrupt", "model_not_found", "provider_policy_blocked",
    "content_policy_blocked", "model_entitlement", "incomplete_response", "format_error", "role_alternation",
    "invalid_encrypted_content", "multimodal_tool_content_unsupported", "reasoning_mandatory",
    "thinking_signature", "long_context_tier", "oauth_long_context_beta_forbidden", "llama_cpp_grammar_pattern", "unknown",
}
CORRELATION_IDS = ("turn_id", "parent_turn_id", "tool_call_id", "api_request_id")
HERMES_KEY = "CSH_AGENTIC_CODING_KEY"
CODEX_KEY = "CSH_OPENAI_PULL_THROUGH_TOKEN"
HELP = ("Jev: hermes jev models | status | watch --once | watch --interval 60 | route | skills | triage | evaluate. "
        "Decisions read JSON stdin. Only hermes jev worker --harness hermes|codex "
        "--cwd DIR --prompt-file FILE [--dry-run] [--read-only] launches a worker. "
        "Native outcomes are authoritative; Jev advice is optional. "
        "Running sessions are not auto-adopted; stock delegate_task is not routed.")


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def active_home() -> Path:
    if is_multiplex_active() and not get_hermes_home_override():
        raise RuntimeError("No active profile scope")
    return get_hermes_home().resolve()


def label(value: object, limit: int = 120) -> str:
    return re.sub(r"[^a-zA-Z0-9_./:@+-]", "_", value[:limit]) if isinstance(value, str) else ""


def excerpt(value: object, cfg: dict, limit: int = 1000) -> str:
    if not isinstance(value, str):
        return ""
    text = value
    for name in (cfg["key_env"], HERMES_KEY, CODEX_KEY):
        key = get_secret(name)
        if key:
            text = text.replace(key, "[redacted]")
    text = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+",
                  r"\1[redacted]", text)
    return text[:limit]


def review_excerpt(value: object, cfg: dict, paths: list, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    # Keep prose evidence, never read source files or forward code blocks.
    text = excerpt(value, cfg, 16000)
    text = re.sub(r"(?ms)^\s*(?:```|~~~).*?(?:^\s*(?:```|~~~)[^\n]*(?:\n|$)|\Z)",
                  "[code omitted]\n", text)
    text = re.sub(r"(?m)^(?: {4}|\t).*$", "[code omitted]", text)
    for path in sorted((p for p in paths if isinstance(p, str) and p), key=len, reverse=True):
        text = text.replace(path, "[path]")
    text = re.sub(r"[`\"'][^`\"'\n]*[/\\][^`\"'\n]*[`\"']", "[path]", text)
    text = re.sub(r"(?<!\w)(?:[A-Za-z]:)?(?:[~.]?[/\\])?[^\s`\"'<>()[\]{}]*[/\\][^\s`\"'<>()[\]{}]*",
                  "[path]", text)
    text = re.sub(r"(?<![\w.])[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?", "[path]", text)
    return excerpt(text, cfg, limit)


def lexical_terms(text: str) -> set[str]:
    return set(re.findall(r"[^\W_]+", text.casefold())) - {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
        "it", "of", "on", "or", "that", "the", "this", "to", "use", "with", "you",
    }


@contextmanager
def database(home: Path):
    directory = home / "state" / "jev"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(directory / "events.sqlite3", timeout=2)
    try:
        db.execute("BEGIN IMMEDIATE")
        # Logical retention replaces the old page cap, which could prevent pruning.
        db.execute("PRAGMA max_page_count=2147483646")
        db.execute("CREATE TABLE IF NOT EXISTS events "
                   "(id TEXT PRIMARY KEY, at REAL, pid INTEGER, kind TEXT, data TEXT)")
        db.execute("CREATE TABLE IF NOT EXISTS guards (id TEXT PRIMARY KEY, at REAL)")
        with db:
            yield db
    finally:
        db.close()


def record(home: Path, kind: str, event: dict, result: dict) -> None:
    # No free-text prompts, summaries, provider error bodies, or tool output on disk.
    data = {"session_id": label(event.get("session_id") or event.get("child_session_id") or event.get("task_id")),
            "parent_session_id": label(event.get("parent_session_id")),
            "turn_id": label(event.get("turn_id") or event.get("parent_turn_id")),
            "tool_call_id": label(event.get("tool_call_id")), "api_request_id": label(event.get("api_request_id")),
            "model": label(event.get("model")), **result}
    source = event.get("source")
    data.pop("source", None)
    if isinstance(source, str) and source in {"hermes", "codex_snapshot"}:
        data["source"] = source
    encoded = json.dumps(data, separators=(",", ":"))
    if len(encoded) > 4096:  # ensure_ascii=True makes characters equal UTF-8 bytes.
        data["metadata_truncated"] = True
        for key in sorted(result, key=lambda k: len(json.dumps(result[k])), reverse=True):
            data.pop(key, None)
            encoded = json.dumps(data, separators=(",", ":"))
            if len(encoded) <= 4096:
                break
    identity = str(uuid.uuid4())
    with database(home) as db:
        # Reserve one event and its bytes before writing, including legacy oversized rows.
        db.execute("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM "
                   "(SELECT rowid, row_number() OVER (ORDER BY at DESC, rowid DESC) AS n, "
                   "sum(length(CAST(data AS BLOB))) OVER (ORDER BY at DESC, rowid DESC) AS bytes "
                   "FROM events WHERE length(CAST(data AS BLOB)) <= 4096) "
                   "WHERE n < 999 AND bytes <= ?)", (2_000_000 - len(encoded),))
        db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)",
                   (identity, time.time(), os.getpid(), kind, encoded))


def claim(home: Path, command: str, identity: str, *, ttl: int = 300) -> bool:
    now = time.time()
    with database(home) as db:
        rows = dict(db.execute("SELECT id, at FROM guards WHERE id IN (?,?,?)",
                              (identity, "rate:" + command, "cool:" + command)))
        if identity in rows and now - rows[identity] < ttl:
            return False
        if now < rows.get("cool:" + command, 0) or now - rows.get("rate:" + command, 0) < 5:
            return False
        db.executemany("INSERT OR REPLACE INTO guards VALUES (?,?)",
                       [(identity, now), ("rate:" + command, now)])
        db.execute("DELETE FROM guards WHERE id NOT IN "
                   "(SELECT id FROM guards ORDER BY at DESC LIMIT 512)")
    return True


def summary(home: Path) -> dict:
    with database(home) as db:
        rows = db.execute("SELECT id, at, pid, kind, data FROM events ORDER BY at DESC LIMIT 20").fetchall()
        counts = dict(db.execute("SELECT kind, count(*) FROM events GROUP BY kind"))
    events = [dict(id=i, at=t, pid=p, kind=k, **json.loads(d)) for i, t, p, k, d in rows]
    return {"kind": "local_status", "counts": counts, "events": events,
            "authority": "Only native outcomes establish completion, failure, or interruption. "
                         "Later activity does not establish recovery from an earlier failure."}


def compact(result: dict) -> dict:
    out = {k: result[k] for k in ("fallback", "needs_attention") if type(result.get(k)) is bool}
    reason = result.get("reason")
    if isinstance(reason, str) and reason in UNAVAILABLE_REASONS | {
        "low_confidence", "invalid_input", "credential_error", "configuration_error", "ambiguous_model_pin",
    }:
        out["reason"] = reason
    for key, values in (("status", STATUSES), ("category", CATEGORIES)):
        if isinstance(result.get(key), str) and result[key] in values:
            out["predicted_" + key] = result[key]
    confidence = result.get("confidence")
    if type(confidence) in (int, float) and math.isfinite(confidence) and 0 <= confidence <= 1:
        out["confidence"] = confidence
    probabilities = result.get("probabilities")
    if isinstance(probabilities, dict):
        valid = [(k, v) for k, v in probabilities.items() if isinstance(k, str)
                 and re.fullmatch(r"[\w:./-]{1,100}", k) and type(v) in (int, float)
                 and math.isfinite(v) and 0 <= v <= 1]
        out["probabilities"] = dict(sorted(valid, key=lambda item: (-item[1], item[0]))[:5])
        out["probabilities_count"] = len(probabilities)
    out["jev_model"] = label(result.get("model"))
    usage = result.get("usage", {})
    if isinstance(usage, dict):
        out["usage"] = {k: v for k, v in usage.items() if k in {
            "input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens"
        } and type(v) in (int, float) and math.isfinite(v) and v >= 0}
    route = result.get("route")
    if isinstance(route, dict):
        out["route"] = {k: label(route.get(k)) for k in ("lane", "model", "provider", "reasoning")}
    return out


class Jev:
    def __init__(self, ctx):
        self.ctx = ctx
        self.root = Path(__file__).resolve().parents[2]

    def settings(self) -> dict | None:
        if self.ctx.get_config("enabled", True) is not True:
            return None
        cfg = {k: self.ctx.get_config(k, v) for k, v in DEFAULTS.items()}
        cfg["timeout_ms"] = max(100, min(12000, int(cfg["timeout_ms"])))
        cfg["max_skills"] = max(0, min(60, int(cfg["max_skills"])))
        cfg["threshold"] = float(cfg["threshold"])
        if not math.isfinite(cfg["threshold"]) or not 0 <= cfg["threshold"] <= 1:
            raise ValueError("Invalid threshold")
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", cfg["key_env"]):
            raise ValueError("Invalid key_env")
        return cfg

    def launch(self, cfg: dict, home: Path, *, worker_harness: str = "") -> tuple[list[str], dict]:
        node = locate_command(cfg["node_path"], known_dirs=node_tool_dirs() + homebrew_dirs())
        if not node.found:
            raise FileNotFoundError("Node executable unavailable")
        cli = Path(cfg["cli_path"]).expanduser() if cfg["cli_path"] else self.root / "bin/jev-agent.mjs"
        cli = cli if cli.is_absolute() else self.root / cli
        if not cli.is_file():
            raise FileNotFoundError("Jev workflow CLI unavailable")
        # Start with non-secret runtime variables, not the launch profile's environment.
        base = {k: os.environ[k] for k in (
            "PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "SHELL", "SYSTEMROOT",
            "WINDIR", "PATHEXT", "SSL_CERT_FILE", "SSL_CERT_DIR", "HERMES_DISABLE_LAZY_INSTALLS",
        ) if k in os.environ}
        env = served_profile_child_env(base=base, target_home=home)
        if worker_harness == "hermes":
            env[HERMES_KEY] = get_secret(HERMES_KEY) or ""
        if worker_harness == "codex":
            # Resolve the worker credential in the active scope, never a sibling's environment.
            env[CODEX_KEY] = get_secret(CODEX_KEY) or ""
            codex_home = get_secret("CODEX_HOME")
            if codex_home:
                env["CODEX_HOME"] = codex_home
        env.update({cfg["key_env"]: get_secret(cfg["key_env"]) or "",
                    "TYPESAFE_API_KEY_ENV": cfg["key_env"], "TYPESAFE_API_URL": cfg["endpoint"],
                    "TYPESAFE_TIMEOUT_MS": str(max(50, cfg["timeout_ms"] - min(250, cfg["timeout_ms"] // 10))),
                    "JEV_CONFIDENCE_THRESHOLD": str(cfg["threshold"])})
        if worker_harness:
            catalog = self.catalog(cfg, home, worker_harness)
            if catalog is not None:
                env["JEV_ROUTES_JSON"] = json.dumps(catalog)
        if os.environ.get("JEV_WORKER") == "1":
            env["JEV_WORKER"] = "1"
        return [*node.command, str(cli)], env

    def catalog(self, cfg: dict, home: Path, harness: str) -> list | None:
        explicit = cfg.get("routes")
        if explicit is not None and (not isinstance(explicit, dict) or set(explicit) - {"hermes", "codex"}):
            raise ValueError("routes must be a dictionary by harness")
        if explicit is not None and harness in explicit:
            if not isinstance(explicit[harness], list):
                raise ValueError("Explicit routes must be a catalog array")
            return explicit[harness]
        path = home / "config.yaml"
        config = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}
        if not isinstance(config, dict):
            raise ValueError("Invalid profile configuration")
        providers = config.get("providers", {})
        if not isinstance(providers, dict):
            raise ValueError("Invalid provider configuration")
        codex = {}
        if harness == "codex":
            codex_home = get_secret("CODEX_HOME")
            codex_path = (Path(codex_home).expanduser() if codex_home else Path.home() / ".codex") / "config.toml"
            codex = tomllib.loads(codex_path.read_text(encoding="utf-8")) if codex_path.is_file() else {}
        codex_providers = codex.get("model_providers", {})
        if not isinstance(codex_providers, dict):
            raise ValueError("Invalid Codex provider configuration")
        entries = []
        for provider, details in providers.items():
            if not isinstance(details, dict):
                continue
            models = details.get("models", {})
            if isinstance(models, list):
                normalized = {}
                for model in models:
                    if isinstance(model, str):
                        normalized[model] = {}
                    elif isinstance(model, dict) and isinstance(model.get("id"), str):
                        normalized[model["id"]] = model
                    else:
                        raise ValueError("Invalid configured model list entry")
                models = normalized
            if not isinstance(models, dict):
                raise ValueError("Invalid configured model list")
            models = dict(models)
            default = details.get("default_model")
            if isinstance(default, str) and default:
                models.setdefault(default, {})
            names = [provider] if harness == "hermes" else []
            if harness == "codex" and details.get("transport") == "codex_responses":
                url = details.get("api") or details.get("url") or details.get("base_url")
                names = [name for name, entry in codex_providers.items()
                              if isinstance(entry, dict) and entry.get("wire_api") == "responses"
                              and isinstance(url, str) and isinstance(entry.get("base_url"), str)
                              and entry["base_url"].rstrip("/") == url.rstrip("/")]
            for model, metadata in models.items():
                if not isinstance(model, str) or not model:
                    raise ValueError("Invalid model identifier")
                metadata = metadata if isinstance(metadata, dict) else {}
                description = excerpt(metadata.get("description"), cfg, 500) or "Configured entry. Capabilities are unverified."
                bounded = model in {"gpt-6-luna", "subscription-gpt-6-luna", "gpt-6-sol", "subscription-gpt-6-sol"}
                reasoning = metadata.get("reasoning", "medium" if bounded else "inherit")
                for name in names:
                    entries.append({"id": "r-" + digest([name, model])[:16],
                                    "model": model, "provider": name, "reasoning": reasoning,
                                    "description": description})
        if not entries:
            return None
        preferred = "subscription-gpt-6-luna" if harness == "hermes" else "gpt-6-luna"
        default_config = config.get("model", {}) if harness == "hermes" else codex
        if not isinstance(default_config, dict):
            raise ValueError("Invalid default model configuration")
        default_model = default_config.get("default", "") if harness == "hermes" else codex.get("model", "")
        default_provider = default_config.get("provider", "") if harness == "hermes" else codex.get("model_provider", "")
        fallback = next((e for e in entries if e["model"] == preferred), None)
        if fallback is None:
            fallback = next((e for e in entries if e["model"] == default_model and e["provider"] == default_provider), entries[0])
        fallback["fallback"] = True
        return entries

    def decide(self, cfg: dict, home: Path, command: str, payload: dict,
               event: dict, kind: str, *, automatic: bool = True, args: list | None = None) -> dict | None:
        guard_kind = kind
        if kind == "watch_status":
            guard_kind += ":" + digest([event.get("source"), event.get("session_id")])
        identity = digest([guard_kind, command, event.get("session_id") or event.get("task_id"),
                           event.get("child_session_id") or event.get("parent_session_id"),
                           [event.get(k) for k in CORRELATION_IDS], payload])
        if automatic and not claim(home, guard_kind, identity):
            record(home, kind, event, {"suppressed": True})
            return None
        try:
            argv, env = self.launch(cfg, home, worker_harness=payload.get("harness", "") if command == "route" else "")
            if automatic and not env[cfg["key_env"]]:
                raise ValueError("Scoped Jev key unavailable")
            response = subprocess.run(
                [*argv, command, *(args or [])], input=json.dumps({**payload, "threshold": cfg["threshold"]}),
                capture_output=True, text=True, encoding="utf-8", check=True,
                env=env, timeout=cfg["timeout_ms"] / 1000,
            )
            if len(response.stdout) > 65536:
                raise ValueError("Oversized Jev response")
            result = json.loads(response.stdout)
            if not isinstance(result, dict) or result.get("kind") != command:
                raise ValueError("Invalid Jev response")
            safe = compact(result)
            counts = payload.get("roster_counts")
            if command == "skills" and isinstance(counts, dict):
                safe["roster_counts"] = {k: v for k, v in counts.items()
                                         if k in {"catalog_total", "eligible_total", "shortlisted_count"}
                                         and type(v) is int and v >= 0}
            key = env[cfg["key_env"]]
            if key:
                safe = json.loads(json.dumps(safe).replace(key, "[redacted]"))
            # Node fallbacks are valid advice, but an unavailable endpoint needs a cooldown.
            if result.get("fallback") is True and result.get("reason") in UNAVAILABLE_REASONS:
                self.cooldown(home, guard_kind, identity if automatic else "")
            record(home, kind, event, safe)
            return result
        except Exception as exc:
            self.cooldown(home, guard_kind, identity if automatic else "")
            record(home, kind, event, {"unavailable": type(exc).__name__})
            if not automatic:
                raise
            return None

    @staticmethod
    def cooldown(home: Path, command: str, identity: str = "") -> None:
        with database(home) as db:
            db.execute("DELETE FROM guards WHERE id=?", (identity,))
            db.execute("INSERT OR REPLACE INTO guards VALUES (?,?)", ("cool:" + command, time.time() + 30))
            db.execute("DELETE FROM guards WHERE id NOT IN "
                       "(SELECT id FROM guards ORDER BY at DESC LIMIT 512)")

    def roster(self, cfg: dict, task: str) -> dict:
        # Import lazily: skill discovery can itself trigger plugin discovery.
        from tools.skills_tool import skills_list
        rows = json.loads(skills_list()).get("skills", [])
        candidates = {}
        scores = {}
        terms = lexical_terms(task)
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = row.get("name", "")
            description = row.get("description", "")
            if (not isinstance(name, str) or not isinstance(description, str)
                    or not re.fullmatch(r"[\w:./-]{1,100}", name) or name.split(":")[-1] in WORKFLOWS
                    or name in {"jev", "jev:jev"} or re.search(
                        r"mandatory|always use|must use|automatically|override", str(description), re.I)):
                continue
            candidates[name] = {"name": name, "description": excerpt(description, cfg, 180)}
            scores[name] = 3 * len(terms & lexical_terms(name)) + len(terms & lexical_terms(description))
        ranked = sorted((name for name in candidates if scores[name] > 0),
                        key=lambda name: (-scores[name], name))[:min(5, cfg["max_skills"])]
        counts = {"catalog_total": len(rows), "eligible_total": len(candidates), "shortlisted_count": len(ranked)}
        return {"candidates": [candidates[k] for k in ranked], "roster_counts": counts,
                "latest_output": "Local lexical shortlist counts: " + json.dumps(counts)}

    def pre_llm_call(self, cfg: dict, home: Path, e: dict) -> dict | None:
        if not cfg["max_skills"]:
            return None
        task = excerpt(e.get("user_message"), cfg)
        if not task:
            return None
        roster = self.roster(cfg, task)
        candidates = roster["candidates"]
        if not candidates:
            return None
        result = self.decide(cfg, home, "skills", {"task": task, **roster}, e, "skill_hint")
        allowed = {s["name"] for s in candidates}
        suggestions = result.get("suggestions", []) if result else []
        names = list(dict.fromkeys(n for n in suggestions if isinstance(n, str) and n in allowed))[:3]
        if names:
            return {"context": "Optional Jev skill suggestions: " + ", ".join(names) +
                    ". Use skill_view only if relevant. Mandatory instructions and workflows still apply."}
        return None

    def post_tool_call(self, cfg: dict, home: Path, e: dict) -> None:
        args = e.get("args") or {}
        command = args.get("command", "") if isinstance(args, dict) else ""
        if e.get("tool_name") == "terminal" and (re.search(
                r"(?:\bhermes\b[^\n]*\bjev\b|jev-agent\.mjs)", str(command))
                or (cfg["cli_path"] and str(cfg["cli_path"]) in str(command))):
            return
        result = e.get("result")
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except ValueError:
                result = {}
        result = result if isinstance(result, dict) else {}
        code = result.get("exit_code", result.get("returncode"))
        if not (e.get("status") in NATIVE_FAILURES or result.get("success") is False
                or result.get("error") or (type(code) is int and code != 0)):
            if code == 0 or result.get("success") is True or e.get("status") in {"ok", "success", "completed"}:
                self.activity(home, e, "tool_progress", {"native_status": "progress", "tool": label(e.get("tool_name"))})
            return
        detail = excerpt(e.get("error_message") or result.get("error"), cfg, 240)
        if not result.get("error"):
            detail = (detail + "\n" + excerpt(result.get("output"), cfg, 750)).strip()
        metadata = {"tool": label(e.get("tool_name")), "status": label(e.get("status")),
                    "error_type": label(e.get("error_type")), "exit_code": code if type(code) is int else None,
                    "detail": detail}
        record(home, "tool_native_failure", e, {"native_status": "failed", "needs_attention": True,
               "tool": metadata["tool"], "exit_code": metadata["exit_code"]})
        self.decide(cfg, home, "triage", {"task": "Classify this tool failure.", "error": json.dumps(metadata)}, e, "tool_failure")

    def subagent_stop(self, cfg: dict, home: Path, e: dict) -> None:
        status = e.get("child_status")
        native = label(status.strip()).lower() if isinstance(status, str) else ""
        record(home, "child_native_outcome", e, {"native_status": native,
               "authoritative": native in NATIVE_FAILURES | {"completed"},
               "needs_attention": native in NATIVE_FAILURES | {"completed"}})
        payload = {"task": "Assess the child result without changing its native outcome.",
                   "native_status": native,
                   "latest_output": excerpt(e.get("child_summary"), cfg, 700)}
        for command in ("status", "triage"):
            self.decide({**cfg, "timeout_ms": min(6000, cfg["timeout_ms"])},
                        home, command, payload, e, "child_" + command)

    def api_request_error(self, cfg: dict, home: Path, e: dict) -> None:
        error = e.get("error")
        metadata = {"type": label(error.get("type")) if isinstance(error, dict) else "",
                    "provider": label(e.get("provider")), "model": label(e.get("model"))}
        reason = e.get("reason")
        if isinstance(reason, str) and reason in NATIVE_REASONS:
            metadata["native_reason"] = reason
        for key in ("status_code", "retry_count", "max_retries", "retryable"):
            if type(e.get(key)) in (int, bool):
                metadata[key] = e[key]
        record(home, "api_native_failure", e, {**metadata, "native_status": "failed", "needs_attention": True})
        self.decide(cfg, home, "triage", {"task": "Classify the provider failure.", "error": json.dumps(metadata)}, e, "api_failure")

    @staticmethod
    def activity(home: Path, e: dict, kind: str, fact: dict) -> None:
        scope = digest([kind, e.get("session_id") or e.get("task_id") or e.get("child_session_id")])
        if claim(home, "activity:" + scope, "sample:" + scope, ttl=5):
            record(home, kind, e, fact)

    def subagent_start(self, cfg: dict, home: Path, e: dict) -> None:
        record(home, "child_started", e, {"native_status": "started"})

    def pre_api_request(self, cfg: dict, home: Path, e: dict) -> None:
        self.activity(home, e, "api_active", {"native_status": "api_active", "provider": label(e.get("provider"))})

    def pre_approval_request(self, cfg: dict, home: Path, e: dict) -> None:
        record(home, "approval_waiting", e, {"waiting_for_input": True, "needs_attention": True})

    def post_approval_response(self, cfg: dict, home: Path, e: dict) -> None:
        choice = e.get("choice")
        allowed = {"once", "session", "always", "deny", "timeout", "smart_approve", "smart_deny", "notify_failed", "cancelled"}
        record(home, "approval_response", e, {"waiting_for_input": False,
               "native_choice": choice if isinstance(choice, str) and choice in allowed else "unknown"})

    def pre_verify(self, cfg: dict, home: Path, e: dict) -> None:
        paths = e.get("changed_paths")
        paths = paths if isinstance(paths, list) else []
        # Current Hermes supplies only final_response. Use task criteria only when explicitly supplied.
        evidence = {"coding": bool(e.get("coding")), "changed_count": len(paths)}
        for key in ("task", "user_message", "acceptance_criteria", "verification_criteria"):
            value = e.get(key)
            if isinstance(value, list):
                value = "\n".join(v[:1000] for v in value[:10] if isinstance(v, str))
            text = review_excerpt(value, cfg, paths, 600)
            if text:
                evidence[key] = text
        self.decide(cfg, home, "triage", {
            "task": ("Assess possible missing verification against any explicit task criteria in the evidence. "
                     "The final response is a bounded, filtered claim, not independently verified proof. "
                     "Missing criteria or omitted evidence are unknown. This is advice only."),
            "latest_output": review_excerpt(e.get("final_response"), cfg, paths, 1600),
            "error": json.dumps(evidence, ensure_ascii=False),
        }, e, "verification_advice")
        return None

    def on_session_end(self, cfg: dict, home: Path, e: dict) -> None:
        native = {k: e[k] for k in ("completed", "failed", "interrupted") if type(e.get(k)) is bool}
        status = next((k for k in ("interrupted", "failed", "completed") if native.get(k)), "unknown")
        record(home, "native_outcome", e, {"native": native, "native_status": status,
                                          "authoritative": status != "unknown", "needs_attention": status != "unknown"})

    def hook(self, name: str, **event):
        try:
            cfg = self.settings()
            if cfg is not None:
                return getattr(self, name)(cfg, active_home(), event)
        except Exception as exc:
            logging.getLogger(__name__).debug("Jev hook skipped: %s", type(exc).__name__)
        return None

    def cli(self, args: argparse.Namespace) -> None:
        try:
            cfg = self.settings()
            if cfg is None:
                print(json.dumps({"enabled": False}))
                return
            home = active_home()
            command = args.jev_command
            if command == "models":
                if args.jev_args:
                    raise ValueError("models takes no arguments")
                catalogs = {}
                for harness in ("hermes", "codex"):
                    argv, env = self.launch(cfg, home, worker_harness=harness)
                    result = subprocess.run([*argv, "models"], input=json.dumps({"harness": harness}),
                                            capture_output=True, text=True, encoding="utf-8", check=True,
                                            env=env, timeout=cfg["timeout_ms"] / 1000)
                    catalogs[harness] = json.loads(result.stdout)["routes"]
                print(json.dumps({"catalogs": catalogs, "access_verified": False}))
                return
            if command == "watch":
                # Hermes loads this plugin as a dynamically named package.
                from .watch import watch
                watch(self, cfg, home, args.jev_args)
                return
            if command == "status":
                if args.jev_args:
                    raise ValueError("status takes no arguments")
                print(json.dumps(summary(home)))
                return
            if command == "worker":
                worker_parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
                worker_parser.add_argument("--harness", choices=("hermes", "codex"), required=True)
                worker, _ = worker_parser.parse_known_args(args.jev_args)
                argv, env = self.launch(cfg, home, worker_harness=worker.harness)
                # Replace this explicit CLI process. A decision deadline must never kill a worker.
                os.execve(argv[0], [*argv, "worker", *args.jev_args], env)
            if sys.stdin.isatty():
                raise ValueError("JSON stdin required")
            raw = sys.stdin.read(32769)
            if len(raw) > 32768:
                raise ValueError("Input exceeds 32768 characters")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("JSON object required")
            if command == "skills" and "candidates" not in payload:
                roster = self.roster(cfg, excerpt(payload.get("task"), cfg))
                if isinstance(payload.get("latest_output"), str):
                    roster["latest_output"] += "\n" + excerpt(payload["latest_output"], cfg)
                payload.update(roster)
            result = self.decide(cfg, home, "status" if command == "evaluate" else command,
                                 payload, {}, "cli_" + command, automatic=False, args=args.jev_args)
            print(json.dumps(result))
        except Exception as exc:
            print(json.dumps({"error": "Jev command unavailable", "type": type(exc).__name__}), file=sys.stderr)
            raise SystemExit(1) from None

    def slash(self, raw: str) -> str:
        try:
            if self.settings() is None:
                return "Jev disabled."
            return json.dumps(summary(active_home())) + "\n" + HELP
        except Exception:
            return "Jev local state unavailable. " + HELP


def setup_cli(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("jev_command", nargs="?", default="status",
                        choices=("models", "status", "watch", "route", "skills", "triage", "evaluate", "worker"))
    parser.add_argument("jev_args", nargs=argparse.REMAINDER)


def register(ctx) -> None:
    plugin = Jev(ctx)
    for name in ("pre_llm_call", "post_tool_call", "subagent_start", "subagent_stop", "pre_api_request",
                 "api_request_error", "pre_approval_request", "post_approval_response", "pre_verify", "on_session_end"):
        ctx.register_hook(name, lambda _name=name, **event: plugin.hook(_name, **event))
    ctx.register_cli_command("jev", "Jev advice and explicit workers", setup_cli, plugin.cli)
    ctx.register_command("jev", plugin.slash, "Local Jev status and usage")
    skill = plugin.root / "skills/jev/SKILL.md"
    if skill.is_file():
        ctx.register_skill("jev", skill, description="Supervise tasks and route explicit worker launches.")
