# plan-implement

Run a high-reason planner and a distinct small/fast implementer in isolated Pi
processes, with explicit plan approval between them, then invoke kstack's
existing panel review through an in-process extension API, address the
verdict's findings with a review-fixer child, and finish with a publisher
child that creates or updates a **draft** PR (`write-pr`) and recommends
reviewers (`find-reviewers`).

```text
/plan-implement Add optimistic locking to the session archive writer
/plan-implement --change-kind bug-fix Fix the archive race
/plan-implement --single --change-kind feature Add archive search
/plan-implement --worktree --change-kind feature Add archive search without touching this checkout
/plan-implement --stack --change-kind refactor Split the auth rollout into a three-PR jj stack
/plan-implement
```

Use `--change-kind` with `bug-fix`, `feature`, `refactor`, `performance`,
`prototype`, or `generic`. If you omit the flag, the command asks you to select
a change kind. Use `generic` as the explicit escape hatch when no specialized
proof obligations apply.

The argument-less form also asks for the delivery mode before opening the task
editor. `--single` remains the default when the command includes a task or
another option. Put `--` before a task that starts with dashes.

## Behavior

1. Requires TUI or RPC mode, a Git working tree, the `panel-review`
   extension, and the `write-pr` and `find-reviewers` skills in the session's
   discovered skill set (the publish phase consults both).
2. Names an unnamed parent session with a short task slug as soon as the task
   is validated, before waiting, preflight, or any child model call. An
   explicit or previously assigned session name is preserved.
3. Resolves authenticated planner and implementer models and confirms the
   assignments before spending.
4. Runs the planner with only `read,grep,find,ls`.
5. Displays the plan and asks for approval before mutation.
6. Runs the implementer with Pi's normal built-in tools. The approved plan is a read-only file, and the implementer must close every ordered step and acceptance criterion in an execution ledger as `done`, `blocked: <reason>`, or `skip: <reason>`.
7. Validates item-by-item parity, displays the implementer's final report (including the ledger), and, on success, asks the loaded
   panel-review extension to run through Pi's in-process event bus. The panel
   keeps its own confirmation and verdict rendering and returns a structured
   outcome to the loop.
8. On a completed verdict, asks whether to address the findings, then runs
   the review fixer (implementer model, full tools) with the task and the
   verdict passed through mode-`0600` temp files. The fixer addresses Act On
   findings, verifies each against the repository, re-runs focused tests, and
   commits verified fixes on the existing workstream branch.
9. Asks whether to publish, then runs the publisher (implementer model): it
   follows `write-pr` to push the branch and create a draft PR (or update an
   existing PR's title/body), then follows `find-reviewers` to recommend 2–5
   reviewers with evidence and a review order. Its final report — PR URL,
   title, and the full reviewer recommendation — is displayed as the run's
   terminal output. The publisher never marks PRs ready, merges, or
   force-pushes.

Both `kstack-router` and direct `/plan-implement` calls supply a selected
change kind. The confirmation displays it. The planner, implementer, and review
fixer receive the shared `playbooks/engineering-principles.md` index, followed
by the matching non-generic proof-obligation playbook. General principles shape
the design without expanding scope; the specialized playbook defines the
change's evidence contract. Generic changes still receive the shared index.
The publisher receives neither because it packages the already-reviewed change
rather than shaping implementation.

The planner emits machine-readable ordered `[STEP-n]` items and `[AC-n]`
acceptance criteria. The parent copies them into the mutable execution ledger,
preserves the implementer result for panel-review, including missing or
malformed entries, and passes both the immutable plan and ledger onward.
Synthesis treats omitted plan items as blocking findings; a prose deviations
section cannot close an item.

Bug fixes require a before-and-after reproduction, refactors pin behavior,
performance work compares matching measurements, features prove observable
behavior, and prototypes stay isolated and produce a decision.

Both children use `--no-session --no-extensions --no-prompt-templates`. The
review-fixer and publisher phases reuse the implementer model and tools; the
publisher's skills (`write-pr`, `find-reviewers`, and in stack mode the
re-added skill set) reach the child through normal skill discovery or explicit
`--skill` flags.

### Single-PR mode (default)

Skills and context files intentionally remain enabled. A task can therefore
compose with `create-pi-extension`, `create-skill`, `find-reviewers`, or any
other matching installed/project skill without running recursive extensions.

After plan approval, the extension inspects `git status`. In the current
working tree it stops if tracked or untracked files already exist, then
recommends `--worktree`. On a clean tree it creates and selects a dedicated
`kstack/<task-slug>` branch from the current `HEAD` (numeric suffix on
collision) before launching the implementer. The implementer verifies that
branch and commits each coherent, verified increment. It never pushes or publishes. Finish with no uncommitted task changes. If a local Git
identity, hook, or signing requirement blocks a commit, the agent stops and
reports the blocker.

The review fixer stays on that branch and commits each independent, verified
fix batch. It does not start another branch.

### Managed worktree mode (`--worktree`)

Worktree mode pins the remote default (falling back through conventional
main/master refs to `HEAD`) before planning. After plan approval it creates a
unique branch and linked worktree beneath:

```text
~/.pi/kstack/worktrees/<repo-name>-<common-dir-hash>/<task-slug>
```

The planner inspects the original checkout; the implementer, panel review,
review fixer, and publisher operate on the managed worktree and reuse the
parent-created `kstack/<task-slug>` branch rather than creating a second one.
Panel review uses the pinned SHA as its immutable base. Files and uncommitted
changes in the original checkout are not modified, although the linked
worktree necessarily shares Git metadata and branch refs. The worktree is
retained on success, failure, abort, and publication. Use the `git-worktrees`
skill to inspect and clean it up explicitly.

`--worktree` currently supports single-PR delivery only. Combining it with
`--stack` fails before model calls because a Git linked worktree is not a jj
workspace.

### Stacked-PR mode (`--stack`)

Stacked-PR mode builds a **local** Jujutsu stack of changes and bookmarks, one
bookmark per PR, and reviews it once. The implementer never publishes; the
final publish phase owns publication.

Stack mode adds a preflight before any model call:

- `jj >= 0.44` is available and the directory is a Jujutsu workspace;
- the workspace is colocated with a Git worktree;
- the `trunk()` revset resolves to exactly one 40-hex Git-backed commit (used as
  the immutable panel-review base);
- the session's discovered skills include `jj-stacked-prs`.

Arena is **deterministically disabled** for both children: skill discovery is
turned off with `--no-skills` and every other discovered skill is re-added with
repeated `--skill` (including `jj-stacked-prs`). This prevents parallel
candidates from corrupting a shared jj operation log while preserving
task-specific skills. The planner produces a `Delivery: stacked-prs` plan with
ordered PR slices; the implementer consults `jj-stacked-prs`, starts a new
stack from `trunk()`, describes coherent `jj` changes incrementally, and places
bookmarks at PR boundaries. Those described changes are the stacked equivalent
of a Git task branch and incremental commits. The implementer never runs
publish commands (`publish_stack.py apply`), `jj git push`, or `gh pr create`. After a
successful implementation, panel review runs once against the immutable
`trunk()` base. The review fixer amends findings into the correct slices of
the local stack (per `jj-stacked-prs`), and the publisher — after its own
confirmation — submits the stack as draft PRs via the `jj-stacked-prs`
publishing workflow (the bundled `publish_stack.py`), applies `write-pr` title/body discipline
to each slice, and recommends reviewers across the full stack range.

The Planner, Implementer, Review fixer, and Publisher cards identify the
model used. Expand a card with Ctrl+O. Press **Ctrl+Shift+I** to abort an actively running child process. At
the plan-approval boundary the shortcut reports that no child is running and
does not pre-abort the future implementer.

## In-process API (composability)

The extension exposes an in-process event-bus API (`kstack:plan-implement:request`)
to allow other extensions (notably `kstack-router`) to invoke the workflow without
synthesizing slash-command strings.

The request carries a structured `{ task, mode, workLocation, changeKind, ctx }` payload with a
synchronous `claimed` flag and an awaited completion promise. For compatibility,
older callers may omit `workLocation`, which means `current`. The slash command
and the event listener call the same internal runner. Only the slash command
collects flags and editor input. Both paths retain task validation,
Git/panel/model preflight, confirmations, lifecycle checks, cleanup, and panel
review.

See `api.ts` for the full contract and `api.test.ts` for usage examples.

## Configuration

Configuration is the `"plan-implement"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):

```json
{
  "plan-implement": {
    "planner": { "model": "openai/gpt-5.6-sol", "thinking": "high" },
    "implementer": {
      "model": "openai/gpt-5.6-terra",
      "thinking": "medium"
    },
    "timeoutMinutes": 30
  }
}
```

Planner and implementer models must be distinct and authenticated. Models from
providers registered by parent extensions are rejected because `--no-extensions`
children cannot reproduce those definitions, routes, or credentials. Planner
thinking is restricted to `high`, `xhigh`, or `max`; when omitted it defaults
to `high`. `timeoutMinutes` is an integer from 1 through 60 and applies to each
child.

Without config, the first authenticated candidate is selected from each list:

- Planner: GPT-5.6 Sol (high), Claude Opus 4.6 (high), Claude Fable 5 (high).
- Implementer: GPT-5.6 Terra (medium), then Gemini 3.7 Flash, DeepSeek V4
  Flash, or GLM 5.2 (high).

The extension does not fall back to the active parent model; explicit role and
cost separation is part of its contract.

## Limits and security

| Item | Limit |
| --- | --- |
| Task | 32 KiB UTF-8 |
| Planner final output | 64 KiB UTF-8 |
| Implementer final output | 32 KiB UTF-8 |
| Child stderr retained | 8 KiB UTF-8 |
| One JSONL stdout line | 2 MiB; oversized lines terminate the child |
| Child timeout | 1–60 min, default 30 |
| Panel intent | 1,000 characters |
| Abort grace | 5 s before SIGKILL |

Task, plan, and panel-verdict content are passed through mode-`0600` files
in a private temp directory, not in child argv. The directory is removed after
the run.

This is process isolation, not a sandbox. The implementer runs with the user's
Pi/OS permissions and can modify the repository after approval. Skills,
context files, repository files, task text, and planner output may all contain
instructions; child system prompts tell agents to honor trusted instructions
and the explicit user task. The planner's Pi tool set is read-only, but OS file
permissions are unchanged.

In current-working-tree mode the implementer refuses a dirty tree, so panel
review sees the committed task branch rather than mixed pre-existing edits.
Worktree mode reviews only the managed linked worktree against its pinned
base. The review-fixer and publisher children run with the user's Pi/OS
permissions; the publisher's confirmation is the only gate before it pushes a
branch and opens a draft PR on the user's GitHub account. Publication stops if
uncommitted files belong to the requested workstream.

## Failure policy

- Invalid config, unavailable models, missing Git/panel-review, missing
  `write-pr`/`find-reviewers` skills, and bad task input stop before model
  calls.
- Stack-mode preflight failures (no jj, not a workspace, no colocated git, no
  single `trunk()` commit, missing `jj-stacked-prs` skill, Arena not excludable)
  stop before model calls.
- Worktree-mode base/path failures stop before model calls. Creation happens
  only after plan approval; a creation failure stops before the implementer and
  reports any directory or branch that may need inspection.
- Planner failure or plan rejection stops before the implementer.
- Implementer failure is displayed and warns that committed checkpoints may
  exist on the task branch and that uncommitted partial edits may remain; it
  does not start panel review. Inspect the branch and `git status` before
  retrying.
- Successful implementation invokes panel-review directly through its claimed
  event-bus request. Missing listeners and request failures are reported.
  Panel confirmation, partial reviewer failures, and synthesis behavior remain
  owned by panel-review. A verdict is required to continue: `no-changes`,
  `declined`, `aborted`, and `failed` outcomes skip the fix and publish
  phases with a notice.
- Review-fixer failure is displayed; the publish phase is still offered
  afterwards (the PR ships the implementation plus whatever fixes landed).
- Publisher failure (including `gh` auth/network errors) is displayed; the PR
  may exist partially (e.g. pushed branch without a PR). Re-run `/plan-implement`
  or finish publishing manually with the `write-pr` skill.
- Abort sends SIGTERM to the child process group and SIGKILL after five seconds.
  Session shutdown invalidates stale callbacks and uses the same cleanup path.

## Development

Unit tests make no provider calls:

```bash
node --test extensions/plan-implement/*.test.ts
```

The full design and deferred boundaries are recorded in
[`../../plans/plan-implement.md`](../../plans/plan-implement.md).
