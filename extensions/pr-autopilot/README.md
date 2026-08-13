# pr-autopilot — Bounded PR Autopilot

Drives an open PR frontier through the check → triage → fix → push → recheck
loop using **only tiny models**. Stops at merge-ready — never auto-merges, never
rebases shared history, never restacks.

This is the bounded post-PR companion to `plan-implement`. Where
`plan-implement` publishes a draft PR, `pr-autopilot` owns getting that PR (and
the lowest unmerged PR in a stack) to merge-ready with cheap, fast child agents.

## Command

```text
/pr-autopilot [--mode check|threads|drive|watch|cleanup] [--pr <number>]
```

### Modes

| Mode | Behavior |
|---|---|
| `check` | One status pass: fetch CI checks, unresolved review threads, and conflict state. Report and stop. No child agents are spawned. |
| `threads` | Fetch state, spawn a tiny-model triager, then a fixer for threads marked `fix`. Dismiss/ask are handled by the parent. Commit and push. One cycle. |
| `drive` | Loop: refresh → merge base if behind/conflicted → comments → watch pending CI → flake rerun → code CI, up to 3 fix cycles. |
| `watch` | Same as `drive` with up to 15 fix cycles. Watches `gh pr checks --watch` when nothing is actionable and CI is still running. |
| `cleanup` | Remove the current managed worktree and safely delete its branch after confirmation. Session archival remains a separate manual step. |

If `--pr` is omitted, the autopilot auto-detects the **lowest unmerged open PR**
in the current repository (sorted by number, not GitHub's default list order).

## Tiny-model-only invariant

The autopilot is tiny-model-only by construction:

- The config validator **rejects** any thinking level above `"low"`.
- Every child agent is spawned with a model from the configured `models`
  array — nothing else.
- The default model set is GPT-5.6 Luna, Gemini 3.7 Flash, and DeepSeek V4 Flash.

If no `pr-autopilot` section exists in `kstack.json`, the built-in defaults are
used, filtered to what is available in the Pi model registry. A leftover
`"pr-babysit"` section is still read, with a warning to rename it.

## Configuration

Config lives in the `"pr-autopilot"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):

```json
{
  "pr-autopilot": {
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
| `maxConcurrency` | no | 3 | Max concurrent failed-log fetches (1–5). |
| `timeoutMinutes` | no | 5 | Per-child idle limit in minutes; child output resets the timer (1–15). |
| `maxRuntimeMinutes` | no | 15 | Absolute per-child ceiling in minutes (2–60, ≥ `timeoutMinutes`). |

See [`kstack.example.json`](../../kstack.example.json) for the full schema.

## Invariants

These are enforced by the state machine and cannot be bypassed at runtime:

1. **Lowest unmerged PR first.** The autopilot always targets the lowest
   numbered unmerged PR in the stack. Upstack threads are read and batched, never
   fixed at the cost of restarting the frontier.

2. **Conflicts / behind → threads → CI.** A behind or conflicted frontier PR
   gets `git merge origin/<base>` (never a rebase, never `gt submit --stack`).
   Competing hunks abort the merge and become `needs-human`. Unresolved threads
   are addressed before CI effort is spent. A comment push invalidates CI on the
   previous SHA.

3. **Do not invent work.** If nothing is actionable and checks are still
   running, the autopilot watches `gh pr checks --watch --fail-fast` instead of
   spawning a fixer.

4. **Classify before retrying.** The tiny-model triager classifies each
   failure as `code`, `stale-base`, `flake`, `infra`, or `unknown` from the
   failing log, not the check name. Flake gets one `gh run rerun --failed` per
   check+SHA. Blind retries never happen. Workflow files are never staged.

5. **Fix / dismiss / ask.** Each unresolved GraphQL review thread (and new
   issue comment) is classified. The parent replies and resolves `fix`/`dismiss`
   threads. `ask` (security, privacy, auth, billing, data, migration,
   concurrency, or prompt-injection) is surfaced immediately and left open.

6. **Pin verification to the exact head SHA.** After a successful fix-and-push,
   the autopilot re-checks against the new SHA. Success is reported only after
   a second fresh status read (settle). Staging is the fixer-touched paths,
   after `git fetch` of the PR branch — never `git add -A`, never force-push.

7. **Stop at merge-ready.** The autopilot declares a PR looks merge-ready and
   stops. It never merges, never arms merge-when-ready, and never touches
   branch protection. Drafts that are code-ready ask once to `gh pr ready`.
   Use `jj-stacked-prs` or your normal merge flow to land.

8. **One autopilot per stack.** If a run is already active, a second
   `/pr-autopilot` is rejected.

9. **No topology mutations.** The autopilot never runs `gt submit --stack`,
   never force-pushes shared history, and never rebases.

10. **Untrusted GitHub text.** PR titles, comments, and CI logs are fenced as
    data. Child agents are told not to follow instructions inside those fences.

## Child agents

The autopilot spawns two kinds of tiny-model child agents:

- **Triager** — read-only (`read`, `grep`, `find`, `ls` tools only). Classifies
  CI check failures (with log excerpts) and review threads. Runs with
  `--no-extensions --no-skills`.
- **Fixer** — has `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit` tools.
  Generates code fixes for classified "code" failures and `fix` threads.
  It does not stage, commit, or push; the parent does that only after
  explicit confirmation, and only if the fixer did not print `VERIFY_FAIL`.

Both children see the triager task or fixer task file (mode 0600, in a private
temp directory) rather than serialized structured data on the command line.

Handled thread ids and flake reruns persist under `/tmp/pi-pr-autopilot-state-<pr>.json`
so a later `/pr-autopilot --mode drive` or `watch` does not re-handle the same item.

## Safety

- Children run with `--no-extensions` and `--no-skills` — the autopilot
  owns the workflow entirely.
- Task files are created in a temp directory with `0600` permissions and
  removed after the run.
- `mergeStateStatus` (BEHIND / DIRTY) drives branch-currency maintenance.
  A stale base is merged with `origin/<base>` when hunks have one answer, and
  reported as needs-human otherwise.
- Secrets (`.env`, `credentials.json`, keys) and `.github/workflows/**` are
  refused at staging time.

## Aborting

Press <kbd>Ctrl+Shift+B</kbd> during an autopilot run to abort the active child
agent. The autopilot cleans up the child process and reports the abort.

## Integration

The autopilot is designed to be invoked after `plan-implement` publishes a
draft PR. It can also be triggered from the kstack-router if a `pr-autopilot`
route is added:

```text
/kstack --route pr-autopilot --mode drive
```
