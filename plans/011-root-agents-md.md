# Plan 011: Add a root AGENTS.md

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `ls AGENTS.md 2>/dev/null` — if it exists, STOP
> (done independently). Also `git diff --stat d0a9409..HEAD -- README.md package.json`
> to learn whether plans 002/003 landed (they change the commands you document).

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — documentation only.
- **Depends on**: none (content improves if 002/003 landed; write for the
  current state of the repo either way)
- **Category**: dx
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

This repo is *built for* agent workflows — its own extensions spawn Pi
children into it, and its plans are executed by agent models — yet it has no
root `AGENTS.md`. Every agent session re-derives the basics: how to run
tests (a 14-line README block), that there is (at `d0a9409`) no typecheck,
that `plans/` is gitignored working state, that extensions must follow the
ground-rules file hidden under `skills/create-pi-extension/references/`, and
that branch names follow `kstack/<slug>`. Panel-review's own bundle logic
(`review-scope.ts` `CONTEXT_FILE_NAMES`) treats AGENTS.md as a first-class
context file — the repo already expects one to exist.

## Current state

- No `AGENTS.md` or `CLAUDE.md` at the repo root (verified at `d0a9409`).
- Authoritative sources to distill (read all four before writing):
  - `README.md` — extension/skill tables, config section, Development section.
  - `skills/create-pi-extension/references/ground-rules.md` — repository
    shape, lifecycle invariants, trust/security rules.
  - `install.mjs` header + README install instructions.
  - Observed conventions from git history: branch prefix `kstack/`,
    imperative commit subjects, PR numbers appended by squash-merge.
- Convention for content files in this ecosystem: concise, imperative,
  agent-addressed; panel-review injects them into children, so keep it short
  (target ≤ 60 lines) — a bloated AGENTS.md taxes every child model's context.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests (pre-002) | `node --test extensions/session-archive/*.test.ts` etc. | `fail 0` |
| Tests (post-002) | `npm test` | `fail 0` |

## Scope

**In scope**:
- `AGENTS.md` (create)
- `README.md` (one line linking to AGENTS.md, optional)

**Out of scope**:
- Any code or skill file; the ground-rules document itself (link, don't move)

## Git workflow

- Branch: `kstack/root-agents-md`
- Single commit: `Add root AGENTS.md`. Do NOT push or open a PR unless
  instructed.

## Steps

### Step 1: Write AGENTS.md

Sections (keep each to a few lines):

1. **What this repo is** — Pi extensions (`extensions/`) + skills (`skills/`);
   extensions run with full user permissions inside Pi.
2. **Verify** — the exact test command(s) that exist at the time of writing
   (per-directory `node --test` globs, or `npm test` / `npm run typecheck`
   if plans 002/003 landed — check `package.json`).
3. **Conventions** — TypeScript ESM run by Node ≥22 type-stripping; colocated
   `*.test.ts` with `node:test`; `index.ts` stays a thin Pi adapter; domain
   logic in named modules with injected effects; no runtime dependencies
   without strong justification.
4. **Ground rules** — one line linking
   `skills/create-pi-extension/references/ground-rules.md` as mandatory
   reading before touching `extensions/`.
5. **Git** — branch `kstack/<task-slug>`, imperative commit subjects, never
   push/publish without explicit confirmation.
6. **Layout notes** — `plans/` is gitignored advisor/executor working state;
   `config/pi-defaults/` is merged by `install.mjs`; `kstack.json` lives at
   `$PI_CODING_AGENT_DIR/kstack.json`, never in-repo.

**Verify**: `wc -l AGENTS.md` → ≤ 70. Every command named in section 2 runs
successfully when copy-pasted.

### Step 2: Cross-link from README

Add one line near the top of README's Development section pointing agents at
AGENTS.md.

**Verify**: `grep -n "AGENTS.md" README.md` → one hit.

## Test plan

Not applicable (docs). Gate: every command stated in AGENTS.md must be
executed once and exit 0 before commit.

## Done criteria

- [ ] `AGENTS.md` exists, ≤ 70 lines, all stated commands verified by running them
- [ ] `git status` shows only AGENTS.md (+ README.md if cross-linked)
- [ ] `plans/README.md` status row updated

## STOP conditions

- An AGENTS.md appears upstream mid-task (drift check).
- You cannot verify a command you want to document — omit it or fix the
  premise; never document an unverified command.

## Maintenance notes

- Plans 002/003 change the verify commands; whoever lands last updates
  AGENTS.md section 2 (one line each).
- Keep it short forever: panel-review children receive this file in context
  on every review of this repo.
