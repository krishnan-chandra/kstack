---
name: swarm
description: "Fan out N parallel workers across different slices of a task, drain them, and return one consolidated report. Use for /swarm, 'swarm this', parallel coverage checks, races, gauntlets, and exploration across packages, modules, or independent work items."
compatibility: Pi running inside Herdr with the Herdr Pi integration installed.
---

# Swarm

Fan out N parallel workers in a dedicated Herdr tab. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Guard and resolve paths

1. Run `test "${HERDR_ENV:-}" = 1`. Stop and explain that this skill requires a Pi session inside Herdr if the check fails.
2. Resolve this skill directory from the absolute path used to load `SKILL.md`. Set `KSTACK` to the directory two levels above it.
3. Never split or focus the user's pane. Hosted agents run in their own tab created by the fan-out tool.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Configuration

Read `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`) for model assignments. The `swarm` section:

```json
{
  "swarm": {
    "worker": { "model": "anthropic/claude-haiku-4", "thinking": "low" },
    "maxConcurrency": 4
  }
}
```

- `worker` — default model for swarm workers (`model` in `provider/model` form, optional `thinking` level).
- `maxConcurrency` — max parallel workers (default 4).

When `kstack.json` is absent or has no `swarm` section, ask the user which model to use or default to a fast available model.

## Phase A: Frame

1. **State the done predicate** and the artifact or report the swarm must return.
2. **Choose the shape:**
   - **Partition** — split the work into non-overlapping slices (e.g. one package per worker, one file set per worker).
   - **Race** — N workers run identical briefs. Declare the selection rule up front: `first pass` (take the first success), `rank all` (score every result), or `best-of` (pick the single best).
   - **Mix** — partition some slices and race others.
3. **Set N** from the user request or derive it from the shape (e.g. one worker per package directory).
4. **Pick the worker model.** Use `worker` from `kstack.json` when present. Otherwise default to a fast available model for coverage work. For a model race, name each arm’s model up front.
5. **Give each worker its own writable output** when it writes. Use a branch, directory under `/tmp/swarm-<slug>/worker-<n>/`, or a subdirectory of the workspace. Workers must not share a write target. When workers only inspect or analyze, keep them read-only.

## Phase B: Fan out

Spawn all N workers in parallel using `cli.mjs fanout`.

Write one prompt file per worker under `/tmp/swarm-<run-id>/prompts/worker-<n>.md`.
**Every brief stands alone.** Include:
- The goal and scope
- The exact slice or race arm
- How to verify the result
- What to report: use `PASS`, `ISSUES`, or `BLOCKED` with evidence

Compose a spec JSON file at `/tmp/swarm-<run-id>/spec.json`:

```json
{
  "owner": "swarm",
  "label": "<run-id>",
  "cwd": "<repo-root>",
  "tasks": [
    {
      "label": "worker-1",
      "model": "<worker-model>",
      "cwd": "<worker-cwd>",
      "promptFile": "/tmp/swarm-<run-id>/prompts/worker-1.md",
      "outputFile": "/tmp/swarm-<run-id>/outputs/worker-1.md",
      "access": "read-only",
      "tools": ["read", "grep", "find", "ls"],
      "noContextFiles": true,
      "timeoutMinutes": 15
    }
  ],
  "maxConcurrency": 4
}
```

Use `access: "read-only"` with `tools: ["read", "grep", "find", "ls"]` unless a worker must write files to its own isolated target directory.

Launch the swarm:

```sh
node "$KSTACK/extensions/shared/herdr/cli.mjs" fanout \
  --spec "/tmp/swarm-<run-id>/spec.json" \
  --out "/tmp/swarm-<run-id>/result.json"
```

Watch workers in the `swarm: <run-id>` tab. You or the user can inspect progress and steer any worker directly in its pane.

Read `/tmp/swarm-<run-id>/result.json` and the output files. If a worker drops out, proceed with N−1 and note the dropout.

## Phase C: Aggregate

Read the terminal results from all workers.

- **For coverage (partition):** every required slice needs a result. Identify gaps.
- **For a race:** apply the selection rule declared in Phase A (`first pass`, `rank all`, or `best-of`). Do not change the rule after seeing results.

Build:
- A compact result table (one row per worker: slice/arm, status, key finding)
- One-line evidenced issues (not raw dumps)
- Explicit gaps or dropouts

Do not paste raw worker output into the report. Synthesize.

## Phase D: Report

Return one consolidated in-chat report containing:

1. **Summary** — one sentence: what was checked, how many workers, overall result.
2. **Result table** — one row per worker with slice, status (`PASS`/`ISSUES`/`BLOCKED`), and key finding.
3. **Issues** — one-liner per issue with evidence (file, line, error message).
4. **Gaps** — slices with no result, worker dropouts, or incomplete coverage.
5. **Race rule** — when used, which rule was applied and which candidate won.

The report is the deliverable. Keep it scannable. A reader should know the overall health in 10 seconds and find any specific issue in under a minute.
