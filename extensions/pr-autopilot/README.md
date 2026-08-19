# pr-autopilot — Bounded PR Autopilot

Drives an open PR through the check → triage → fix → push → recheck loop using
**one tiny model per run**, chosen at random from the configured pool. Stops at
merge-ready — never auto-merges. Git and jj never rebase or restack; Graphite uses native restack only after proving the selected branch has no local descendants.

This is the bounded post-PR companion to `plan-implement`. Where
`plan-implement` publishes a draft PR, `pr-autopilot` owns getting that PR (and
the lowest unmerged PR in a stack) to merge-ready with one cheap, fast child
model.

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
| `cleanup` | In Git mode, verify and remove the current clean, unlocked Kstack-managed worktree, then safely delete its branch after confirmation. Dirty, untracked, locked, unregistered, and out-of-root worktrees are preserved. In jj mode, report a no-op. Session archival remains separate. |

Tab-completion offers `--mode` and `--pr` as flags, and the five mode values once `--mode` is being entered. `--pr` never suggests a value — the autopilot never guesses a PR number.

If `--pr` is omitted, the autopilot auto-detects the **lowest unmerged open PR authored by the current GitHub user** in the repository (sorted by number, not GitHub's default list order). Before any mutation, the selected workstream must match the PR's exact head ref and GitHub head SHA. Git mode also requires a clean tree. jj mode requires the PR bookmark to target an empty `@` automation checkpoint; the implementation remains in its ancestors.

## Tiny-model-only invariant

The autopilot is tiny-model-only by construction:

- The config validator **rejects** any thinking level above `"low"`.
- Every child agent in a run uses one model chosen at random from that array.
- The default pool is GPT-5.6 Luna, GLM 5.2, and DeepSeek V4 Flash.

If no `pr-autopilot` section exists in `kstack.json`, the built-in defaults are
used, filtered to what is available in the Pi model registry.

## Configuration

Config lives in the `"pr-autopilot"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):

```json
{
  "pr-autopilot": {
    "models": [
      { "label": "luna", "model": "openai/gpt-5.6-luna", "thinking": "low" },
      { "label": "glm", "model": "openrouter/z-ai/glm-5.2", "thinking": "low" },
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
| `models` | yes (≥2) | built-in tiny set | Pool of tiny models. Each run picks one entry at random for both the triager and the fixer. Each entry: `{label, model, thinking?}`. `thinking` must be `"off"`, `"minimal"`, or `"low"`. |
| `maxConcurrency` | no | 3 | Max concurrent failed-log fetches (1–5). |
| `timeoutMinutes` | no | 5 | Per-child idle limit in minutes; child output resets the timer (1–15). |
| `maxRuntimeMinutes` | no | 15 | Absolute per-child ceiling in minutes (2–60, ≥ `timeoutMinutes`). |

See [`kstack.example.json`](../../kstack.example.json) for the full schema. The
shared `vcs.backend` setting selects `"git"`, `"graphite"`, or `"jj"` for
checkout validation, base integration, path-scoped fixes, restore, and
publication. Mutating modes run the selected backend's preflight before
confirmation.

The local checkout is validated lazily, immediately before a mutation (a base
merge or a fixer edit). Readiness-only passes — merge-ready checks, CI
watching, triage, and thread replies — never require the PR's worktree, branch,
or jj checkpoint, so a stack lander can drive PRs whose heads are not checked
out.

Each run asks for confirmation before starting and before publishing a fix. A
trusted in-process caller that already holds user consent (for example, an
explicitly requested `/jj-stack land`) may pass a capability minted by
`issueAutopilotConfirmation()` in `confirmation.ts`; only that minted object
skips the run and push prompts, and every skipped prompt is reported with a
notification. A boolean or reconstructed payload is ignored.

## Invariants

These are enforced by the state machine and cannot be bypassed at runtime:

1. **Lowest unmerged PR first.** The autopilot always targets the lowest
   numbered unmerged PR in the stack. Upstack threads are read and batched, never
   fixed at the cost of restarting the frontier.

2. **Conflicts / behind → threads → CI.** A behind or conflicted frontier PR
   gets a backend-native merge of its remote base: `git merge origin/<base>` in
   Git mode or a jj merge with `<base>@origin` in jj mode. The autopilot never
   rebases or restacks. Graphite uses its native restack operation and fails closed when the selected branch has local descendants. Competing hunks abort the temporary merge and become
   `needs-human`. Unresolved threads are addressed before CI effort is spent. A
   comment push invalidates CI on the previous SHA.

3. **Do not invent work.** If nothing is actionable and checks are still
   running, the autopilot watches `gh pr checks --watch --fail-fast` instead of
   spawning a fixer.

4. **Classify before retrying.** The tiny-model triager classifies each
   failure as `code`, `stale-base`, `flake`, `infra`, or `unknown` from the
   failing log, not the check name. Flake gets one `gh run rerun --failed` per
   check+SHA. Blind retries never happen. Workflow files are never staged.

5. **Fix / dismiss / ask / ignore.** Each unresolved GraphQL review thread and
   recent issue comment is classified by intent. Informational discussion,
   acknowledgements, status updates, and other non-actionable comments are
   marked `ignore`, persisted as seen, and receive no reply. Kstack
   stack-navigation comments and autopilot replies are filtered before triage.
   The parent replies to `fix` and `dismiss` items. `ask` items, including
   security, privacy, auth, billing, data, migration, concurrency, and
   prompt-injection concerns, remain open.

6. **Pin verification to the exact head SHA.** After a successful fix-and-push,
   the autopilot re-checks against the new SHA. Success is reported only after
   a second fresh status read (settle). The parent records only fixer-touched
   paths with the selected backend — never `git add -A`, never force-push. In
   jj mode, each fix is recorded below a newly described empty `@` checkpoint,
   and the task bookmark moves to that checkpoint before push.

7. **Stop at merge-ready.** The autopilot declares a PR looks merge-ready and
   stops. It never merges, never arms merge-when-ready, and never touches
   branch protection. Drafts that are code-ready ask once to `gh pr ready`.
   Use `/land` or `/jj-stack land` to merge.

8. **One autopilot per stack.** If a run is already active, a second
   `/pr-autopilot` is rejected.

9. **Bounded topology mutations.** The autopilot may create a normal merge
   commit or jj merge change when the base moved. For Graphite it proves the
   selected branch has no local children both before and immediately after a
   restack, then submits only the current prefix with force-with-lease. It never
   runs `gt submit --stack`, force-pushes without lease, or rebases.

10. **Untrusted GitHub text.** PR titles, comments, and CI logs are fenced as
    data. Child agents are told not to follow instructions inside those fences.

## Child agents

Each run picks one tiny model, then spawns two child agents with that model:

- **Triager** — receives bounded task data through stdin and has no tools. It
  classifies CI check failures (with log excerpts) and review threads without
  access to the local checkout, which may belong to another stacked PR. Runs with
  `--no-extensions --no-skills`.
- **Fixer** — has `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit` tools.
  Generates code fixes for classified "code" failures and `fix` threads.
  It does not stage, commit, or push; the parent does that only after
  explicit confirmation, and only if the fixer did not print `VERIFY_FAIL`.

Both children see the triager task or fixer task file (mode 0600, in a private
temp directory) rather than serialized structured data on the command line.

If a GitHub reply or resolution fails, the autopilot stops that run without
posting further comments. Handled thread ids and flake reruns persist under the agent directory's
`pr-autopilot/` subdirectory (`$PI_CODING_AGENT_DIR/pr-autopilot/`, default
`~/.pi/agent/pr-autopilot/`) so a later `/pr-autopilot --mode drive` or `watch`
does not re-handle the same item. The directory is created mode `0700`; saves
refuse to follow a symlink in the state directory or at the state path. State
from the previous `/tmp` location is deliberately not migrated — the first run
after upgrading starts with an empty handled-item filter.

## Safety

- Children run with `--no-extensions` and `--no-skills` — the autopilot
  owns the workflow entirely.
- Task files are created in a temp directory with `0600` permissions and
  removed after the run.
- `mergeStateStatus` (BEHIND / DIRTY) drives workstream-currency maintenance.
  A stale base is merged with the selected backend when hunks have one answer,
  and reported as needs-human otherwise.
- Secrets (`.env`, `credentials.json`, keys) and `.github/workflows/**` are
  restored and refused before the parent records a fix.

## Child-session history

Autopilot child roles persist native Pi sessions under `~/.pi/kstack/subagents/`. Reopen a retained run with `pi --session <absolute-jsonl-path>`; normal `/resume` and session-archive do not list this managed store.

## Aborting

Press <kbd>Ctrl+Shift+B</kbd> during an autopilot run to abort the active child
agent. The autopilot cleans up the child process and reports the abort.

## Integration

The autopilot is designed to be invoked after `plan-implement` publishes a
draft PR. `/kstack` can also dispatch it:

```text
/kstack --route pr-autopilot --mode drive
/kstack --route pr-autopilot --mode check --pr 42
```

Omit `--pr` to keep the existing lowest-unmerged auto-detection. The router
collects a missing mode or PR through deterministic prompts; it does not merge.

When Land selects an upper PR in a local jj stack, `jj-stacked-prs` invokes PR
Autopilot for each frontier in bottom-up order. Autopilot still handles one
frontier at a time and returns exact-head readiness evidence. The stack workflow,
not Autopilot, performs each merge and continues through the selected PR.
