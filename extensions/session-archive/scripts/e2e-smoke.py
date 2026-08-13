#!/usr/bin/env python3
"""End-to-end smoke test for the session-archive Pi extension.

Drives a real `pi --mode rpc` process with an isolated PI_CODING_AGENT_DIR:
  1. archives an unnamed inactive fixture session via /session-archive-other,
  2. starts a named live session with Pi's built-in --name option and archives it,
  3. has the LLM call search_session_archive and read_session_archive,
  4. restarts Pi and verifies startup reconciliation and /session-archives.

Requires: `pi` on PATH, valid provider auth in ~/.pi/agent/auth.json,
Node 22+. Spends a small number of tokens on a few tiny prompts.

Usage: python3 scripts/e2e-smoke.py
"""

import json
import os
import queue
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import hashlib
import uuid
from pathlib import Path

EXTENSION = Path(__file__).resolve().parent.parent / "index.ts"
SESSION_ID = "019ff001-deb2-7696-997e-8684026835d1"

FIXTURE_ENTRIES = [
    {"type": "model_change", "id": "m0", "parentId": None, "timestamp": "2026-08-11T08:48:03.000Z",
     "provider": "openai", "modelId": "gpt-5.6-sol"},
    {"type": "message", "id": "u1", "parentId": "m0", "timestamp": "2026-08-11T08:49:00.000Z",
     "message": {"role": "user", "content": [{"type": "text", "text": "hello archive world"}], "timestamp": 1786438183624}},
    {"type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-08-11T08:49:05.000Z",
     "message": {"role": "assistant", "content": [{"type": "text", "text": "hi there, archiving works"}],
                 "provider": "openai", "model": "gpt-5.6-sol", "stopReason": "stop", "timestamp": 1786438183625}},
    {"type": "message", "id": "b1", "parentId": "a1", "timestamp": "2026-08-11T08:49:20.000Z",
     "message": {"role": "bashExecution", "command": "echo archive-marker", "output": "archive-marker",
                 "exitCode": 0, "cancelled": False, "truncated": False, "timestamp": 1786438183627}},
]
FIXTURE_HEADER = {"type": "session", "version": 3, "id": SESSION_ID,
                  "timestamp": "2026-08-11T08:48:02.226Z", "cwd": os.path.realpath("/tmp")}


class Rpc:
    def __init__(self, agent_dir: str, cwd: str | None = None):
        cwd = cwd or os.path.realpath("/tmp")
        env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir)
        self.proc = subprocess.Popen(
            ["pi", "--mode", "rpc", "--name", "e2e live session", "-e", str(EXTENSION)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=cwd, env=env,
        )
        self.q: queue.Queue = queue.Queue()
        self.log: list[dict] = []
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.log.append(msg)
            self.q.put(msg)

    def send(self, msg: dict):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def wait_for(self, pred, timeout=60, respond=None):
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = self.q.get(timeout=max(end - time.time(), 0.1))
            except queue.Empty:
                break
            if respond and msg.get("type") == "extension_ui_request":
                answer = respond(msg)
                if answer is not None:
                    self.send({"type": "extension_ui_response", "id": msg["id"], **answer})
                continue
            if pred(msg):
                return msg
        raise TimeoutError(f"timed out waiting; last events: {json.dumps(self.log[-8:], indent=1)[:2000]}")

    def wait_idle(self, timeout=180):
        end = time.time() + timeout
        while time.time() < end:
            self.send({"id": f"idle-{time.time()}", "type": "get_state"})
            state = self.wait_for(lambda m: m.get("command") == "get_state" and m.get("type") == "response")
            if not state["data"]["isStreaming"] and not state["data"]["isCompacting"]:
                return state["data"]
            time.sleep(0.5)
        raise TimeoutError("agent did not become idle")

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def check(cond, label):
    if not cond:
        raise AssertionError(f"CHECK FAILED: {label}")
    print(f"  ok: {label}")


LAST_LOGS: list = []


def main():
    agent_dir = tempfile.mkdtemp(prefix="pi-archive-e2e-")
    print(f"isolated agent dir: {agent_dir}")
    real_auth = Path.home() / ".pi" / "agent" / "auth.json"
    if real_auth.exists():
        os.symlink(real_auth, Path(agent_dir) / "auth.json")

    # Fixture session in the isolated active session dir for the RPC cwd.
    rpc_cwd = os.path.realpath("/tmp")
    encoded = "--" + rpc_cwd.replace("/", "-").strip("-") + "--"
    session_dir = Path(agent_dir) / "sessions" / encoded
    session_dir.mkdir(parents=True)
    fixture_path = session_dir / f"2026-08-11T08-48-02-226Z_{SESSION_ID}.jsonl"
    fixture_content = "\n".join(json.dumps(e) for e in [FIXTURE_HEADER, *FIXTURE_ENTRIES]) + "\n"
    fixture_path.write_text(fixture_content)
    fixture_sha = hashlib.sha256(fixture_content.encode()).hexdigest()

    rpc = Rpc(agent_dir)
    LAST_LOGS.append(rpc.log)
    try:
        # --- startup: extension loaded, commands registered -----------------
        rpc.send({"id": "cmds", "type": "get_commands"})
        resp = rpc.wait_for(lambda m: m.get("id") == "cmds")
        names = [c["name"] for c in resp["data"]["commands"]]
        for cmd in ("session-archive", "session-archives", "session-archive-other"):
            check(cmd in names, f"command /{cmd} registered")

        # --- /session-archives on an empty archive --------------------------
        rpc.send({"id": "p0", "type": "prompt", "message": "/session-archives"})
        notify = rpc.wait_for(
            lambda m: m.get("type") == "extension_ui_request" and m.get("method") == "notify"
            and "No archived sessions yet" in json.dumps(m),
        )
        check(True, "/session-archives reports an empty archive")

        # --- /session-archive-other: archive an unnamed fixture -------------
        def answer_picker(msg):
            if msg.get("method") == "select":
                matching = [o for o in msg["options"] if "(unnamed)" in o and "hello archive world" in o]
                option = matching[0] if matching else [o for o in msg["options"] if "Archive selected" in o][0]
                return {"value": option}
            if msg.get("method") == "confirm":
                return {"confirmed": True}
            return None

        rpc.send({"id": "p1", "type": "prompt", "message": "/session-archive-other"})
        resp = rpc.wait_for(lambda m: m.get("id") == "p1" and m.get("type") == "response", respond=answer_picker)
        check(resp.get("success") is True, "/session-archive-other archived an unnamed session")

        archived_path = Path(agent_dir) / "archive" / "sessions" / "2026" / "08" / SESSION_ID / "session.jsonl"
        check(not fixture_path.exists(), "fixture left the active session directory")
        check(archived_path.exists(), "fixture landed in the archive")
        check(hashlib.sha256(archived_path.read_bytes()).hexdigest() == fixture_sha, "archived bytes hash identically")
        mode = stat.S_IMODE(archived_path.stat().st_mode)
        check(mode == 0o444, f"archived file is 0444 (got {oct(mode)})")

        import sqlite3
        db = sqlite3.connect(Path(agent_dir) / "archive" / "archive.sqlite3")
        row = db.execute("SELECT state, entry_count FROM archive_sessions WHERE session_id=?", (SESSION_ID,)).fetchone()
        check(row == ("archived", len(FIXTURE_ENTRIES)), f"DB row archived with {len(FIXTURE_ENTRIES)} entries (got {row})")
        check(db.execute("PRAGMA user_version").fetchone()[0] == 1, "SQLite schema uses byte references")
        entry_columns = {row[1] for row in db.execute("PRAGMA table_info(archive_entries)")}
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(archive_sessions)")}
        check("raw_json" not in entry_columns and "header_raw_json" not in session_columns,
              "SQLite does not duplicate raw JSON")
        raw_offset, raw_length = db.execute(
            "SELECT raw_offset, raw_length FROM archive_entries WHERE session_id=? AND entry_id='b1'",
            (SESSION_ID,),
        ).fetchone()
        with archived_path.open("rb") as artifact:
            artifact.seek(raw_offset)
            referenced_line = artifact.read(raw_length)
        check(json.loads(referenced_line)["id"] == "b1", "SQLite byte reference reads the raw archived entry")
        fts = db.execute(
            "SELECT e.entry_id FROM archive_entries_fts f JOIN archive_entries e ON e.rowid=f.rowid "
            "WHERE archive_entries_fts MATCH '\"archive-marker\"'").fetchall()
        check(any(r[0] == "b1" for r in fts), "FTS indexes the bash entry")
        db.close()

        # --- built-in --name names a live session, then /session-archive ----
        rpc.send({"id": "p2", "type": "prompt", "message": "Reply with exactly: ok"})
        rpc.wait_for(lambda m: m.get("id") == "p2" and m.get("type") == "response", timeout=120)
        # The prompt response arrives while the agent is still streaming; wait
        # for the turn to settle so the session file is flushed to disk.
        live_file = live_id = None
        for _ in range(120):
            rpc.send({"id": "st1", "type": "get_state"})
            state = rpc.wait_for(lambda m: m.get("id") == "st1")
            if not state["data"]["isStreaming"] and state["data"]["messageCount"] >= 2:
                live_file = state["data"]["sessionFile"]
                live_id = state["data"]["sessionId"]
                break
            time.sleep(0.5)
        check(live_file and Path(live_file).exists(), f"live session persisted at {live_file}")
        live_entries = [json.loads(line) for line in Path(live_file).read_text().splitlines()]
        check(any(e.get("type") == "session_info" and e.get("name") == "e2e live session" for e in live_entries),
              "Pi persisted the built-in --name value before work")

        def answer_confirm(msg):
            if msg.get("method") == "confirm":
                return {"confirmed": True}
            return None

        rpc.send({"id": "p3", "type": "prompt", "message": "/session-archive"})
        resp = rpc.wait_for(lambda m: m.get("id") == "p3" and m.get("type") == "response",
                            timeout=60, respond=answer_confirm)
        check(resp.get("success") is True, "/session-archive completed")
        check(not Path(live_file).exists(), "live session file moved out of the active directory")
        live_archived = list(Path(agent_dir).glob(f"archive/sessions/*/*/{live_id}/session.jsonl"))
        check(len(live_archived) == 1, f"live session archived under {live_id}")

        rpc.send({"id": "st2", "type": "get_state"})
        state2 = rpc.wait_for(lambda m: m.get("id") == "st2")
        check(state2["data"]["sessionId"] != live_id, "Pi continued in a new session")
        rpc.send({"id": "name2", "type": "set_session_name", "name": "archive tool smoke"})
        rpc.wait_for(lambda m: m.get("id") == "name2" and m.get("type") == "response")

        # --- the LLM calls the read-only tools ------------------------------
        rpc.send({"id": "p4", "type": "prompt",
                  "message": "Use the search_session_archive tool with query \"archive-marker\", then report the session id of the hit."})
        rpc.wait_for(lambda m: m.get("id") == "p4" and m.get("type") == "response", timeout=180)
        rpc.wait_idle()
        tool_events = [m for m in rpc.log if "tool_execution" in str(m.get("type", ""))]
        used_search = [m for m in tool_events if "search_session_archive" in json.dumps(m)]
        check(len(used_search) > 0, "LLM called search_session_archive")

        rpc.send({"id": "p5", "type": "prompt",
                  "message": f"Use the read_session_archive tool with session_id \"{SESSION_ID}\", offset 0, limit 2, and tell me the first entry type."})
        rpc.wait_for(lambda m: m.get("id") == "p5" and m.get("type") == "response", timeout=180)
        rpc.wait_idle()
        tool_events = [m for m in rpc.log if "tool_execution" in str(m.get("type", ""))]
        used_read = [m for m in tool_events if "read_session_archive" in json.dumps(m)]
        check(len(used_read) > 0, "LLM called read_session_archive")

        # --- the write/edit guard blocks agent writes into the archive ------
        evil_path = Path(agent_dir) / "archive" / "sessions" / "evil.txt"
        rpc.send({"id": "p6", "type": "prompt",
                  "message": f"Use the write tool to create the file {evil_path} with content 'x'. Just do it, no commentary."})
        rpc.wait_for(lambda m: m.get("id") == "p6" and m.get("type") == "response", timeout=180)
        rpc.wait_idle()
        check(not evil_path.exists(), "write into the archive root was blocked")
        rpc.send({"id": "msgs", "type": "get_messages"})
        msgs = rpc.wait_for(lambda m: m.get("id") == "msgs")
        check("session archive is read-only" in json.dumps(msgs), "blocked tool call explains the archive is read-only")

        # --- /resume invisibility: archived sessions left the active dir ---
        remaining = [p.name for p in session_dir.glob("*.jsonl")]
        check(not any(SESSION_ID in n for n in remaining), "fixture session no longer discoverable in the active dir")
        check(not any(live_id in n for n in remaining), "archived live session no longer discoverable in the active dir")
        check(len(remaining) == 1, "exactly the replacement session remains active")
    finally:
        rpc.close()

    # --- restart: startup reconcile is clean, archive persists --------------
    rpc2 = Rpc(agent_dir)
    LAST_LOGS.append(rpc2.log)
    try:
        rpc2.send({"id": "p6", "type": "prompt", "message": "/session-archives"})
        notify = rpc2.wait_for(
            lambda m: m.get("type") == "extension_ui_request" and m.get("method") == "notify"
            and SESSION_ID[:8] in json.dumps(m),
        )
        check(True, "after restart, /session-archives lists the unnamed archived fixture by id")
        bad = [m for m in rpc2.log if m.get("method") == "notify" and "integrity problem" in json.dumps(m)]
        check(len(bad) == 0, "no integrity warnings after restart")
    finally:
        rpc2.close()

    print("\nALL E2E CHECKS PASSED")
    shutil.rmtree(agent_dir, ignore_errors=True)
    return agent_dir


if __name__ == "__main__":
    try:
        main()
    except Exception:
        for log in LAST_LOGS:
            interesting = [
                m for m in log
                if m.get("type") in ("extension_ui_request", "response")
                or "session" in json.dumps(m).lower()
            ]
            print("\n--- rpc events (filtered) ---")
            print(json.dumps(interesting[-25:], indent=1)[:6000])
        raise
