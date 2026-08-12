# kstack

kstack = "Krishnan's Stack"

Krishnan's personal extensions for [Pi](https://pi.dev).

> Named as an homage to [`pstack`](https://github.com/cursor/plugins/tree/main/pstack), which it is heavily inspired by.

> Pi extensions execute with your full user permissions. Review extension code before installing it.

## Extensions

| Extension | Description |
| --- | --- |
| [`session-archive`](extensions/session-archive/) | Moves completed Pi sessions out of the active session directory, preserves their canonical JSONL, and indexes them locally with SQLite/FTS5. |
| [`handoff`](extensions/handoff/) | Opens a lean replacement session with an editable reference prompt and read-only tools for normalized, on-demand access to the linked session's active or archived history. |
| [`panel-review`](extensions/panel-review/) | Runs 2–4 isolated read-only reviewer subagents in parallel against the current Git changeset and synthesizes a lead-review verdict. |

## Skills

| Skill | Description |
| --- | --- |
| [`create-pi-extension`](skills/create-pi-extension/) | Designs and implements Pi extensions using the installed documentation, repository patterns, lifecycle/security ground rules, and an incremental verification checklist. |
| [`create-skill`](skills/create-skill/) | Creates, tests, and improves Pi skills: draft, headless with-skill vs baseline eval runs, grading, benchmark aggregation, a static review page, and description/trigger optimization. |
| [`find-reviewers`](skills/find-reviewers/) | Recommends the 2–5 best pull-request reviewers for any git change by analyzing commit history, CODEOWNERS, adjacent-domain ownership, and author identities, returning a prioritized, evidence-backed list with a review order. |
| [`arena`](skills/arena/) | Spawns N parallel candidates at the same task, cross-judges them, picks the strongest as a base, grafts the best parts from the losers, and verifies the synthesized result. |
| [`swarm`](skills/swarm/) | Fans out N parallel workers across different slices of a task (partition, race, or mix), aggregates results, and returns one consolidated report. |

## Configuration

Model assignments for panel-review, arena, and swarm live in a single unified
config file: `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`).

Copy the starter and edit:

```bash
cp kstack.example.json ~/.pi/agent/kstack.json
```

See [`kstack.example.json`](kstack.example.json) for the full schema. Each
section is optional — missing sections use built-in defaults or prompt for
models at runtime.

## Requirements

- Pi 0.84.1 or newer
- Node.js 22 or newer
- A local filesystem for Pi's agent directory

The extensions use TypeScript directly through Pi's loader. No build or dependency installation is required.

## Install for the current user

This repository follows Pi's conventional package layout: extensions live under
`extensions/` and skills live under `skills/`. The recommended installation is
to register the whole checkout as a user-level Pi package:

```bash
cd /path/to/kstack
pi install "$PWD"
```

By default, `pi install` writes to the current user's global settings. It loads
all extensions and all skills in this repository across Pi projects; do not pass
`-l`, which would create a project-local installation instead.

Pi records a reference to the checkout rather than copying it. Pulling or editing
the repository updates the installed resources; use `/reload` in a running Pi
process, or restart Pi, after changes.

Inspect or enable the installed extensions and skills with:

```bash
pi list
pi config
```

Skills can then be invoked explicitly, for example:

```text
/skill:create-pi-extension
/skill:create-skill
/skill:find-reviewers
/skill:arena
/skill:swarm
```

To remove the package registration, run this from the same checkout:

```bash
pi remove "$PWD"
```

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

Run the extension tests from the repository root:

```bash
node --test extensions/session-archive/*.test.ts
node --test extensions/handoff/*.test.ts
node --test extensions/panel-review/*.test.ts
```

The package also includes the `create-pi-extension`, `create-skill`, `find-reviewers`, `arena`, and `swarm` skills. They are discovered when this repository is installed with `pi install`; invoke them explicitly with `/skill:create-pi-extension` or `/skill:create-skill`, or let Pi load them when extension- or skill-development work matches their descriptions.

Skill eval workspaces live under `.workspace/` (gitignored) so test runs and review pages never dirty the repository.

The full smoke test starts isolated Pi RPC processes, makes two small model calls, and does not touch the normal Pi session directory:

```bash
python3 extensions/session-archive/scripts/e2e-smoke.py
```

See the [session archive README](extensions/session-archive/README.md) for commands, storage paths, recovery behavior, and security limitations.
