#!/usr/bin/env python3
"""Aggregate run results into benchmark summary statistics for one iteration.

Usage:
  python3 aggregate_benchmark.py <iteration-dir> [--skill-name <name>]

Layout (see references/schemas.md for field details):

    <iteration-dir>/
    └── eval-<name>/
        ├── eval_metadata.json
        ├── with_skill/            (or old_skill/)
        │   ├── grading.json
        │   ├── timing.json
        │   └── outputs/...
        └── without_skill/
            ├── grading.json
            └── timing.json

Multiple runs per configuration are supported as run-N/ subdirectories inside
the config dir; if none exist, the config dir itself is one run.

Writes benchmark.json and benchmark.md into <iteration-dir>. Put each
with_skill (or old_skill) version before its baseline in both outputs.
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path


def stats(values: list[float]) -> dict:
    if not values:
        return {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0}
    n = len(values)
    mean = sum(values) / n
    stddev = math.sqrt(sum((x - mean) ** 2 for x in values) / (n - 1)) if n > 1 else 0.0
    return {"mean": round(mean, 4), "stddev": round(stddev, 4),
            "min": round(min(values), 4), "max": round(max(values), 4)}


def fmt(v: float) -> str:
    return f"{v:+.2f}" if abs(v) < 10 else f"{v:+,.0f}"


def iter_runs(config_dir: Path) -> list[Path]:
    """Return run dirs: run-N subdirs if present, else the config dir itself."""
    runs = sorted(config_dir.glob("run-*"))
    return runs if runs else [config_dir]


def load_run(run_dir: Path) -> dict | None:
    grading_path = run_dir / "grading.json"
    timing_path = run_dir / "timing.json"
    if not grading_path.exists():
        print(f"warning: no grading.json in {run_dir}", file=sys.stderr)
        return None
    grading = json.loads(grading_path.read_text(encoding="utf-8"))
    summary = grading.get("summary", {})
    timing = {}
    if timing_path.exists():
        timing = json.loads(timing_path.read_text(encoding="utf-8"))
    return {
        "pass_rate": summary.get("pass_rate", 0.0),
        "passed": summary.get("passed", 0),
        "failed": summary.get("failed", 0),
        "total": summary.get("total", 0),
        "time_seconds": round(timing.get("duration_ms", 0) / 1000, 1),
        "tokens": timing.get("total_tokens", 0),
        "expectations": grading.get("expectations", []),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("iteration_dir", help="iteration directory containing eval-* dirs")
    ap.add_argument("--skill-name", default=None)
    args = ap.parse_args()

    root = Path(args.iteration_dir)
    eval_dirs = sorted(root.glob("eval-*"))
    if not eval_dirs:
        print(f"error: no eval-* directories in {root}", file=sys.stderr)
        return 2

    runs_out: list[dict] = []
    per_config: dict[str, list[dict]] = {}
    eval_names: list[str] = []

    for edir in eval_dirs:
        meta_path = edir / "eval_metadata.json"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        eval_id = meta.get("eval_id", len(runs_out))
        eval_name = meta.get("eval_name", edir.name.removeprefix("eval-"))
        eval_names.append(eval_name)

        for config in sorted(p.name for p in edir.iterdir() if p.is_dir() and p.name != "work"):
            for run_dir in iter_runs(edir / config):
                run = load_run(run_dir)
                if run is None:
                    continue
                run["eval_id"] = eval_id
                run["eval_name"] = eval_name
                run["configuration"] = config
                runs_out.append(run)
                per_config.setdefault(config, []).append(run)

    if not runs_out:
        print("error: no graded runs found", file=sys.stderr)
        return 2

    # Order: put with_skill/old_skill before without_skill; keep config order otherwise
    def config_key(c: str) -> tuple:
        return (0 if c in ("with_skill", "old_skill") else 1, c)

    run_summary: dict = {}
    for config, runs in per_config.items():
        run_summary[config] = {
            "pass_rate": stats([r["pass_rate"] for r in runs]),
            "time_seconds": stats([r["time_seconds"] for r in runs]),
            "tokens": stats([r["tokens"] for r in runs]),
        }

    ordered_configs = sorted(per_config, key=config_key)
    delta: dict = {}
    if len(ordered_configs) >= 2:
        a, b = ordered_configs[0], ordered_configs[1]
        for metric in ("pass_rate", "time_seconds", "tokens"):
            ma = run_summary[a][metric]["mean"]
            mb = run_summary[b][metric]["mean"]
            delta[metric] = fmt(ma - mb)
    run_summary["delta"] = delta

    benchmark = {
        "metadata": {
            "skill_name": args.skill_name or root.name,
            "workspace": str(root),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "evals_run": eval_names,
        },
        "runs": runs_out,
        "run_summary": run_summary,
        "notes": [],
    }
    (root / "benchmark.json").write_text(json.dumps(benchmark, indent=2), encoding="utf-8")

    lines = [f"# Benchmark: {benchmark['metadata']['skill_name']}",
             f"\nIteration workspace: `{root}`\n",
             "\n| Configuration | pass rate | time (s) | tokens |",
             "| --- | --- | --- | --- |"]
    for config in ordered_configs:
        s = run_summary[config]
        lines.append(f"| {config} | {s['pass_rate']['mean']:.2f} ± {s['pass_rate']['stddev']:.2f} "
                     f"| {s['time_seconds']['mean']:.1f} ± {s['time_seconds']['stddev']:.1f} "
                     f"| {s['tokens']['mean']:.0f} ± {s['tokens']['stddev']:.0f} |")
    if delta:
        lines.append("\n| delta | " + " | ".join(delta.values()) + " |")
    lines.append("\n## Per eval\n")
    for r in runs_out:
        lines.append(f"- eval-{r['eval_id']} **{r['eval_name']}** [{r['configuration']}]: "
                     f"{r['passed']}/{r['total']} passed, {r['time_seconds']}s, {r['tokens']} tokens")
    lines.append("\n## Analyst notes\n\n(fill in after reading the transcripts and benchmark data)")
    (root / "benchmark.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"wrote {root / 'benchmark.json'} and {root / 'benchmark.md'}")
    for config in ordered_configs:
        s = run_summary[config]
        print(f"  {config}: pass {s['pass_rate']['mean']:.2f}±{s['pass_rate']['stddev']:.2f} "
              f"time {s['time_seconds']['mean']:.1f}s tokens {s['tokens']['mean']:.0f}")
    if delta:
        print(f"  delta: pass {delta['pass_rate']} time {delta['time_seconds']}s tokens {delta['tokens']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
