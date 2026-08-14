# kstack

kstack = "Krishnan's Stack". Named as an homage to [`pstack`](https://github.com/cursor/plugins/tree/main/pstack), which it is heavily inspired by.

Krishnan's personal extensions for [Pi](https://pi.dev).

> Pi extensions execute with your full user permissions. Review extension code before installing it.

## Extensions

| Extension | Description |
| --- | --- |
| [`steering-swap`](extensions/steering-swap/) | Swaps Enter and Alt+Enter in the main editor while Pi is working (Enter queues a follow-up, Alt+Enter steers) without breaking Enter for idle submission, autocomplete, or inline prompts. |
| [`kstack-router`](extensions/kstack-router/) | Optional front door: `/kstack [--route <id>] [--single|--stack] [--worktree] [--change-kind <kind>] [--] <task>` routes tasks through a classifier to the appropriate workflow and proof-obligation playbook. |
| [`session-archive`](extensions/session-archive/) | Moves completed Pi sessions—including a multi-selected batch of inactive sessions—out of the active session directory, preserves their canonical JSONL, and indexes them locally with SQLite/FTS5. |
| [`handoff`](extensions/handoff/) | Opens a lean replacement session from one editor confirmation, optionally on a chosen or inherited model and effort, then gives read-only tools for normalized, on-demand access to the linked session's active or archived history. |
| [`panel-review`](extensions/panel-review/) | Runs 2–5 isolated read-only reviewer subagents in parallel against the current Git changeset and synthesizes a lead-review verdict, with a live multi-agent TUI dashboard. |
| [`plan-implement`](extensions/plan-implement/) | Selects or accepts a change kind, plans with a high-reason model, pauses for approval, implements on a dedicated branch with incremental local commits, runs panel review, addresses findings, then publishes a draft PR with reviewer recommendations and can optionally hand the published PR to `/land`. Supports local jj stacks and isolated managed Git worktrees. |
| [`pr-autopilot`](extensions/pr-autopilot/) | Bounded post-PR autopilot using only tiny models (GPT-5.6 Luna, Gemini 3.7 Flash, DeepSeek V4 Flash). Drives an open PR frontier through comments-first triage, CI watch, and fix → push → recheck, stopping at merge-ready. Never auto-merges, never rebases shared history. |
| [`land`](extensions/land/) | Confirmation-gated landing of an exact, merge-ready GitHub PR head. Reuses pr-autopilot readiness, respects branch protection and merge queues, and verifies remote merge state. |

Writable workstreams start on a dedicated `kstack/<task-slug>` branch and commit
coherent increments as work proceeds. They stop on a dirty current working tree
and never push or publish without a later confirmation. Read-only routes do not
create branches.

## Skills

| Skill | Description |
| --- | --- |
| [`create-pi-extension`](skills/create-pi-extension/) | Designs and implements Pi extensions using the installed documentation, repository patterns, lifecycle/security ground rules, and an incremental verification checklist. |
| [`create-skill`](skills/create-skill/) | Creates, tests, and improves Pi skills: draft, headless with-skill vs baseline eval runs, grading, benchmark aggregation, a static review page, and description/trigger optimization. |
| [`find-reviewers`](skills/find-reviewers/) | Recommends the 2–5 best pull-request reviewers for any git change by analyzing commit history, CODEOWNERS, adjacent-domain ownership, and author identities, returning a prioritized, evidence-backed list with a review order. |
| [`arena`](skills/arena/) | Spawns N parallel candidates at the same task, cross-judges them, picks the strongest as a base, grafts the best parts from the losers, and verifies the synthesized result. |
| [`architect`](skills/architect/) | Grounds a change, explores structurally distinct caller-first designs through Arena, and implements against the synthesized type and module contract. Explicit invocation only. |
| [`swarm`](skills/swarm/) | Fans out N parallel workers across different slices of a task (partition, race, or mix), aggregates results, and returns one consolidated report. |
| [`jj-stacked-prs`](skills/jj-stacked-prs/) | Manages linear stacks of GitHub pull requests on top of a Jujutsu working copy — create, edit, absorb, sync with trunk, publish with the bundled `publish_stack.py`, and advance after a merge. Read-only inspection helper, confirmed mutations, no silent publication. |
| [`git-worktrees`](skills/git-worktrees/) | Creates, inspects, repairs, and safely cleans up Git linked worktrees managed beneath `~/.pi/kstack/worktrees`, with dirty-state and ownership checks before removal. |
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

Model assignments for panel-review, plan-implement, arena, swarm, and the
`how` and `why` investigation skills live in a single unified config file:
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`).

Copy the starter and edit:

```bash
cp kstack.example.json ~/.pi/agent/kstack.json
```

See [`kstack.example.json`](kstack.example.json) for the full schema. Each
section is optional — missing sections use built-in defaults or prompt for
models at runtime. To discover the local Pi model catalog, validate selected
providers, preview the update, and write only the user configuration, run:

```text
/skill:setup-kstack
```

`setup-kstack` does not modify repository defaults unless you explicitly ask for
a separate follow-up change.

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
- Node.js 22 or newer
- A local filesystem for Pi's agent directory

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

Without `--change-kind`, the command asks you to select one before planning. It
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
/skill:jj-stacked-prs
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
are created. Publishing the stack with the bundled `publish_stack.py` is a separate, confirmed
step guided by the [`jj-stacked-prs`](skills/jj-stacked-prs/) skill.

After a draft PR is published, hand it to the bounded PR autopilot to drive
the review/fix/CI loop with only tiny models:

```text
/pr-autopilot --mode drive            # comments → watch CI → fix → push until merge-ready
/pr-autopilot --mode watch            # same loop with more cycles, watching pending checks
/pr-autopilot --mode check            # one status pass, report, stop
/pr-autopilot --mode threads          # address review comments only, then push
/pr-autopilot --mode cleanup          # after merge: remove managed worktree and branch
/pr-autopilot --mode drive --pr 42    # run on a specific PR instead of auto-detecting
/land --pr 42 --method squash          # confirm and land the exact merge-ready head
/land --pr 42 --readiness watch        # let autopilot watch first, then confirm landing
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
npm test
```

Check TypeScript types before submitting changes:

```bash
npm run typecheck
```

For focused runs, use the individual test commands:

```bash
node --test install.test.mjs
node --test extensions/steering-swap/*.test.ts
node --test extensions/session-archive/*.test.ts
node --test extensions/handoff/*.test.ts
node --test extensions/panel-review/*.test.ts
node --test extensions/plan-implement/*.test.ts
node --test extensions/kstack-router/*.test.ts
node --test extensions/pr-autopilot/*.test.ts
node --test extensions/shared/*.test.ts
node --test skills/reflect/*.test.mjs
node --test skills/architect/*.test.mjs
node --test skills/decision-trail/*.test.mjs
node --test skills/recall/*.test.mjs
node --test skills/setup-kstack/*.test.mjs
node --test skills/investigation-model.test.mjs
```

The router also has a headless smoke test that registers the real extension
against a mock Pi and drives the dispatch lifecycle (tool gating, playbook
injection, restoration, delegation):

```bash
node extensions/kstack-router/scripts/smoke-mock-pi.mjs
```

The package also includes the `create-pi-extension`, `create-skill`, `find-reviewers`, `arena`, `architect`, `swarm`, `jj-stacked-prs`, `git-worktrees`, `simplify`, `unslop`, `technical-writing`, `typescript-best-practices`, `blast-radius`, `reflect`, `decision-trail`, `how`, `why`, `recall`, `setup-kstack`, and `tdd` skills. Pi discovers them when this repository is installed with `pi install`. Most skills can load automatically when a task matches their description or can be invoked with `/skill:<name>`. `architect` and `decision-trail` are explicit-only — one launches several design runs, the other adds a log a routine change doesn't need; invoke them with `/skill:architect` and `/skill:decision-trail`.

Skill eval workspaces live under `.workspace/` (gitignored) so test runs and review pages never dirty the repository.

### Skill tests

The `jj-stacked-prs` skill includes Python tests for its bundled publisher and inspector:

```bash
python3 -m unittest discover -s skills/jj-stacked-prs/tests -p 'test_*.py'
node --test skills/jj-stacked-prs/skill.test.mjs
```

Validate all Python scripts compile:

```bash
python3 -m py_compile skills/jj-stacked-prs/scripts/*.py
```

### Session archive smoke test

The full smoke test starts isolated Pi RPC processes, archives an unnamed inactive fixture and a named live session, makes a few small model calls, and does not touch the normal Pi session directory:

```bash
python3 extensions/session-archive/scripts/e2e-smoke.py
```

See the [session archive README](extensions/session-archive/README.md) for commands, storage paths, recovery behavior, and security limitations.
