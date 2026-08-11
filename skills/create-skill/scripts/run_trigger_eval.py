#!/usr/bin/env python3
"""Measure how often a candidate skill description triggers for an eval set.

Usage:
  python3 run_trigger_eval.py --eval-set triggers.json --skill-path <dir>
      [--description "<candidate description>"]
      [--runs 1] [--jobs 4] [--model <id>] [--out-dir <dir>] [--pi <path>]
      [--max-seconds 120]

The eval set is JSON: [{"query": "...", "should_trigger": true}, ...].

For each query (x --runs), a headless `pi -p --mode json` process runs with a
temp skill directory containing the candidate description as the ONLY skill.
"Triggered" means the model read that skill's SKILL.md during the run.

Without --description, the description is read from the skill's own
SKILL.md frontmatter (single-line `description:` field). The real skill
directory is never modified.

Writes <out-dir>/trigger_results.json and prints a per-query table plus the
overall score (correct predictions / total queries).
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def parse_frontmatter_description(skill_path: Path) -> str:
    md = (skill_path / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^description:\s*(.+)$", md, flags=re.MULTILINE)
    if not m:
        print("error: no `description:` line in SKILL.md frontmatter", file=sys.stderr)
        sys.exit(2)
    return m.group(1).strip()


def make_temp_skill(description: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="skill-trigger-"))
    sk = tmp / "SKILL.md"
    sk.write_text(f"---\nname: trigger-test-skill\ndescription: {description}\n---\n\n# Trigger test skill\n\nFollow these instructions when the task matches.\n", encoding="utf-8")
    return tmp


def run_query(query: str, skill_tmp: Path, model: str | None, pi: str, max_seconds: int, extra_args: str) -> tuple[bool, str]:
    cmd = [pi, "-p", "--mode", "json", "--no-session", "--no-extensions", "--no-context-files", "--no-skills",
           "--skill", str(skill_tmp)]
    if model:
        cmd += ["--model", model]
    if extra_args:
        cmd += extra_args.split()
    cmd += [query]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=max_seconds)
    except subprocess.TimeoutExpired:
        return False, f"timeout after {max_seconds}s"
    triggered = False
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "message_update":
            continue
        ae = ev.get("assistantMessageEvent") or {}
        if ae.get("type") != "toolcall_end":
            continue
        tc = ae.get("toolCall") or {}
        if tc.get("name") == "read" and "SKILL.md" in json.dumps(tc.get("arguments") or {}):
            triggered = True
    return triggered, ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--eval-set", required=True, help="triggers.json: [{'query', 'should_trigger'}]")
    ap.add_argument("--skill-path", required=True, help="real skill dir (only read for the default description)")
    ap.add_argument("--description", default=None, help="candidate description; default: from SKILL.md")
    ap.add_argument("--runs", type=int, default=1, help="repetitions per query for reliability (costs tokens)")
    ap.add_argument("--jobs", type=int, default=4, help="parallel queries")
    ap.add_argument("--model", default=None)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--pi", default="pi")
    ap.add_argument("--extra-args", default="", help="additional pi flags")
    ap.add_argument("--max-seconds", type=int, default=120)
    args = ap.parse_args()

    try:
        evalset = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read eval set: {exc}", file=sys.stderr)
        return 2
    if not isinstance(evalset, list) or not all(isinstance(e, dict) and "query" in e and "should_trigger" in e for e in evalset):
        print("error: eval set must be [{'query', 'should_trigger'}, ...]", file=sys.stderr)
        return 2

    description = args.description or parse_frontmatter_description(Path(args.skill_path))
    skill_tmp = make_temp_skill(description)
    print(f"description ({len(description)} chars): {description[:140]}{'…' if len(description) > 140 else ''}")

    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = []
        for item in evalset:
            for run in range(args.runs):
                futures.append((item, run, pool.submit(run_query, item["query"], skill_tmp, args.model, args.pi, args.max_seconds, args.extra_args)))
        for item, run, fut in futures:
            triggered, err = fut.result()
            results.append({
                "query": item["query"],
                "should_trigger": item["should_trigger"],
                "triggered": triggered,
                "correct": triggered == item["should_trigger"],
                "run": run,
                "error": err,
            })

    # Aggregate per query: majority of runs
    per_query = {}
    for r in results:
        pq = per_query.setdefault(r["query"], {"query": r["query"], "should_trigger": r["should_trigger"], "triggered": 0, "runs": 0})
        pq["triggered"] += 1 if r["triggered"] else 0
        pq["runs"] += 1
    aggregated = []
    for pq in per_query.values():
        triggered = pq["triggered"] >= (pq["runs"] + 1) // 2  # majority
        aggregated.append({"query": pq["query"], "should_trigger": pq["should_trigger"],
                           "triggered": triggered, "correct": triggered == pq["should_trigger"], "runs": pq["runs"]})

    tp = sum(1 for r in aggregated if r["correct"] and r["should_trigger"])
    tn = sum(1 for r in aggregated if r["correct"] and not r["should_trigger"])
    fp = sum(1 for r in aggregated if not r["correct"] and not r["should_trigger"])
    fn = sum(1 for r in aggregated if not r["correct"] and r["should_trigger"])
    score = round((tp + tn) / len(aggregated), 4) if aggregated else 0.0

    print(f"\nscore: {score:.2f} ({tp + tn}/{len(aggregated)})  "
          f"TP={tp} TN={tn} FP={fp} FN={fn}\n")
    for r in aggregated:
        mark = "✓" if r["correct"] else "✗"
        expected = "trigger" if r["should_trigger"] else "no-trigger"
        got = "triggered" if r["triggered"] else "not triggered"
        print(f"  {mark} [{expected:>11}] {got:>12}  {r['query'][:90]}")

    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        payload = {"description": description, "model": args.model, "results": aggregated,
                   "score": score, "true_positives": tp, "true_negatives": tn,
                   "false_positives": fp, "false_negatives": fn}
        (out / "trigger_results.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nwrote {out / 'trigger_results.json'}")
    shutil.rmtree(skill_tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
