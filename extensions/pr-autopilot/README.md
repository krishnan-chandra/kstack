# pr-autopilot — Bounded PR Autopilot

Drives an open PR through the check → triage → fix → push → recheck loop using
**one configured model per run**, chosen at random from the configured pool. Stops at
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
| `check` | Read state twice, including CI checks, unresolved review threads, and conflict state. Report and stop without polling or spawning a child. |
| `threads` | Fetch state, spawn a model triager, then a fixer for threads marked `fix`. Dismiss/ask are handled by the parent. Commit and push. One cycle. It performs the existing final settling read but does not poll mergeability. |
| `drive` | Loop: refresh → merge base if behind/conflicted → comments → watch pending CI → flake rerun → code CI, up to 3 fix cycles. Poll pending mergeability as described under [Readiness](#readiness). |
| `watch` | Same as `drive` with up to 15 fix cycles. Watches `gh pr checks --watch` when nothing is actionable and CI is still running, and uses the same bounded mergeability polling as `drive`. |
| `cleanup` | In Git mode, verify and remove the current clean, unlocked Kstack-managed worktree, then safely delete its branch after confirmation. Dirty, untracked, locked, unregistered, and out-of-root worktrees are preserved. In jj mode, report a no-op. Session archival remains separate. |

Tab-completion offers `--mode` and `--pr` as flags, and the five mode values once `--mode` is being entered. `--pr` never suggests a value — the autopilot never guesses a PR number.

If `--pr` is omitted, the autopilot auto-detects the **lowest unmerged open PR authored by the current GitHub user** in the repository (sorted by number, not GitHub's default list order). Before any mutation, the selected workstream must match the PR's exact head ref and GitHub head SHA. Git mode also requires a clean tree. jj mode requires the PR bookmark to target an empty `@` automation checkpoint; the implementation remains in its ancestors.

## Model pool

Every child agent in a run uses one model chosen at random from the configured
array. All Pi thinking levels are accepted; omitted thinking defaults to
`"low"`. The default pool is GPT-5.6 Luna, GLM 5.2, and DeepSeek V4 Flash.

If no `pr-autopilot` section exists in `kstack.json`, the complete built-in
pool is used. Explicitly configured model IDs are passed to child Pi processes
without checking Pi's bundled model registry, so provider models can be used
before the local catalog is updated. Invalid or unauthenticated IDs fail when
the child starts.

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
| `models` | yes (≥2) | built-in model set | Model pool. Each run picks one entry at random for both the triager and the fixer. Each entry is `{label, model, thinking?}` and accepts any supported Pi thinking level. |
| `maxConcurrency` | no | 3 | Max concurrent failed-log fetches (1–5). |
| `timeoutMinutes` | no | 5 | Per-child idle limit in minutes; child output resets the timer (1–15). |
| `maxRuntimeMinutes` | no | 15 | Absolute per-child ceiling in minutes (2–60, ≥ `timeoutMinutes`). |

See [`kstack.example.json`](../../kstack.example.json) for the full schema. The
shared `vcs.backend` setting selects `"git"`, `"graphite"`, or `"jj"` for
checkout validation, base integration, path-scoped fixes, restore, and
publication. Mutating modes run the selected backend's preflight before
confirmation. Before any standalone GitHub operation, Autopilot resolves the
repository once and scopes its PR and run commands to that `owner/name`. In jj
mode, it reads the GitHub `origin` with `jj git remote list`, so colocated,
non-colocated, and secondary workspaces use the same path. A missing, malformed,
duplicate, or non-GitHub `origin` blocks the run before confirmation. Cleanup
mode remains repository-independent.

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

4. **Classify before retrying.** The model triager classifies each
   failure as `code`, `stale-base`, `flake`, `infra`, or `unknown` from the
   failing log, not the check name. Flaky jobs share one `gh run rerun --failed`
   attempt per Actions run and exact head SHA. A check without an Actions run ID
   cannot trigger or consume a rerun. Blind retries never happen. Workflow files
   are never staged.

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
   jj mode, fixes are squashed from the working-copy child into the PR
   bookmark’s commit before push.

7. **Stop at merge-ready.** The autopilot declares a PR looks merge-ready and
   stops. It never merges, never arms merge-when-ready, and never touches
   branch protection. Drafts that are code-ready ask once to `gh pr ready`.
   After that transition, the same head-verification and mergeability rules
   apply. Use `/land` or `/jj-stack land` to merge.

8. **One autopilot per stack.** If a run is already active, a second
   `/pr-autopilot` is rejected.

9. **Bounded topology mutations.** The autopilot may create a normal merge
   commit or jj merge change when the base moved. For Graphite it proves the
   selected branch has no local children both before and immediately after a
   restack, then submits only the current prefix with force-with-lease. It never
   runs `gt submit --stack`, force-pushes without lease, or rebases.

10. **Untrusted GitHub text.** PR titles, check and review metadata, comments,
    and CI logs stay inside data fences. Prompts refer to checks and review
    items by local keys such as `check-1` and `thread-1`. The parent maps those
    keys back to the exact GitHub names and IDs before it acts.

## Readiness

A PR is merge-ready only when all of these conditions hold:

- The PR is open and not a draft.
- Two fresh observations verify the same head SHA.
- GitHub reports `mergeable` as `MERGEABLE`.
- `mergeStateStatus` is `CLEAN`, `HAS_HOOKS`, or `UNSTABLE`.
- All observed checks are successful, skipped, or neutral, and no review
  threads remain unresolved. `UNSTABLE` with no observed checks is not ready.

A PR with no CI checks is supported when `mergeStateStatus` is `CLEAN` or
`HAS_HOOKS`. Because GitHub CLI returns a nonzero exit code for an empty checks
collection, Autopilot accepts empty checks only when structured evidence from
the same `gh pr view` response that supplied the head SHA includes an empty
`statusCheckRollup` array. If rollup evidence is omitted, null, non-array, or
nonempty, a failed checks read remains a required-read failure. Successful `gh
pr checks` reads with malformed JSON, empty stdout, or non-array top-level data
similarly fail closed rather than masquerading as an empty checks collection.

Closed and merged PRs end as incomplete before Autopilot starts another child
or mutation. `UNKNOWN` mergeability is also incomplete; it is never treated as
a successful default.

`check` always performs its two independent reads and returns immediately.
`threads` can perform its existing settling read but does not poll. In `drive`
and `watch`, when an open, non-draft PR is otherwise code-ready and only
mergeability remains unknown, Autopilot makes at most five additional fresh
observations. It waits one abortable second between observations. The budget is
for the whole run and does not reset when the head changes. Each GitHub command
keeps its own timeout, so this is an observation bound rather than a five-second
wall-clock deadline. Autopilot does not start a triager or fixer only to wait for
mergeability.

## Child agents

Each run picks one configured model, then spawns two child agents with that model.
Status and readiness checks fetch only PR, review, and check metadata. Autopilot
fetches failed GitHub Actions logs when it is about to start the triager. It
fetches each Actions run once for that triage cycle and shares the excerpt among
checks from the same run. A later cycle fetches the run again so a new attempt
can supply different logs.

- **Triager** — receives bounded task data through stdin and has no tools. It
  classifies CI check failures (with log excerpts) and review threads without
  access to the local checkout, which may belong to another stacked PR. Runs with
  `--no-tools --no-skills` and, like every child, `--no-extensions -e <kstack>/kstack.ts`.
- **Fixer** — has `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit` tools.
  Generates code fixes for classified "code" failures and `fix` threads.
  It does not stage, commit, or push; the parent does that only after
  explicit confirmation, and only if the fixer did not print `VERIFY_FAIL`.

Both children see the triager task or fixer task file (mode 0600, in a private
temp directory) rather than serialized structured data on the command line.

If a GitHub reply or resolution fails, the autopilot stops that run without
posting later comments. It records completed handling by review source, item ID,
evidence version, and decision. The version covers the full comment bodies and
metadata before prompt clipping. An unchanged ignored item stays suppressed, but
edited feedback returns to triage. Reopened threads that were fixed or dismissed
also return to triage, even when their evidence has not changed.

Before resolving a review thread, the autopilot reads the complete thread again.
It does not post a duplicate reply when a matching version already has a pending
reply. If the feedback changed after the reply, the autopilot keeps the pending
record, leaves the thread unresolved, and requires fresh triage. A failed final
read has the same fail-closed behavior.

Versioned review state and flake reruns persist under the agent directory's
`pr-autopilot/` subdirectory (`$PI_CODING_AGENT_DIR/pr-autopilot/`, default
`~/.pi/agent/pr-autopilot/`). State is keyed by the repository's canonical Git
common directory, so linked worktrees share one repository scope. If the
repository-keyed file is missing, Autopilot migrates state stored under the
current worktree's legacy key and leaves that legacy file in place. An existing
repository-keyed file is authoritative even when malformed, and legacy files
from other worktrees are not searched or merged; each worktree migrates its own
legacy state when it next drives a PR.

State schema 3 identifies a rerun attempt by its Actions run ID and exact head
SHA. Jobs from one run share that attempt, while
separate runs remain independent even when their job names match. Every settled
request consumes the attempt, including a failed request or one whose acceptance
GitHub did not confirm. Autopilot saves that record before it starts another
rerun or returns after cancellation. A process crash between GitHub accepting a
request and the local save can still leave uncertain state; Autopilot does not
keep a remote-operation journal.

Schema 3 carries legacy `name@SHA` retry entries as migration evidence but never
writes new name-based entries. On the first complete checks snapshot for a head,
a legacy job name consumes every matching Actions run. This is conservative when
several runs used the same name because the old record cannot identify the run.
Autopilot converts a matched name entry to run records and removes it. Unmatched
legacy entries and run records from older heads remain in the file, so returning
to an old head does not renew a consumed attempt. A run that appears after this
one-time conversion has its own budget, even when its job name matches.

The schema retains at most 1,000 completed review-handling records and 1,000
pending replies. Completed records are pruned oldest first; pending replies are
never evicted. Legacy handled IDs are discarded as suppressions and receive one
fresh triage. Legacy replies remain as unversioned pending records until a
complete read proves that the thread is resolved or absent. A live legacy
pending reply requires manual inspection before another reply or resolution.
Invalid and future state schemas block automated review mutations instead of
being overwritten.

Review inspection reads at most 20 outer pages of 50 threads, 500 comments per
thread, and 5,000 comments per fetch. The first thread request reads 20 comments;
later requests page that thread by node ID. Missing or repeated cursors, partial
GraphQL errors, malformed required fields, cancellation, and exhausted limits
make the inspection incomplete. They never produce an empty, merge-ready review
state.

The state directory is created mode `0700`, and files are replaced atomically at
mode `0600`. Reads and writes refuse to traverse a symlinked state directory;
reads also refuse a state-file symlink. State from the previous `/tmp` location
is deliberately not migrated.

## Safety

- Children run with `--no-extensions -e <kstack>/kstack.ts`, `--no-skills`,
  and `--no-context-files` — the autopilot owns the workflow entirely. Only
  Kstack loads, so provider request shaping (`openrouter-floor`) applies
  without the user's other extensions; `--tools` bounds the tool set.
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

Press <kbd>Ctrl+Shift+B</kbd> during an autopilot run to stop it. Cancellation is
observed during mergeability waits, at action boundaries, and between review
pagination requests. A caller that cancels repository resolution receives an
aborted result, not a repository configuration error. After cancellation is
observed, Autopilot starts no new fixer, VCS operation, GitHub mutation, reply
resolution, rerun, or cleanup removal.

An already-dispatched repository or GitHub mutation is allowed to settle so
repository cleanup and remote diagnostics remain trustworthy. For example, an
in-flight push or worktree removal finishes and reports its actual result. If
cancellation arrives after fixes were recorded or a base update completed but
before publication started, Autopilot reports that local recorded work remains
unpublished in both the command notifications and the returned result. It does
not replay or automatically restore that work. Cancellation retains completed
handling, settled Actions rerun attempts, and a reply that was posted before its
resolution boundary. It also reports any failure from an in-flight reply or
push.

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
frontier at a time and returns exact-head readiness evidence. The stack caller
passes its resolved `repository` (`owner/name`) through `requestPrAutopilot`. Standalone calls resolve the same coordinates from the
configured backend before entering the driver. Repository-dependent review and
issue-comment reads require that resolved identity and never fall back to GitHub
CLI checkout placeholders, so `.git`-less jj workspaces do not depend on cwd
discovery. The stack workflow, not Autopilot, performs each
merge and continues through the selected PR.

## Development

```bash
node --test extensions/pr-autopilot/
```

Observation handling, head verification, reconciliation, and the run-wide
settling budget live in `observation.ts`. The driver keeps confirmation,
mutations, user messaging for mode policy, and durable Autopilot state.
