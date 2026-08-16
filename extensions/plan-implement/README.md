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

1. Requires TUI or RPC mode, a workspace accepted by the configured VCS
   backend, the `panel-review` extension, and the `write-pr` and
   `find-reviewers` skills in the session's discovered skill set.
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
   records verified fixes on the existing branch or bookmark.
9. Asks whether to publish, then runs the publisher (implementer model): it
   follows `write-pr` to push the configured backend's branch or bookmark and
   create a draft PR (or update an existing PR's title/body), then follows
   `find-reviewers` to recommend 2–5
   reviewers with evidence and a review order. Its final report — PR URL,
   title, and the full reviewer recommendation — is displayed as the run's
   terminal output. The publisher never marks PRs ready, merges, or
   force-pushes.
10. After a successful single-PR publication, resolves the open PR from the
    workflow branch or bookmark using live GitHub state and offers an optional `/land`
    continuation. If accepted, `/land` watches pr-autopilot readiness and keeps
    its own exact-head merge confirmation. Stack mode is excluded, and a
    missing land extension or unresolved PR ends cleanly at the published draft. Managed-worktree runs pass the retained workflow checkout to both landing and pr-autopilot.

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

The shared `vcs.backend` setting selects the single-PR workstream:

- Git mode requires a plain Git working tree. It stops on tracked or untracked
  pre-existing changes and recommends `--worktree`. On a clean tree, it creates
  `kstack/<task-slug>` from the current `HEAD`, adding a numeric collision
  suffix when needed.
- jj mode requires a colocated jj/Git workspace. It creates a `trunk()`-based
  change with a collision-safe `kstack/<task-slug>` bookmark. jj's automatic
  snapshot model replaces Git dirty-tree and staging assumptions.

The parent injects backend-specific guidance into every child. The implementer
and review fixer stay on the prepared workstream, record coherent verified
increments with only the selected backend, and never publish. Git mode finishes
with a clean tree. jj mode finishes with an empty working-copy change above the
recorded implementation. The publisher describes that empty jj checkpoint,
moves the task bookmark to `@`, and pushes it so later automation can add fixes
without rewriting implementation changes.

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

`--worktree` requires the Git backend and supports single-PR delivery only.
The jj backend rejects it before model calls; jj single delivery runs in the
current workspace. Combining `--worktree` with `--stack` also fails before
model calls.

### Stacked-PR mode (`--stack`)

Stacked-PR mode builds a **local** Jujutsu stack of changes and bookmarks, one
bookmark per PR, and reviews it once. The implementer never publishes; the
final publish phase owns publication.

Stack mode requires `vcs.backend: "jj"` and adds a preflight before any model
call:

- `jj >= 0.44` is available and the directory is a Jujutsu workspace;
- `user.name` and `user.email` are configured for jj;
- the workspace is colocated with a Git worktree;
- the `trunk()` revset resolves to exactly one 40-hex Git-backed commit (used as
  the immutable panel-review base);
- the `jj-stacked-prs` extension is loaded (probed before any model call).

Arena is **deterministically disabled** for both children: skill discovery is
turned off with `--no-skills` and every other discovered skill is re-added with
repeated `--skill`. This prevents parallel candidates from corrupting a shared
jj operation log while preserving task-specific skills. The planner produces a
`Delivery: stacked-prs` plan with ordered PR slices; the implementer follows the
local jj stack prompt, starts a new stack from `trunk()`, describes coherent
`jj` changes incrementally, and places bookmarks at PR boundaries. Those
described changes are the stacked equivalent of a Git task branch and
incremental commits. The implementer never runs `/jj-stack publish`, `jj git
push`, or `gh pr create`. After a successful implementation, panel review runs
once against the immutable `trunk()` base. The review fixer amends findings into
the correct slices of the local stack. Structural publication is owned by the
loaded `jj-stacked-prs` extension: it derives or selects top/remote, confirms
the exact plan, stale-checks, and applies. Only a completed publication writes a
trusted PR map and offers a metadata/reviewer child. That child may edit titles
and bodies for listed PRs and recommend reviewers; it does not push, create PRs,
repair bases, or update navigation comments.

The Planner, Implementer, Review fixer, and Publisher cards identify the
model used. Expand a card with Ctrl+O. Press **Ctrl+Shift+I** to abort an actively running child process. At
the plan-approval boundary the shortcut reports that no child is running and
does not pre-abort the future implementer.

## Live TUI Dashboard & Transcript Inspector

In TUI mode, plan-implement mounts a live dashboard widget above the editor and provides an interactive read-only inspector overlay:

- **Live Dashboard**: Mounted above the editor during the workflow. Displays status icons (`○` queued, `●` running, `✓` completed, `✗` failed, `⊘` aborted), turns, elapsed time, current tool activity, and a rolling single-line preview of streaming assistant text for each child phase (Planner, Implementer, and subsequent Review fixer / Publisher phases).
- **Transcript Inspector Overlay (`Ctrl+Shift+P`)**: A strictly read-only popup overlay allowing the user to inspect the streaming and historical transcripts of each phase (Planner, Implementer, Review fixer, Publisher).
  - Use `←` / `→` or `Tab` / `Shift+Tab` to switch between child tabs.
  - Use `↑` / `↓` / `PgUp` / `PgDn` / `Home` / `End` / `g` / `G` to scroll.
  - Press `f` to toggle auto-follow tail.
  - Press `Escape` to close the overlay.
  - Press `Ctrl+Shift+I` or `Ctrl+Shift+X` to abort the running child.
  - Displays lifecycle notes, tool calls with elapsed durations, turn boundaries with input/output token counts and costs, wrapped assistant text, and the real-time live streaming tail.

Live dashboard state and transcripts are ephemeral (capped at 128 KiB per child) and never written to the session or disk.

## In-process API (composability)

The extension exposes an in-process event-bus API (`kstack:plan-implement:request`)
to allow other extensions (notably `kstack-router`) to invoke the workflow without
synthesizing slash-command strings.

The request carries a structured `{ task, mode, workLocation, changeKind, ctx }` payload with a
synchronous `claimed` flag and an awaited completion promise. The slash command
and the event listener call the same internal runner. Only the slash command
collects flags and editor input. Both paths retain task validation,
VCS/panel/model preflight, confirmations, lifecycle checks, cleanup, and panel
review.

See `api.ts` for the full contract and `api.test.ts` for usage examples.

## Configuration

The shared `vcs.backend` setting selects `"git"` or `"jj"` and defaults to
`"git"` when omitted. The extension reads that setting once at the adapter
boundary, runs the corresponding preflight, and passes one backend through all
mutation phases. Repository-local overrides are not supported.

Model configuration is the `"plan-implement"` section of
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
  Flash, or Kimi k3 (medium).

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

In Git current-checkout mode, the implementer refuses a dirty tree so panel
review sees only the committed task branch. Managed-worktree mode reviews the
linked worktree against its pinned base. In jj mode, the parent verifies the
bookmark ancestry, requires at least one non-empty change, and requires an
empty working-copy change before review. The review-fixer and publisher
children run with the user's Pi/OS permissions; the publisher's confirmation
is the only gate before it pushes a branch or bookmark and opens a draft PR.
Publication stops when workstream changes have not been recorded.

## Failure policy

- Invalid config, unavailable models, VCS preflight failures, a missing
  panel-review extension, missing `write-pr`/`find-reviewers` skills, and bad
  task input stop before model calls.
- Stack-mode preflight failures (no jj, not a workspace, no colocated git, no
  single `trunk()` commit, unloaded `jj-stacked-prs` extension, Arena not
  excludable) stop before model calls.
- Worktree-mode base/path failures stop before model calls. Creation happens
  only after plan approval; a creation failure stops before the implementer and
  reports any directory or branch that may need inspection.
- Planner failure or plan rejection stops before the implementer.
- Implementer failure is displayed and warns that recorded checkpoints and
  partial edits may remain; it does not start panel review. Inspect the retained
  branch or jj change with the configured backend before retrying.
- Successful implementation invokes panel-review directly through its claimed
  event-bus request. Missing listeners and request failures are reported.
  Panel confirmation, partial reviewer failures, and synthesis behavior remain
  owned by panel-review. A verdict is required to continue: `no-changes`,
  `declined`, `aborted`, and `failed` outcomes skip the fix and publish
  phases with a notice.
- Review-fixer failure is displayed; the publish phase is still offered
  afterwards (the PR ships the implementation plus whatever fixes landed).
- Publisher failure (including `gh` auth/network errors) is displayed; the PR
  may exist partially, such as a pushed branch or bookmark without a PR. Re-run
  `/plan-implement` or finish publishing manually with the `write-pr` skill.
- Abort sends SIGTERM to the child process group and SIGKILL after five seconds.
  Session shutdown invalidates stale callbacks and uses the same cleanup path.

## Development

Unit tests make no provider calls:

```bash
bun test extensions/plan-implement/
```

Implementation plans are temporary working state under `local/plans/` and are
not tracked. This README, the source, and the tests document the shipped contract.
