# kstack

kstack = "Krishnan's Stack". Named as an homage to [`pstack`](https://github.com/cursor/plugins/tree/main/pstack), which it is heavily inspired by.

Krishnan's personal extensions for [Pi](https://pi.dev).

> Pi extensions execute with your full user permissions. Review extension code before installing it.

## Extensions

| Extension | Description |
| --- | --- |
| [`steering-swap`](extensions/steering-swap/) | Swaps Enter and Alt+Enter in the main editor while Pi is working (Enter queues a follow-up, Alt+Enter steers) without breaking Enter for idle submission, autocomplete, or inline prompts. |
| [`kstack-router`](extensions/kstack-router/) | Optional front door: `/kstack [--route <id>] [--single|--stack] [--worktree] [--change-kind <kind>] [--mode <mode>] [--pr <n>] [--method <method>] [--readiness <mode>] [--] <task>` routes tasks through a classifier to implementation, review, PR autopilot, or confirmed landing. |
| [`session-archive`](extensions/session-archive/) | Moves completed Pi sessions—including a multi-selected batch of inactive sessions—out of the active session directory, preserves their canonical JSONL, and indexes them locally with SQLite/FTS5. |
| [`handoff`](extensions/handoff/) | Opens a lean replacement session from one editor confirmation, optionally archiving the old session first and selecting a model and effort, then gives read-only tools for normalized, on-demand access to the linked history. |
| [`panel-review`](extensions/panel-review/) | Runs 2–5 isolated read-only reviewer subagents in parallel against the current Git changeset and synthesizes a lead-review verdict, with a live multi-agent TUI dashboard. |
| [`plan-implement`](extensions/plan-implement/) | Selects or accepts a change kind, plans with a high-reason model, pauses for approval, implements on a dedicated Git/Graphite branch or jj bookmark with incremental local changes, runs panel review, addresses findings, then publishes a draft PR with reviewer recommendations and can optionally hand the published PR to `/land`. Supports local jj stacks and isolated managed Git/Graphite worktrees, with a live multi-phase TUI dashboard and transcript inspector. |
| [`fast-implement`](extensions/fast-implement/) | Runs one confirmed implementation session for an explicit, bounded change. Current-checkout mode takes over the TUI in a fresh linked session; `--worktree` uses an isolated child process. Both modes verify local commits, skip independent planning and review, and never publish. |
| [`pr-autopilot`](extensions/pr-autopilot/) | Bounded post-PR autopilot using only tiny models (GPT-5.6 Luna, Gemini 3.7 Flash, DeepSeek V4 Flash). Drives an open PR frontier through comments-first triage, CI watch, and fix → push → recheck, stopping at merge-ready. Never auto-merges, never rebases shared history. |
| [`land`](extensions/land/) | Confirmation-gated landing of exact, merge-ready GitHub PR heads. In jj mode, selecting an upper stacked PR lands the full prefix from trunk through that PR. Land reuses pr-autopilot readiness, respects branch protection and merge queues, and verifies remote merge state. |
| [`jj-stacked-prs`](extensions/jj-stacked-prs/) | Inspects, plans, publishes, syncs, advances, and lands linear GitHub PR stacks on a colocated jj workspace. Pi can publish or land through a model tool after an explicit user request; command-driven mutations retain standard confirmation. |

Writable workstreams use a dedicated `kstack/<task-slug>` Git/Graphite branch or jj
bookmark and record coherent increments with the configured backend. Git
current-checkout runs stop on a dirty tree; jj runs use automatic snapshots.
No backend pushes or publishes without user authorization. An explicit
request to publish the current jj stack is sufficient authorization for
`jj_stack_publish`; command workflows retain their confirmation. Read-only
routes do not create workstreams.

## Skills

| Skill | Description |
| --- | --- |
| [`create-pi-extension`](skills/create-pi-extension/) | Designs and implements Pi extensions using the installed documentation, repository patterns, lifecycle/security ground rules, and an incremental verification checklist. |
| [`create-skill`](skills/create-skill/) | Creates, tests, and improves Pi skills: draft, headless with-skill vs baseline eval runs, grading, benchmark aggregation, a static review page, and description/trigger optimization. |
| [`find-reviewers`](skills/find-reviewers/) | Recommends the 2–5 best pull-request reviewers for any git change by analyzing commit history, CODEOWNERS, adjacent-domain ownership, and author identities, returning a prioritized, evidence-backed list with a review order. |
| [`arena`](skills/arena/) | Spawns N parallel candidates at the same task, cross-judges them, picks the strongest as a base, grafts the best parts from the losers, and verifies the synthesized result. |
| [`architect`](skills/architect/) | Grounds a change, explores structurally distinct caller-first designs through Arena, and implements against the synthesized type and module contract. Explicit invocation only. |
| [`swarm`](skills/swarm/) | Fans out N parallel workers across different slices of a task (partition, race, or mix), aggregates results, and returns one consolidated report. |
| [`git-worktrees`](skills/git-worktrees/) | Creates, inspects, repairs, and safely cleans up Git linked worktrees managed beneath `~/.pi/kstack/worktrees`, with dirty-state and ownership checks before removal. |
| [`fix-merge-conflicts`](skills/fix-merge-conflicts/) | Resolves merge, rebase, or jj conflicts non-interactively, then validates the build and tests before finalizing. |
| [`write-pr`](skills/write-pr/) | Writes a crisp pull-request title and description from a standalone branch or exact stacked-PR slice, updating the open PR or creating a draft. |
| [`simplify`](skills/simplify/) | Runs parallel read-only review lenses on scoped code changes, then applies targeted cleanup to reduce complexity while preserving behavior. |
| [`unslop`](skills/unslop/) | Removes generic AI tells from prose while preserving the intended voice, facts, and audience. |
| [`technical-writing`](skills/technical-writing/) | Writes and reviews clear technical docs using Diátaxis, Google developer style, STE, and Global English clarity rules. |
| [`typescript-best-practices`](skills/typescript-best-practices/) | Applies TypeScript type-system discipline, boundary validation, constructive modeling, and safe narrowing patterns when reading or editing `.ts` or `.tsx` files. |
| [`blast-radius`](skills/blast-radius/) | Traces cross-boundary risks in a focused change and proves its safety-critical assumption with executable evidence. |
| [`reflect`](skills/reflect/) | Reviews a selected Pi session through independent judgment, tooling, and contrarian lenses, then proposes user-approved, durable workflow improvements. |
| [`decision-trail`](skills/decision-trail/) | Keeps an opt-in, append-only TSV decision log (what, why, evidence, result) for long-running or unattended work, then audits it against the session transcript with a cross-model review. Explicit invocation only. |
| [`personalize`](skills/personalize/) | Mines the user's own session history from any coding agent (Pi, Claude Code, Codex, Cursor) for durable, evidence-backed preferences and applies approved edits to a target such as AGENTS.md. |
| [`how`](skills/how/) | Explains code structure, ownership, and runtime flow through fast, allowlisted exploration models. |
| [`why`](skills/why/) | Investigates design rationale through fast, allowlisted evidence gathering and reports direct evidence separately from inference. |
| [`recall`](skills/recall/) | Reconstructs recent working context across Pi sessions, reconciles it with live Git/PR state, and returns a tight brief with thread statuses and a concrete resume point. Read-only. |
| [`setup-kstack`](skills/setup-kstack/) | Interactively discovers and validates Pi model assignments, previews a user-level `kstack.json` update, and writes it only after approval. |
| [`tdd`](skills/tdd/) | Makes a cheap failing-before / passing-after regression check before fixing a bug, and skips a new test when the path is expensive or unclear. |
| [`thermo-nuclear-code-quality-review`](skills/thermo-nuclear-code-quality-review/) | Extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. Explicit-only; panel-review applies the same canonical lens to every reviewer and synthesis model. |

## Configuration

K-Stack settings live in one config file: `$PI_CODING_AGENT_DIR/kstack.json`
(default `~/.pi/agent/kstack.json`). The `vcs.backend` setting selects `"git"`,
`"jj"`, or `"graphite"` for repository mutations and defaults to `"git"` when omitted.
Model assignments for panel-review, plan-implement, arena, swarm, and the
`how` and `why` investigation skills use sections in the same file. The optional
`fast-implement` section configures its one-shot implementer independently of
`plan-implement`. A top-level `aliases` array (or any `{label, model, thinking}`
entry anywhere in the file) defines model short names that `/handoff --model`
resolves alongside Pi model display names.

Copy the starter and edit:

```bash
cp kstack.example.json ~/.pi/agent/kstack.json
```

See [`kstack.example.json`](kstack.example.json) for the full schema. Each
section is optional. Missing sections use built-in defaults or prompt for
models at runtime. To choose the VCS backend, discover the local Pi model
catalog, validate selected providers, preview the update, and write only the
user configuration, run:

```text
/skill:setup-kstack
```

`setup-kstack` does not modify repository defaults unless you explicitly ask for
a separate follow-up change.

The backends are exclusive for each run. Git mode requires a plain Git working
tree and supports current-checkout or managed-worktree single delivery. Graphite
mode requires gt 1.8.4+, Git 2.38+, and initialized Graphite metadata, and uses
native `gt` mutation in current or managed-worktree single delivery. jj mode
requires jj 0.44 or newer, a configured jj user name and email, and a colocated
jj/Git workspace. It supports current-workspace single delivery and stacked
PRs, but not Git worktree isolation. K-Stack refuses a mismatched workspace
before launching a model or mutating repository state.

| Workflow | Git backend | jj backend | Graphite backend |
| --- | --- | --- | --- |
| `fast-implement` | Current branch or `--worktree` | Current workspace; no `--worktree` | Current branch or tracked `--worktree` |
| `plan-implement --single` | Current branch or `--worktree` | `trunk()`-based change and bookmark | Current branch or tracked `--worktree` |
| `plan-implement --stack` | Refused | Local jj stack | Graphite stack adapter |
| `pr-autopilot` | Branch validation, Git commit/merge/push | Bookmark-at-`@` validation, jj commit/merge/push | Branch validation and native Graphite record/restack/submit |
| `land` auto-discovery | Current branch | Bookmark targeting `@` | Current Graphite branch |

### Migrating existing installations

Existing installations that omit `vcs` continue to use Git. To adopt jj or Graphite, run
`/skill:setup-kstack`, select the backend, review the preview, and approve the update to
the user-level `kstack.json`. Ensure the repository is colocated and configure
`jj config set --user user.name` and `user.email` first. The installer and
package updates never create, overwrite, or migrate `kstack.json`; they preserve
the user's backend choice.

`how` and `why` use only models in `investigation.allowedModels`. The resolver
requires every entry to come from kstack's curated fast-model set and to use at
least `medium` thinking. It rejects a requested model outside the configured
subset. Set `defaultModel` to one of the allowlisted model IDs.

## Session names in development workflows

Kstack names an unnamed session as soon as `/plan-implement` or `/kstack` knows
the task, before waiting, preflight, classification, or child-model work.
Automatically derived names are short lowercase slugs, such as
`archive-multiple-sessions`. `/handoff` gives its replacement session the same
kind of slug before sending that session's first user message. Existing names
are never overwritten.

For workflows started outside those commands, use Pi's built-in naming support:

```bash
pi --name "Named session archive"
```

Or name an active interactive session:

```text
/name Named session archive
```

Current and inactive sessions can be archived without names. Their archive
rows stay unnamed.

## Requirements

- Pi 0.84.1 or newer
- [Bun](https://bun.sh) 1.3.14 or newer for local tooling. Install it with `curl -fsSL https://bun.sh/install | bash`.
- Node.js 22 or newer for Pi's runtime and the `node:sqlite` test carve-out
- A local filesystem for Pi's agent directory
- `gh` — the [GitHub CLI](https://cli.github.com), authenticated (`gh auth login`); required by pr-autopilot, land, jj-stacked-prs, and plan-implement's publish step
- `jj` — [Jujutsu](https://github.com/jj-vcs/jj), only when [`vcs.backend` is `"jj"`](#configuration)
- `gt` — [Graphite CLI](https://graphite.dev/docs/cli-quick-start) 1.8.4 or newer, only when [`vcs.backend` is `"graphite"`](#configuration)

The extensions use TypeScript directly through Pi's loader. No build or dependency installation is required.

## Install for the current user

This repository follows Pi's conventional package layout: extensions live under
`extensions/` and skills live under `skills/`. Pi packages cannot provide
`settings.json` or `keybindings.json`, so the recommended installer both
registers the checkout as a user-level Pi package and applies kstack's tracked
Pi defaults:

```bash
cd /path/to/kstack
./install.mjs
```

The installer runs `pi install` and merges
[`config/pi-defaults/settings.json`](config/pi-defaults/settings.json) and
[`config/pi-defaults/keybindings.json`](config/pi-defaults/keybindings.json)
into `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`). It preserves unrelated
settings and keybindings while making the tracked values authoritative:

- Thinking blocks are hidden.
- All queued steering and follow-up messages are delivered together.
- Keybindings stay at Pi's stock values; the `steering-swap` extension swaps
  Enter and Alt+Enter in the main editor while Pi is working, so Enter queues
  follow-up messages and Alt+Enter steers. Enter keeps stock behavior for idle
  submission, autocomplete, inline prompts, and selectors.

Rerunning the installer is safe and reapplies these defaults. It refuses to
modify either config file if existing JSON is malformed.

By default, `pi install` writes to the current user's global settings. It loads
all extensions and all skills in this repository across Pi projects; the
installer intentionally does not pass `-l`, which would create a project-local
installation instead. To register only the package without applying kstack's Pi
preferences, use `pi install "$PWD"` directly.

Pi records a reference to the checkout rather than copying it. Pulling or editing
the repository updates the installed resources; use `/reload` in a running Pi
process, or restart Pi, after changes.

Inspect or enable the installed extensions and skills with:

```bash
pi list
pi config
```

The two-model implementation workflow is available as an extension command:

```text
/plan-implement Add optimistic locking to the archive writer
/plan-implement --change-kind bug-fix Fix the archive race
```

Without `--change-kind`, the command asks you to select one before planning. For explicit low-risk bounded edits, use `/fast-implement --change-kind feature <task>` or `/kstack --route fast-change <task>`; this lower-assurance option never publishes automatically. It
keeps skills enabled in both child agents, so each role can consult the
original task-specific skills it needs. See
[`extensions/plan-implement/README.md`](extensions/plan-implement/README.md)
for model defaults, configuration, confirmations, and security boundaries.

Skills can then be invoked explicitly, for example:

```text
/skill:create-pi-extension
/skill:create-skill
/skill:find-reviewers
/skill:arena
/skill:architect
/skill:swarm
/skill:simplify
/skill:unslop
/skill:technical-writing
/skill:blast-radius
/skill:reflect
/skill:decision-trail
```

The two-model implementation workflow also has a stacked-PR delivery mode:

```text
/plan-implement --stack Split the auth rollout into a three-PR jj stack
```

In stack mode the planner and implementer build a **local** jj stack of
bookmarks (one per PR) and deterministically exclude the `arena` skill; no PRs
are created. Confirmed structural publication uses the loaded
[`jj-stacked-prs`](extensions/jj-stacked-prs/) extension (`/jj-stack publish`);
a child updates titles/bodies and recommends reviewers only after that succeeds.

After a draft PR is published, hand it to the bounded PR autopilot to drive
the review/fix/CI loop with only tiny models:

```text
/pr-autopilot --mode drive            # comments → watch CI → fix → push until merge-ready
/pr-autopilot --mode watch            # same loop with more cycles, watching pending checks
/pr-autopilot --mode check            # one status pass, report, stop
/pr-autopilot --mode threads          # address review comments only, then push
/pr-autopilot --mode cleanup          # after merge: remove managed worktree and branch
/pr-autopilot --mode drive --pr 42    # run on a specific PR instead of auto-detecting
/land --pr 42 --method squash          # land one PR, or its local jj stack prefix
/land --pr 42 --readiness watch        # run autopilot for each selected frontier
```

`pr-autopilot` uses only tiny models (GPT-5.6 Luna, Gemini 3.7 Flash, and DeepSeek
V4 Flash) recorded in the `pr-autopilot` section of `kstack.example.json`. It stops at
merge-ready — it never auto-merges or rebases shared history. See
[`extensions/pr-autopilot/README.md`](extensions/pr-autopilot/README.md) for details.

To remove the package registration, run this from the same checkout:

```bash
pi remove "$PWD"
```

Removal does not revert the merged Pi preferences; delete those managed keys
from `settings.json` and `keybindings.json` manually if they are no longer
wanted.

### Manual copy installation

Package installation is preferred because it keeps extensions and skills tied to
the checkout. To copy all resources into Pi's global user directories instead,
run this from the repository root:

```bash
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/skills"
cp -R extensions/. "$PI_AGENT_DIR/extensions/"
cp -R skills/. "$PI_AGENT_DIR/skills/"
```

Review existing destination directories before copying so that local changes are
not overwritten. A copied installation is a snapshot; repeat the copy after
repository updates. Pi discovers extension entry points under the global
`extensions/` directory and skill `SKILL.md` files under the global `skills/`
directory.

For a one-off extension test without installing anything, run from the repository
root:

```bash
pi -e extensions/session-archive/index.ts
```

## Development

Agents should read [`AGENTS.md`](AGENTS.md) before making changes.

Run the full JavaScript and TypeScript test suite from the repository root:

```bash
bun install
bun run test
```

The suite runs under [Bun](https://bun.sh), with one exception. The
`session-archive` extension uses `node:sqlite` (Node 22+) because it runs
inside Pi's Node runtime. Its tests and the handoff tests that transitively
import it run under Node through `bun run test:sqlite`. `bunfig.toml` excludes
those files from Bun, and `bun run test` automatically chains the Node step.
`bun run check:test-split` verifies that the Bun exclusions and Node test
scripts list the same SQLite tests.

`skills/tdd/evals/` contains prompt fixtures for skill evaluations, not project
tests. `bunfig.toml` excludes those fixtures from the test suite.

Check TypeScript types before submitting changes:

```bash
bun run typecheck
```

For focused runs, use the individual test commands:

```bash
bun test install.test.mjs
bun test check-exports.test.mjs
bun run test:handoff
bun run test:session-archive
bun test extensions/panel-review/
bun test extensions/plan-implement/
bun test extensions/kstack-router/
bun test extensions/land/
bun test extensions/pr-autopilot/
bun test extensions/jj-stacked-prs/
bun test extensions/fast-implement/
bun test extensions/shared/
bun test skills/reflect/
bun test skills/architect/
bun test skills/decision-trail/
bun test skills/recall/
bun test skills/setup-kstack/
bun test skills/personalize/skill.test.mjs
bun test skills/investigation-model.test.mjs
bun run test:sqlite
```

The `git-worktrees` planner and inspector are Node TypeScript CLIs:

```bash
bun test skills/git-worktrees/
```

The package also includes the skills listed in the table above. Pi discovers them when this repository is installed with `pi install`. Most skills can load automatically when a task matches their description or can be invoked with `/skill:<name>`. `architect` and `decision-trail` are explicit-only — one launches several design runs, the other adds a log a routine change doesn't need; invoke them with `/skill:architect` and `/skill:decision-trail`.

Skill eval workspaces live under `.workspace/` (gitignored) so test runs and review pages never dirty the repository.

See the [session archive README](extensions/session-archive/README.md) for commands, storage paths, recovery behavior, and security limitations.
