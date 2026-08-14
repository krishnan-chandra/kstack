# Plan 005: Extract one shared kstack.json loader from four config modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/panel-review/config.ts extensions/plan-implement/config.ts extensions/pr-autopilot/config.ts extensions/kstack-router/config.ts extensions/shared/`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED — config parsing is pure and fully tested in all four
  extensions; risk is behavioral divergence being unified incorrectly.
- **Depends on**: plans/003-typecheck-gate.md
- **Category**: tech-debt
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

Four extensions each re-implement the same base layer for the unified config
file `$PI_CODING_AGENT_DIR/kstack.json`:

- `extensions/panel-review/config.ts` (400 lines)
- `extensions/plan-implement/config.ts`
- `extensions/pr-autopilot/config.ts` (278 lines)
- `extensions/kstack-router/config.ts`

Each has its own copy of: `getAgentDir` (env override + `~/` expansion),
`getKstackPath`, read-file-and-parse-JSON-object, a
`loaded | missing | invalid` result union, a `provider/model` regex, and a
thinking-level enum. `install.mjs` carries a fifth `getAgentDir`/`expandHome`
whose `~` handling already differs (it expands bare `~`; the extension copies
only handle `~/`). A change to config discovery — a new env var, a schema
version, better error messages — currently means five edits.

The per-extension *section* schemas (reviewers vs roles vs tiny models vs
classifier) are genuinely different and stay put; only the shared base moves.

## Current state

- Common shape, from `extensions/pr-autopilot/config.ts:40-48`:

```ts
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}
export function getKstackPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "kstack.json");
}
```

  (session-archive has its own `getAgentDir` in `archive-files.ts` that also
  `resolve()`s the result — it reads session/archive dirs, not kstack.json;
  unify it only if trivially compatible, otherwise leave and note it.)
- Thinking levels: `["off","minimal","low","medium","high","xhigh","max"]`
  appear in pr-autopilot (`THINKING_LEVELS`), plan-implement, panel-review,
  kstack-router, and handoff's `model-selection.ts`.
- Model-id regex `/^[^/\s]+(\/[^/\s]+)+$/` (or equivalent) appears in each.
- Each config module has a colocated `config.test.ts` (e.g. panel-review's is
  396 lines) — these define exact error-message expectations. **Error message
  text is part of the contract**; when unifying, keep each extension's
  messages unless the tests are updated deliberately.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Full tests | `npm test` | exit 0, `fail 0` |
| Focused | `node --test extensions/<name>/config.test.ts` | `fail 0` |

## Scope

**In scope**:
- `extensions/shared/kstack-config.ts` (create) + `kstack-config.test.ts`
- The four `config.ts` files above (consume the shared base)
- Their `config.test.ts` files (only import-path updates; assertions unchanged)
- `extensions/handoff/model-selection.ts` (thinking-level enum import only)

**Out of scope**:
- `install.mjs` (works, tested, ships standalone — note the `~` divergence in
  the shared module's docstring instead)
- `extensions/session-archive/archive-files.ts` `getAgentDir` (different
  concern: filesystem roots, plus `resolve()` semantics)
- Any schema change to kstack.json itself
- Model *resolution* logic (registry lookups differ per extension by design)

## Git workflow

- Branch: `kstack/shared-kstack-config`
- Commits: shared module first, then one commit per consuming extension.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the shared base module

`extensions/shared/kstack-config.ts` exporting:

```ts
export function getAgentDir(env?: NodeJS.ProcessEnv): string;      // handle "~" and "~/"
export function getKstackPath(env?: NodeJS.ProcessEnv): string;
export type SectionLoad<T> =
	| { status: "loaded"; config: T; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };
/** Read kstack.json, return the named section as unknown for the caller's validator. */
export function loadKstackSection(
	section: string,
	env?: NodeJS.ProcessEnv,
): { status: "found"; value: unknown; path: string } | { status: "missing"; path: string } | { status: "invalid"; path: string; error: string };
export const THINKING_LEVELS: readonly ["off","minimal","low","medium","high","xhigh","max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_ID_RE: RegExp;
export function isThinkingLevel(v: unknown): v is ThinkingLevel;
```

Behavior notes: "file absent" and "file present but section absent" must both
map to what each extension currently treats as `missing` (verify against each
config.test.ts before assuming). A file that is not a JSON object is
`invalid` with the extension's current message shape.

Improve on the copies in one way: support a bare `~` in
`PI_CODING_AGENT_DIR` like `install.mjs` does.

**Verify**: `node --test extensions/shared/kstack-config.test.ts` → `fail 0`
(write tests first for: env override, `~`/`~/` expansion, default path,
missing file, invalid JSON, non-object root, section missing, section found).

### Step 2: Migrate each extension's config.ts

For each of the four, delete its local `getAgentDir`/`getKstackPath`/raw-read
code and thinking-level/model-regex constants; import from
`../shared/kstack-config.ts`; keep all section validation and every error
message byte-identical.

**Verify after each**: `node --test extensions/<name>/config.test.ts` →
`fail 0` **without modifying its assertions** (import-path edits only), then
`npm run typecheck` → exit 0.

### Step 3: Point handoff's thinking-level enum at the shared constant

`extensions/handoff/model-selection.ts` defines its own effort-level list;
re-export or import `THINKING_LEVELS`/`isThinkingLevel` if the lists are
identical. If handoff's list differs deliberately (check its tests), leave it
and record why in the shared module's docstring.

**Verify**: `node --test extensions/handoff/*.test.ts` → `fail 0`.

### Step 4: Confirm deduplication

**Verify**: `grep -rln "PI_CODING_AGENT_DIR" extensions/ --include="*.ts" | grep -v test | grep -v shared/` →
only `extensions/session-archive/archive-files.ts` remains.

## Test plan

- New: `extensions/shared/kstack-config.test.ts` (cases in Step 1).
- The four existing `config.test.ts` suites pass with unchanged assertions —
  that is the primary regression proof.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with `fail 0`
- [ ] Grep in Step 4 shows only archive-files.ts
- [ ] No config.test.ts assertion text changed (`git diff -- '**/config.test.ts'` shows import lines only)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Two extensions turn out to treat "file exists but section missing"
  differently (one prompts, one defaults) in a way the shared `loadKstackSection`
  cannot express without changing behavior — report the matrix first.
- Any existing config test requires an assertion change to pass.

## Maintenance notes

- New extensions (and the future land-workflow) should consume this module
  from day one; mention it in `skills/create-pi-extension/references/ground-rules.md`
  the next time that file is edited (not in this plan's scope).
- Reviewer: check the `missing`-semantics table in the PR description against
  each extension's README claim ("missing sections use built-in defaults or
  prompt at runtime").
