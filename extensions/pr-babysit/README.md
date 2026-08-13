# pr-babysit — Bounded PR Babysitter

Drives an open PR frontier through the check → triage → fix → push → recheck
loop using **only tiny models**. Stops at merge-ready — never auto-merges, never
rebases shared history, never restacks.

This is the bounded post-PR companion to `plan-implement`. Where
`plan-implement` publishes a draft PR, `pr-babysit` owns getting that PR (and
the lowest unmerged PR in a stack) to merge-ready with cheap, fast child agents.

## Command

```text
/pr-babysit [--mode check|threads|drive|cleanup] [--pr <number>]
```

### Modes

| Mode | Behavior |
|---|---|
| `check` | One status pass: fetch CI checks, review threads, and conflict state. Report and stop. No child agents are spawned. |
| `threads` | Fetch state, spawn a tiny-model triager to classify review threads, then a tiny-model fixer to address fixable threads. Commit and push. One cycle. |
| `drive` | Loop: check → triage → fix → push → recheck, up to 3 cycles, until the PR is merge-ready or a hard blocker is hit. |
| `cleanup` | Remove the current managed worktree and safely delete its branch after confirmation. Session archival remains a separate manual step. |

If `--pr` is omitted, the babysitter auto-detects the **lowest unmerged open PR**
in the current repository.

## Tiny-model-only invariant

The babysitter is tiny-model-only by construction:

- The config validator **rejects** any thinking level above `"low"`.
- Every child agent is spawned with a model from the configured `models`
  array — nothing else.
- The default model set is GPT-5.6 Luna, Gemini 3.7 Flash, and DeepSeek V4 Flash.

If no `pr-babysit` section exists in `kstack.json`, the built-in defaults are
used, filtered to what is available in the Pi model registry.

## Configuration

Config lives in the `"pr-babysit"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):

```json
{
  "pr-babysit": {
    "models": [
      { "label": "luna", "model": "openai/gpt-5.6-luna", "thinking": "low" },
      { "label": "gemini", "model": "openrouter/google/gemini-3.7-flash", "thinking": "low" },
      { "label": "deepseek", "model": "openrouter/deepseek/deepseek-v4-flash", "thinking": "low" }
    ],
    "maxConcurrency": 3,
    "timeoutMinutes": 5,
    "maxRuntimeMinutes": 15
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `models` | yes (≥2) | built-in tiny set | Tiny models for child agents. Each entry: `{label, model, thinking?}`. `thinking` must be `"off"`, `"minimal"`, or `"low"`. |
| `maxConcurrency` | no | 3 | Max concurrent tiny-model children (1–5). |
| `timeoutMinutes` | no | 5 | Per-child idle limit in minutes; child output resets the timer (1–15). |
| `maxRuntimeMinutes` | no | 15 | Absolute per-child ceiling in minutes (2–60, ≥ `timeoutMinutes`). |

See [`kstack.example.json`](../../kstack.example.json) for the full schema.

## Invariants

These are enforced by the state machine and cannot be bypassed at runtime:

1. **Lowest unmerged PR first.** The babysitter always targets the lowest
   unmerged PR in the stack. Upstack threads are read and batched, never
   fixed at the cost of restarting the frontier.

2. **Conflicts → threads → CI.** Conflicts are reported (not resolved).
   Review threads are addressed before CI effort is spent.

3. **Classify before retrying.** The tiny-model triager classifies each
   failure as `code`, `stale-base`, `flake`, `infra`, or `unknown` before any
   fix or retrigger. Blind retries never happen.

4. **Pin verification to the exact head SHA.** After a successful fix-and-push,
   the babysitter re-checks against the new SHA. Verification pinned to a
   previous SHA is invalidated after any push.

5. **Stop at merge-ready.** The babysitter declares a PR merge-ready and
   stops. It never merges, never arms merge-when-ready, and never touches
   branch protection. Use `jj-stacked-prs` or your normal merge flow to land.

6. **One babysitter per stack.** If a run is already active, a second
   `/pr-babysit` is rejected.

7. **No topology mutations.** The babysitter never runs `gt submit --stack`,
   never force-pushes shared history, and never rebases.

## Child agents

The babysitter spawns two kinds of tiny-model child agents:

- **Triager** — read-only (`read`, `grep`, `find`, `ls` tools only). Classifies
  CI check failures and review threads. Runs with `--no-extensions --no-skills`.
- **Fixer** — has `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit` tools.
  Generates code fixes for classified "code" failures and fixable review
  threads. It does not stage, commit, or push; the parent does that only after
  explicit confirmation.

Both children see the triager task or fixer task file (mode 0600, in a private
temp directory) rather than serialized structured data on the command line.

## Safety

- Children run with `--no-extensions` and `--no-skills` — the babysitter
  owns the workflow entirely.
- Task files are created in a temp directory with `0600` permissions and
  removed after the run.
- The `checkStaleBase` and `checkConflicts` helpers classify failures before
  any retrigger is attempted.
- A stale base is reported as "report to the owner — do not auto-fix," never
  silently rebased.

## Aborting

Press <kbd>Ctrl+Shift+B</kbd> during a babysit run to abort the active child
agent. The babysitter cleans up the child process and reports the abort.

## Integration

The babysitter is designed to be invoked after `plan-implement` publishes a
draft PR. It can also be triggered from the kstack-router if a `pr-babysit`
route is added:

```text
/kstack --route pr-babysit --mode drive
```
