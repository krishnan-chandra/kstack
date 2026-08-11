#!/usr/bin/env python3
"""Run one headless Pi evaluation run (with-skill or baseline) and capture evidence.

Usage:
  python3 run_eval.py --work-dir <dir> --run-dir <dir> --prompt-file <file>
      [--skill <path>] [--files <dir>] [--model <id>] [--force-skill]
      [--pi <path>] [--extra-args "a b"] [--max-seconds 600]

Behavior:
  - Copies input files from --files into the work dir, so each run works on
    its own scratch copy.
  - Launches `pi -p --mode json` with skills isolated to the skill under test
    (with-skill) or disabled entirely (baseline), and with extensions and
    context files disabled so nothing else can influence the run.
  - Saves into <run-dir>:
      transcript.jsonl        raw session stream
      outputs/result.txt      final assistant text
      outputs/assistant.json  full assistant messages (content + usage)
      outputs/tool_calls.json tool calls made during the run
      timing.json             total_tokens, duration_ms, model, provider
      run_meta.json           prompt, config, skill path, trigger detection

  "triggered" is true when the model read the skill's SKILL.md during the run.
  With --force-skill, an instruction to consult the skill is appended to the
  prompt, separating capability from triggering.

Exit code 0 on success (including a completed run with a failed task);
non-zero on infrastructure failure (missing pi, timeout, unparseable output).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--work-dir", required=True, help="scratch dir the run executes in")
    p.add_argument("--run-dir", required=True, help="dir for transcript.jsonl, outputs/, timing.json")
    p.add_argument("--prompt-file", required=True, help="file containing the exact eval prompt")
    p.add_argument("--skill", default=None, help="skill dir to expose (omit for a baseline run)")
    p.add_argument("--files", default=None, help="dir of input files to copy into the work dir")
    p.add_argument("--model", default=None, help="pi --model value; default = user's configured model")
    p.add_argument("--force-skill", action="store_true", help="append an instruction to consult the skill")
    p.add_argument("--pi", default="pi", help="pi executable")
    p.add_argument("--extra-args", default="", help="additional pi flags, space-separated")
    p.add_argument("--max-seconds", type=int, default=600, help="kill the run after this many seconds")
    return p.parse_args()


def load_prompt(prompt_file: Path, skill: str | None, force: bool) -> str:
    prompt = prompt_file.read_text(encoding="utf-8").strip()
    if force:
        assert skill, "--force-skill requires --skill"
        prompt += f"\n\nConsult and follow the skill at {skill}: read its SKILL.md first and use it."
    return prompt


def parse_stream(lines: list[str]) -> dict:
    """Extract text, tool calls, tokens, model/provider from a JSONL session stream."""
    text_deltas: list[str] = []
    tool_calls: list[dict] = []
    tokens = 0
    model = provider = None
    last_ts: int | None = None
    first_ts: int | None = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = ev.get("timestamp")
        if isinstance(ts, int):
            first_ts = first_ts if first_ts is not None else ts
            last_ts = ts
        kind = ev.get("type")
        if kind == "message_update":
            ae = ev.get("assistantMessageEvent") or {}
            t = ae.get("type")
            if t == "text_delta":
                text_deltas.append(ae.get("delta", ""))
            elif t == "toolcall_end":
                tc = ae.get("toolCall") or {}
                tool_calls.append({"name": tc.get("name"), "arguments": tc.get("arguments")})
        elif kind == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") == "assistant":
                usage = msg.get("usage") or {}
                if usage.get("totalTokens"):
                    tokens = usage["totalTokens"]
                if msg.get("model"):
                    model = msg["model"]
                if msg.get("provider"):
                    provider = msg["provider"]
            elif msg.get("role") == "user":
                pass  # ignore echoed user messages
    text = "".join(text_deltas).strip()
    if not text:
        # Fallback: pull text parts out of the final message_end content
        for line in reversed(lines):
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "message_end":
                msg = ev.get("message") or {}
                if msg.get("role") == "assistant":
                    parts = [c.get("text", "") for c in (msg.get("content") or []) if c.get("type") == "text"]
                    if parts:
                        text = "\n".join(parts).strip()
                        break
    return {
        "text": text,
        "tool_calls": tool_calls,
        "tokens": tokens,
        "model": model,
        "provider": provider,
        "first_ts": first_ts,
        "last_ts": last_ts,
    }


def main() -> int:
    args = parse_args()
    work_dir = Path(args.work_dir)
    run_dir = Path(args.run_dir)
    outputs = run_dir / "outputs"
    for d in (work_dir, outputs):
        d.mkdir(parents=True, exist_ok=True)

    prompt = load_prompt(Path(args.prompt_file), args.skill, args.force_skill)
    (run_dir / "prompt.txt").write_text(prompt, encoding="utf-8")

    if args.files:
        src = Path(args.files)
        if src.is_dir():
            for f in src.iterdir():
                if f.is_file():
                    shutil.copy2(f, work_dir / f.name)

    cmd = [args.pi, "-p", "--mode", "json", "--no-extensions", "--no-context-files", "--no-skills"]
    if args.skill:
        cmd += ["--skill", str(Path(args.skill).resolve())]
    if args.model:
        cmd += ["--model", args.model]
    if args.extra_args:
        cmd += args.extra_args.split()
    cmd += [prompt]

    started = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=args.max_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"error: run exceeded {args.max_seconds}s and was killed", file=sys.stderr)
        meta = {"prompt": prompt, "config": "with_skill" if args.skill else "without_skill",
                "skill_path": args.skill, "work_dir": str(work_dir),
                "tool_calls": [], "errors": [f"timeout after {args.max_seconds}s"]}
        (run_dir / "run_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 1
    duration_ms = int((time.monotonic() - started) * 1000)

    (run_dir / "transcript.jsonl").write_text(proc.stdout, encoding="utf-8")
    if proc.stderr.strip():
        (run_dir / "pi.stderr.log").write_text(proc.stderr, encoding="utf-8")

    parsed = parse_stream(proc.stdout.splitlines())

    # Trigger detection: a read tool call whose path points into the skill dir
    triggered = False
    if args.skill:
        skill_resolved = str(Path(args.skill).resolve())
        for tc in parsed["tool_calls"]:
            if tc.get("name") != "read":
                continue
            args_str = json.dumps(tc.get("arguments") or {})
            if "SKILL.md" in args_str and skill_resolved in args_str:
                triggered = True

    (outputs / "result.txt").write_text(parsed["text"], encoding="utf-8")
    (outputs / "tool_calls.json").write_text(json.dumps(parsed["tool_calls"], indent=2), encoding="utf-8")

    now = datetime.now(timezone.utc).isoformat()
    timing = {
        "total_tokens": parsed["tokens"],
        "duration_ms": duration_ms,
        "total_duration_seconds": round(duration_ms / 1000, 1),
        "model": parsed["model"],
        "provider": parsed["provider"],
        "triggered": triggered,
        "timestamp": now,
    }
    (run_dir / "timing.json").write_text(json.dumps(timing, indent=2), encoding="utf-8")

    meta = {
        "prompt": prompt,
        "config": "with_skill" if args.skill else "without_skill",
        "skill_path": args.skill,
        "work_dir": str(work_dir),
        "tool_calls": parsed["tool_calls"],
        "errors": [] if proc.returncode == 0 else [f"pi exited {proc.returncode}"],
    }
    (run_dir / "run_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"run complete: config={meta['config']} tokens={timing['total_tokens']} "
          f"duration={timing['total_duration_seconds']}s triggered={triggered} text={len(parsed['text'])} chars")
    if proc.returncode != 0:
        print(f"warning: pi exited with {proc.returncode}; see pi.stderr.log", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
