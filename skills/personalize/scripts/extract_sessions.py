#!/usr/bin/env python3
"""Extract normalized user/assistant turns from coding-agent session history.

Supported sources and their on-disk locations:

  pi      ~/.pi/agent/sessions/**/*.jsonl and ~/.pi/agent/archive/sessions/**/session.jsonl
  claude  ~/.claude/projects/**/*.jsonl
  codex   ~/.codex/sessions/**/rollout-*.jsonl
  cursor  ~/.cursor/*.sqlite and Cursor workspaceStorage state.vscdb files (best effort)

Everything is read-only. SQLite databases are copied to a temp file and opened
with SQLite's query_only mode before any query runs.

Output is JSONL, one record per message:
  {"source", "session_id", "timestamp", "role", "text", "path"}

Examples:
  extract_sessions.py --source all --roles user --limit 400
  extract_sessions.py --source pi,claude --since 2026-07-01 --cwd kstack
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

MAX_TEXT_CHARS = 2000
MAX_SQLITE_BYTES = 512 * 1024 * 1024
CURSOR_VALUE_KEYS = ("text", "message", "content", "prompt", "richText")


def iter_jsonl(path: Path):
    try:
        with path.open("r", encoding="utf-8", errors="strict") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except (OSError, UnicodeDecodeError):
        return


def clip(text: str, max_text: int) -> str:
    text = " ".join(text.split())
    if len(text) > max_text:
        return text[:max_text] + "…"
    return text


def text_from_blocks(content) -> str:
    """Pull plain text out of Pi/Claude content blocks; skip thinking, tools, images."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
    return "\n".join(p for p in parts if p)


def iso_from_ms(value) -> str | None:
    try:
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def extract_pi(path: Path, roles: set[str], max_text: int):
    session_id = None
    cwd = None
    for entry in iter_jsonl(path):
        etype = entry.get("type")
        if etype == "session":
            session_id = entry.get("id")
            cwd = entry.get("cwd")
            continue
        if etype == "session_info":
            continue
        if etype != "message":
            continue
        msg = entry.get("message") or {}
        role = msg.get("role")
        if role not in roles:
            continue
        text = text_from_blocks(msg.get("content"))
        if not text:
            continue
        yield {
            "source": "pi",
            "session_id": session_id,
            "cwd": cwd,
            "timestamp": entry.get("timestamp") or iso_from_ms(msg.get("timestamp")),
            "role": role,
            "text": clip(text, max_text),
            "path": str(path),
        }


def claude_cwd_from_path(path: Path) -> str | None:
    """Claude project dirs encode the cwd as the path with '/' replaced by '-'.

    Decoding is lossy (real hyphens are indistinguishable from separators), but
    the result is only used for substring filtering, so ambiguity is harmless.
    """
    # <proj>/<session>.jsonl or <proj>/<session>/subagents/<agent>.jsonl
    project_dir = path.parent.parent.parent if path.parent.name == "subagents" else path.parent
    encoded = project_dir.name
    return "/" + encoded.lstrip("-").replace("-", "/") if encoded else None


def extract_claude(path: Path, roles: set[str], max_text: int):
    session_id = None
    cwd = claude_cwd_from_path(path)
    for entry in iter_jsonl(path):
        session_id = session_id or entry.get("sessionId")
        if entry.get("type") not in ("user", "assistant"):
            continue
        msg = entry.get("message") or {}
        role = msg.get("role")
        if role not in roles:
            continue
        text = text_from_blocks(msg.get("content"))
        if not text:
            continue
        yield {
            "source": "claude",
            "session_id": session_id,
            "cwd": cwd,
            "timestamp": entry.get("timestamp"),
            "role": role,
            "text": clip(text, max_text),
            "path": str(path),
        }


def codex_payload_text(payload: dict) -> tuple[str | None, str]:
    """Return (role, text) for the Codex rollout payload variants we know."""
    ptype = payload.get("type")
    if ptype == "message":
        role = payload.get("role")
        parts = []
        for block in payload.get("content") or []:
            if isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text"):
                parts.append(str(block.get("text", "")))
        return role, "\n".join(p for p in parts if p)
    if ptype == "user_message":
        return "user", str(payload.get("message", ""))
    if ptype == "agent_message":
        return "assistant", str(payload.get("message", ""))
    return None, ""


def extract_codex(path: Path, roles: set[str], max_text: int):
    session_id = None
    cwd = None
    for entry in iter_jsonl(path):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        session_id = session_id or payload.get("session_id") or payload.get("sessionId")
        if payload.get("type") == "turn_context":
            cwd = cwd or payload.get("cwd")
            continue
        role, text = codex_payload_text(payload)
        if role not in roles or not text:
            continue
        yield {
            "source": "codex",
            "session_id": session_id,
            "cwd": cwd,
            "timestamp": entry.get("timestamp"),
            "role": role,
            "text": clip(text, max_text),
            "path": str(path),
        }


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def cursor_strings(obj, depth=0):
    """Yield (key_hint, string) pairs from nested Cursor JSON blobs."""
    if depth > 6:
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str) and len(value) >= 20 and key in CURSOR_VALUE_KEYS:
                yield key, value
            else:
                yield from cursor_strings(value, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            yield from cursor_strings(item, depth + 1)


def extract_cursor_sqlite(path: Path, roles: set[str], max_text: int):
    """Best effort: Cursor schemas vary by version; scan JSON values for text."""
    try:
        if path.stat().st_size > MAX_SQLITE_BYTES:
            return
    except OSError:
        return
    tmp = tempfile.NamedTemporaryFile(prefix="kstack-cursor-", suffix=".sqlite", delete=False)
    tmp.close()
    try:
        shutil.copyfile(path, tmp.name)
        uri = f"file:{tmp.name}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            conn.execute("PRAGMA query_only = ON")
            tables = [
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ]
            for table in tables:
                quoted_table = '"' + table.replace('"', '""') + '"'
                try:
                    columns = [c[1] for c in conn.execute(f"PRAGMA table_info({quoted_table})")]
                except sqlite3.DatabaseError:
                    continue
                value_cols = [c for c in columns if c.lower() in ("value", "data", "json", "blob")]
                if not value_cols:
                    continue
                quoted_col = '"' + value_cols[0].replace('"', '""') + '"'
                key_cols = [c for c in columns if c.lower() == "key"]
                quoted_key = '"' + key_cols[0].replace('"', '""') + '"' if key_cols else None
                select_cols = f"{quoted_key}, {quoted_col}" if quoted_key else quoted_col
                try:
                    rows = conn.execute(f"SELECT {select_cols} FROM {quoted_table} LIMIT 2000")
                except sqlite3.DatabaseError:
                    continue
                for row in rows:
                    row_key, raw = row if quoted_key else (None, row[0])
                    # Trusted container metadata: rows keyed aiService.prompts hold
                    # the human's prompts, so their text is user-authored.
                    row_is_prompts = isinstance(row_key, str) and "prompt" in row_key.lower()
                    if isinstance(raw, bytes):
                        try:
                            raw = raw.decode("utf-8")
                        except UnicodeDecodeError:
                            continue
                    if not isinstance(raw, str) or len(raw) < 20:
                        continue
                    try:
                        parsed = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    for hint, text in cursor_strings(parsed):
                        role = "user" if row_is_prompts or hint in ("prompt",) else "unknown"
                        if role not in roles:
                            continue
                        yield {
                            "source": "cursor",
                            "session_id": None,
                            "timestamp": None,
                            "role": role,
                            "text": clip(text, max_text),
                            "path": f"{path}:{table}",
                        }
        finally:
            conn.close()
    except (OSError, sqlite3.DatabaseError):
        return
    finally:
        os.unlink(tmp.name)


def env_root(name: str) -> Path | None:
    """Test/override hook: point a source at a fixture root instead of $HOME."""
    value = os.environ.get(name)
    return Path(value) if value else None


def cursor_db_paths() -> list[Path]:
    override = env_root("PERSONALIZE_CURSOR_HOME")
    if override is not None:
        return sorted(override.rglob("*.sqlite")) + sorted(override.rglob("state.vscdb"))
    paths = []
    home = Path.home() / ".cursor"
    if home.is_dir():
        paths.extend(sorted(home.glob("*.sqlite")))
    for base in (
        Path.home() / "Library/Application Support/Cursor/User/workspaceStorage",  # macOS
        Path.home() / ".config/Cursor/User/workspaceStorage",  # Linux
    ):
        if base.is_dir():
            paths.extend(sorted(base.glob("*/state.vscdb")))
    return paths


def newest_first(files: list[Path]) -> list[Path]:
    """Recent history carries the durable signal; cap from the newest end."""
    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    return sorted(files, key=mtime, reverse=True)


def _pi_files() -> list[Path]:
    override = env_root("PERSONALIZE_PI_HOME")
    if override is not None:
        return sorted(override.rglob("*.jsonl"))
    base = Path.home() / ".pi/agent"
    if not base.is_dir():
        return []
    return (
        list((base / "sessions").rglob("*.jsonl"))
        + list((base / "archive/sessions").rglob("session.jsonl"))
    )


def _claude_files(include_subagents: bool) -> list[Path]:
    override = env_root("PERSONALIZE_CLAUDE_HOME")
    base = override if override is not None else Path.home() / ".claude/projects"
    if not base.is_dir():
        return []
    files = list(base.rglob("*.jsonl"))
    if not include_subagents:
        files = [f for f in files if "subagents" not in f.parts]
    return files


def _codex_files() -> list[Path]:
    override = env_root("PERSONALIZE_CODEX_HOME")
    base = override if override is not None else Path.home() / ".codex/sessions"
    return list(base.rglob("rollout-*.jsonl")) if base.is_dir() else []


SOURCE_DIRS = {"pi": _pi_files, "claude": _claude_files, "codex": _codex_files}

EXTRACTORS = {"pi": extract_pi, "claude": extract_claude, "codex": extract_codex}


def parse_since(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = parse_iso(value)
    if dt is None:
        raise SystemExit(f"--since must be an ISO date like 2026-07-01, got: {value}")
    return dt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="all", help="comma list: pi,claude,codex,cursor or 'all'")
    parser.add_argument("--roles", default="user", help="comma list of roles to keep (default: user)")
    parser.add_argument("--since", help="only messages at or after this ISO date")
    parser.add_argument("--cwd", help="substring filter on the session's working directory")
    parser.add_argument("--include-subagents", action="store_true",
                        help="include Claude Code subagent transcripts (their 'user' turns are agent-written)")
    parser.add_argument("--limit", type=int, default=400, help="max messages to emit (default 400)")
    parser.add_argument("--max-text", type=int, default=MAX_TEXT_CHARS, help="per-message character cap")
    parser.add_argument("--list-sources", action="store_true", help="show detected sources and exit")
    args = parser.parse_args()

    sources = list(EXTRACTORS) + ["cursor"] if args.source == "all" else [s.strip() for s in args.source.split(",")]
    unknown = [s for s in sources if s not in EXTRACTORS and s != "cursor"]
    if unknown:
        raise SystemExit(f"unknown source(s): {', '.join(unknown)}")

    roles = {r.strip() for r in args.roles.split(",") if r.strip()}
    since = parse_since(args.since)

    files: dict[str, list[Path]] = {}
    for source in sources:
        if source == "cursor":
            files[source] = cursor_db_paths()
        elif source == "claude":
            files[source] = _claude_files(args.include_subagents)
        else:
            files[source] = SOURCE_DIRS[source]()

    if args.list_sources:
        for source in sources:
            print(f"{source}: {len(files[source])} file(s)")
            for path in files[source][:5]:
                print(f"  {path}")
            if len(files[source]) > 5:
                print(f"  … and {len(files[source]) - 5} more")
        return 0

    # Per-source cap, newest files first: a global cap over a fixed source
    # order would starve later sources and drop the recent history that carries
    # the durable signal.
    per_source_limit = max(1, -(-args.limit // max(len(sources), 1)))
    warned_undated = False
    for source in sources:
        emitted = 0
        for path in newest_first(files[source]):
            records = (
                extract_cursor_sqlite(path, roles, args.max_text)
                if source == "cursor"
                else EXTRACTORS[source](path, roles, args.max_text)
            )
            for record in records:
                if not record["text"]:
                    continue
                if args.cwd:
                    haystack = record.get("cwd") or str(path)
                    if args.cwd not in haystack:
                        continue
                if since:
                    ts = parse_iso(record["timestamp"])
                    if ts is None:
                        if not warned_undated:
                            print("note: records without timestamps are excluded by --since", file=sys.stderr)
                            warned_undated = True
                        continue
                    if ts < since:
                        continue
                json.dump(record, sys.stdout, ensure_ascii=False)
                sys.stdout.write("\n")
                emitted += 1
                if emitted >= per_source_limit:
                    print(f"{source}: per-source limit of {per_source_limit} reached; use --since/--cwd/--limit to narrow", file=sys.stderr)
                    break
            if emitted >= per_source_limit:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
