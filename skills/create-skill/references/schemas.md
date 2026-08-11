# JSON Schemas

Exact JSON structures used by the create-skill workflow and its scripts. The viewer and aggregator depend on these field names — do not rename them.

## evals.json

Durable registry of test cases for a skill. Located at `evals/evals.json` within the skill directory. Start with prompts only; add `assertions` after drafting them while the first runs are in flight.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "name": "descriptive-name",
      "prompt": "User's example prompt",
      "expected_output": "Description of expected result",
      "files": ["evals/files/sample1.csv"],
      "assertions": [
        {"text": "Creates report.md", "check": {"type": "file_exists", "path": "report.md"}}
      ]
    }
  ]
}
```

Fields:
- `skill_name`: matches the skill's frontmatter `name`
- `evals[].id`: unique integer
- `evals[].name`: short kebab-case name, used for the iteration directory (`eval-<name>`)
- `evals[].prompt`: the exact task text; save a copy to `<skill>/evals/<name>.txt` for the run scripts
- `evals[].expected_output`: human-readable success description
- `evals[].files`: optional input files, copied into each run's work directory
- `evals[].assertions`: optional; same shape as `eval_metadata.json` assertions

## eval_metadata.json

Per-test-case metadata, written into each `eval-<name>/` directory each iteration (do not assume it carries over). `assertions` start empty and are filled in Step 2 of the run sequence.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name",
  "prompt": "The user's task prompt",
  "assertions": [
    {
      "text": "The CSV has a header row and 12 data rows",
      "check": {"type": "line_count_at_least", "path": "data.csv", "count": 13}
    },
    {
      "text": "Uses the chart template from assets",
      "check": null
    }
  ]
}
```

Assertions with a `check` are graded by `scripts/grade.py`. `check` types (all paths relative to the run's `outputs/`):

| type | fields | passes when |
| --- | --- | --- |
| `file_exists` | `path` | the file exists |
| `dir_exists` | `path` | the directory exists |
| `file_contains` | `path`, `needle` | the file contains the substring |
| `file_matches` | `path`, `pattern` | the file matches the regex (`re.search`) |
| `file_matches_count` | `path`, `pattern`, `count` | the regex matches exactly `count` times |
| `line_count_at_least` | `path`, `count` | the file has at least `count` lines |
| `file_count_at_least` | `path`, `count` | the directory has at least `count` entries |

Assertions with `"check": null` (or no `check`) require model judgment; grade them yourself and append to `grading.json` with the same `text`/`passed`/`evidence` fields.

## grading.json

Output of grading, written to each run directory (`<run-dir>/grading.json`). The review page reads exactly `text`, `passed`, `evidence` — not `name`/`met`/`details`.

```json
{
  "expectations": [
    {"text": "Creates report.md", "passed": true, "evidence": "report.md exists (1284 bytes)"},
    {"text": "Uses the chart template", "passed": false, "evidence": "Output is plain text; no chart produced"}
  ],
  "summary": {"passed": 1, "failed": 1, "total": 2, "pass_rate": 0.5}
}
```

## timing.json

Written by `scripts/run_eval.py`; no manual capture needed.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3,
  "model": "anthropic/claude-sonnet-4",
  "provider": "openrouter",
  "triggered": true
}
```

- `triggered`: whether the model read the skill's SKILL.md during the run (with-skill runs only). `false` means a triggering problem, not a capability result.

## run_meta.json

Written by `scripts/run_eval.py` next to `timing.json`.

```json
{
  "prompt": "The exact prompt text",
  "config": "with_skill",
  "skill_path": "skills/example-skill",
  "work_dir": ".workspace/example-skill/iteration-1/eval-x/with_skill/work",
  "tool_calls": [{"name": "bash", "arguments": {"command": "ls"}}],
  "errors": []
}
```

## benchmark.json

Output of `scripts/aggregate_benchmark.py` into each iteration directory. The review page reads the `runs` and `run_summary` sections exactly.

```json
{
  "metadata": {
    "skill_name": "example-skill",
    "workspace": ".workspace/example-skill/iteration-1",
    "timestamp": "2026-01-15T10:30:00Z",
    "evals_run": ["descriptive-name", "other-eval"]
  },
  "runs": [
    {
      "eval_id": 1,
      "eval_name": "descriptive-name",
      "configuration": "with_skill",
      "result": {"pass_rate": 0.85, "passed": 6, "failed": 1, "total": 7, "time_seconds": 42.5, "tokens": 3800},
      "expectations": [{"text": "...", "passed": true, "evidence": "..."}]
    }
  ],
  "run_summary": {
    "with_skill": {
      "pass_rate": {"mean": 0.85, "stddev": 0.05, "min": 0.8, "max": 0.9},
      "time_seconds": {"mean": 45.0, "stddev": 12.0, "min": 32.0, "max": 58.0},
      "tokens": {"mean": 3800, "stddev": 400, "min": 3200, "max": 4100}
    },
    "without_skill": {
      "pass_rate": {"mean": 0.35, "stddev": 0.08, "min": 0.28, "max": 0.45},
      "time_seconds": {"mean": 32.0, "stddev": 8.0, "min": 24.0, "max": 42.0},
      "tokens": {"mean": 2100, "stddev": 300, "min": 1800, "max": 2500}
    },
    "delta": {"pass_rate": "+0.50", "time_seconds": "+13.0", "tokens": "+1700"}
  },
  "notes": [
    "Assertion X passes in both configurations - not discriminating",
    "Eval Y shows high variance - possibly flaky"
  ]
}
```

Configuration values are exactly `with_skill` / `without_skill` (or `old_skill` for baseline-against-snapshot); the page groups and color-codes by this string. `with_skill` must appear before its baseline in `runs` and in `run_summary`.

## Trigger eval set

Saved to `.workspace/<skill>/triggers.json`.

```json
[
  {"query": "my boss sent me this Q4 sales xlsx, add a profit margin column", "should_trigger": true},
  {"query": "write a fibonacci function", "should_trigger": false}
]
```

## Trigger results

Output of `scripts/run_trigger_eval.py` into `.workspace/<skill>/trigger-eval/`.

```json
{
  "description": "the exact description tested",
  "model": "anthropic/claude-sonnet-4",
  "results": [
    {"query": "...", "should_trigger": true, "triggered": true, "correct": true, "runs": 1}
  ],
  "score": 0.85,
  "true_positives": 8,
  "true_negatives": 9,
  "false_positives": 1,
  "false_negatives": 2
}
```
