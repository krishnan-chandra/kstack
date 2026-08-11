#!/usr/bin/env python3
"""Grade a run's outputs against machine-checkable assertions.

Usage:
  python3 grade.py <run-dir> --metadata <eval_metadata.json>

Reads the eval's assertions (see references/schemas.md for the `check`
types), grades each assertion that has a `check` block against the run's
`outputs/` directory, and writes <run-dir>/grading.json with exactly:

    {"expectations": [{"text", "passed", "evidence"}, ...], "summary": {...}}

Assertions without a `check` are written with "passed": null and "checkable":
false so the caller knows they still need model judgment. Re-running
overwrites grading.json; the summary is recomputed from the expectations
array, so append model-judged expectations and re-run to refresh it.

Exit code 0 always (grading failures are recorded in the JSON, not the exit
code); nonzero only for usage errors.
"""

import argparse
import json
import re
import sys
from pathlib import Path

CHECKERS = {
    "file_exists": lambda o, c: (o / c["path"]).is_file(),
    "dir_exists": lambda o, c: (o / c["path"]).is_dir(),
    "file_contains": lambda o, c: c["needle"] in (o / c["path"]).read_text(encoding="utf-8", errors="replace"),
    "file_matches": lambda o, c: re.search(c["pattern"], (o / c["path"]).read_text(encoding="utf-8", errors="replace")) is not None,
    "file_matches_count": lambda o, c: len(re.findall(c["pattern"], (o / c["path"]).read_text(encoding="utf-8", errors="replace"))) == c["count"],
    "line_count_at_least": lambda o, c: len((o / c["path"]).read_text(encoding="utf-8", errors="replace").splitlines()) >= c["count"],
    "file_count_at_least": lambda o, c: len([p for p in (o / c["path"]).iterdir()]) >= c["count"],
}

# Human-readable evidence for each check type, called with (outputs_dir, check)
EVIDENCE = {
    "file_exists": lambda o, c: f"{c['path']} exists" if (o / c["path"]).is_file() else f"{c['path']} not found",
    "dir_exists": lambda o, c: f"dir {c['path']} exists" if (o / c["path"]).is_dir() else f"dir {c['path']} not found",
    "file_contains": lambda o, c: f"found {c['needle']!r} in {c['path']}" if c["needle"] in (o / c["path"]).read_text(encoding="utf-8", errors="replace") else f"{c['needle']!r} not in {c['path']}",
    "file_matches": lambda o, c: f"{c['path']} matches {c['pattern']!r}" if re.search(c["pattern"], (o / c["path"]).read_text(encoding="utf-8", errors="replace")) else f"{c['path']} does not match {c['pattern']!r}",
    "file_matches_count": lambda o, c: f"{len(re.findall(c['pattern'], (o / c['path']).read_text(encoding='utf-8', errors='replace')))} matches of {c['pattern']!r} in {c['path']}",
    "line_count_at_least": lambda o, c: f"{len((o / c['path']).read_text(encoding='utf-8', errors='replace').splitlines())} lines in {c['path']}",
    "file_count_at_least": lambda o, c: f"{len([p for p in (o / c['path']).iterdir()])} entries in {c['path']}",
}


def safe(checker, evidence, outputs: Path, check: dict) -> tuple[bool, str]:
    """Run a checker, converting missing files and malformed checks into failures."""
    try:
        return bool(checker(outputs, check)), evidence(outputs, check)
    except FileNotFoundError:
        return False, f"{check.get('path', '?')} not found"
    except (KeyError, TypeError, re.error) as exc:
        return False, f"bad check definition: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run_dir", help="run directory containing outputs/")
    ap.add_argument("--metadata", required=True, help="eval_metadata.json with assertions")
    args = ap.parse_args()

    run_dir = Path(args.run_dir)
    outputs = run_dir / "outputs"
    if not outputs.is_dir():
        print(f"error: no outputs/ directory in {run_dir}", file=sys.stderr)
        return 2
    try:
        meta = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read metadata: {exc}", file=sys.stderr)
        return 2

    expectations = []
    for a in meta.get("assertions", []):
        text = a["text"]
        check = a.get("check")
        if not isinstance(check, dict):
            expectations.append({"text": text, "passed": None, "evidence": None, "checkable": False})
            continue
        ctype = check.get("type")
        if ctype not in CHECKERS:
            expectations.append({"text": text, "passed": None, "evidence": f"unknown check type {ctype!r}", "checkable": False})
            continue
        passed, evidence = safe(CHECKERS[ctype], EVIDENCE[ctype], outputs, check)
        expectations.append({"text": text, "passed": passed, "evidence": evidence, "checkable": True})

    passed = sum(1 for e in expectations if e["passed"] is True)
    failed = sum(1 for e in expectations if e["passed"] is False)
    total = passed + failed
    summary = {"passed": passed, "failed": failed, "total": total,
               "pass_rate": round(passed / total, 4) if total else 0.0,
               "pending_judgment": sum(1 for e in expectations if e["passed"] is None)}

    grading = {"expectations": expectations, "summary": summary}
    (run_dir / "grading.json").write_text(json.dumps(grading, indent=2), encoding="utf-8")
    print(f"graded {total} machine-checkable assertions "
          f"({passed} passed, {failed} failed), {summary['pending_judgment']} pending model judgment")
    return 0


if __name__ == "__main__":
    sys.exit(main())
