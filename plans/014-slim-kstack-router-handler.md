# Plan 014: Slim the kstack-router command handler into a route-resolution module

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e18fff..HEAD -- extensions/kstack-router/`
> Plan 012 may have rewritten `lifecycle.ts` internals (public API unchanged);
> that is expected. Material drift in `index.ts` is a STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — the handler wires tool gating and session-token checks;
  a dropped guard is a real regression. Mitigation: pure extraction, the
  headless smoke test, and new unit tests on the extracted resolver.
- **Depends on**: plans/012-shared-session-lifecycle.md (soft — land 012
  first to avoid rebase churn in the same extension)
- **Category**: tech-debt
- **Planned at**: commit `7e18fff`, 2026-08-14

## Why this matters

This was deferred in the first audit round ("revisit after 008/009 land" —
both landed). `extensions/kstack-router/index.ts` is 524 lines and its
`/kstack` handler (~lines 178–510) interleaves five concerns: argument/editor
intake, classifier invocation with fallback-to-manual selection, route
override and delivery/change-kind resolution, dependency checking, and two
different dispatch styles (active-session tool-gating vs delegated). The
route-resolution logic — which route, which delivery, which change kind,
who decided (classifier vs override vs manual), which warnings — is pure
decision logic buried in UI plumbing with **no direct unit tests** (only the
end-to-end smoke script exercises it). It also contains a small latent bug
recorded in the first audit: in the delegated-route branch, `endDispatch` is
called after `await dispatchRoute(...)` and two `pi.sendMessage` calls with
**no try/finally** (index.ts:485–507) — an exception from `sendMessage`
leaves the dispatch token active and the router wedged ("A dispatch is
already active") until session restart.

## Current state

- `extensions/kstack-router/index.ts` at `7e18fff`:
  - `:178` `pi.registerCommand("kstack", …)` — the ~330-line handler;
  - `:485` `const result = await dispatchRoute(route, task, delivery, worktree, changeKind, dispatchToken, lifecycle, pi, ctx);`
  - `:507` `lifecycle.endDispatch(dispatchToken);` — reached only if nothing
    above threw; not in a `finally`;
  - the classifier block (~`:230–330`): resolve model → confirm/override
    select → fallback manual select → post-conditions
    (`--change-kind` only with route change, `--worktree` only with change,
    delivery selection for change route).
- Already-extracted neighbors to match: `args.ts` (parsing), `catalog.ts`
  (route metadata + `checkDependencies`), `classification.ts`
  (`formatRecommendation`, `buildRouteAlternatives`), `dispatch.ts`
  (`dispatchRoute`, `getRestrictedTools`), `classifier-runner.ts`. All have
  colocated tests — the extraction target joins this family.
- The smoke harness: `extensions/kstack-router/scripts/smoke-mock-pi.mjs`
  registers the real extension against a mock Pi (see
  `extensions/kstack-router/README.md` for its invocation). It must still
  pass unchanged.
- UI seams available for testing: the handler talks to
  `ctx.ui.notify/select/editor`, `ctx.getSystemPromptOptions`,
  `pi.getCommands`, `pi.setActiveTools`, `pi.sendMessage`,
  `pi.sendUserMessage` — the extracted resolver must depend on **narrow
  injected functions**, not on `ctx`/`pi` objects (match how
  `plan-implement/phases.ts` defines a `PhaseEffects` interface).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused | `node --test extensions/kstack-router/*.test.ts` | `fail 0` |
| Smoke | command named in `extensions/kstack-router/README.md` | exit 0 |
| Full | `npm test` | `fail 0` |

## Scope

**In scope**:
- `extensions/kstack-router/index.ts`
- `extensions/kstack-router/route-resolution.ts` (create) + `route-resolution.test.ts` (create)
- `extensions/kstack-router/scripts/smoke-mock-pi.mjs` — only if import paths
  force it (they should not)

**Out of scope**:
- `args.ts`, `catalog.ts`, `classification.ts`, `dispatch.ts`,
  `classifier-runner.ts`, `config.ts`, `types.ts`, playbooks, prompts
- Any user-visible string (notify/select/editor labels) — byte-identical
- Any change to tool-gating semantics or the before_agent_start/agent_settled
  wiring

## Git workflow

- Branch: `kstack/slim-router-handler`
- Commit per step. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix the dispatch bookkeeping leak (independent, first)

Wrap the delegated-route section (from `beginDispatch` success through the
final `sendMessage`) so `lifecycle.endDispatch(dispatchToken)` runs in a
`finally`. Preserve the exact current ordering on the success path (dispatch
→ result card → notify → endDispatch).

**Verify**: `node --test extensions/kstack-router/*.test.ts` → `fail 0`;
smoke test passes.

### Step 2: Extract route resolution

Create `route-resolution.ts` exporting a pure-ish resolver that owns the
decision pipeline, with injected effects:

```ts
export interface RouteResolutionEffects {
	notify(msg: string, level?: "info" | "warning" | "error"): void;
	selectRoute(title: string, options: Array<{ route: RouteId; label: string }>): Promise<RouteId | undefined>;
	selectOption(title: string, options: string[]): Promise<string | undefined>;
	runClassifier(input: { model: string; thinking?: string; task: string; timeoutSeconds?: number; signal: AbortSignal }): Promise<ClassifierRunResult>;
	isSessionCurrent(): boolean;
	beginClassifier(): AbortController | undefined;
	endClassifier(): void;
	setStatus(text: string | undefined): void;
}

export interface ResolvedRoute {
	route: RouteId;
	delivery: DeliveryRecommendation;
	changeKind: ChangeKind;
	overrode: boolean;
	modelSource: string;
	confidence?: string;
}

export async function resolveRoute(
	input: { parsedArgs: …; task: string; routerConfig: …; classifierResolution: … },
	fx: RouteResolutionEffects,
): Promise<ResolvedRoute | { cancelled: true } | { failed: string }>;
```

Move into it, verbatim where possible: the classifier invocation block, the
accept/override selection, the failed-classifier manual fallback, the
no-classifier manual fallback, and the post-conditions (`--change-kind`
route restriction, `--worktree` route restriction, delivery selection for
the change route). The handler keeps: arg parsing, editor intake, session
naming, dependency check, route-card rendering, and both dispatch styles.

**Verify**: `npm run typecheck` exit 0; router tests + smoke `fail 0`;
`wc -l extensions/kstack-router/index.ts` ≤ 330.

### Step 3: Unit-test the resolver

`route-resolution.test.ts`, with scripted effects (model on
`extensions/plan-implement/phases.test.ts` fakes), ≥7 cases:
1. explicit `--route` skips the classifier entirely;
2. classifier recommendation accepted → route + delivery + changeKind
   inherited, `overrode: false`;
3. user picks an alternative → `overrode: true`, recommendation's delivery
   and changeKind NOT inherited;
4. classifier failure → manual selection path, `overrode: true`;
5. classifier resolution error (no model) → manual fallback with the
   "No classifier available" title;
6. `--change-kind` with a non-change route → failed with the exact current
   warning string;
7. change route without delivery, not overridden → delivery select honored,
   "Cancel" cancels; overridden → defaults to `"single"` without a prompt.
Also: session-invalidated mid-flow (`isSessionCurrent()` flips false after a
select) → `{ cancelled: true }` and no further effect calls.

**Verify**: `node --test extensions/kstack-router/route-resolution.test.ts`
→ `fail 0`, ≥8 tests.

## Test plan

Step 3 list, plus the untouched smoke script as the integration gate.

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` exits 0 with `fail 0`
- [ ] Smoke script passes (command per router README)
- [ ] `extensions/kstack-router/route-resolution.ts` exists with ≥8 tests
- [ ] `wc -l extensions/kstack-router/index.ts` ≤ 330
- [ ] `grep -n "finally" extensions/kstack-router/index.ts` shows endDispatch
      in a finally for the delegated branch
- [ ] All notify/select strings byte-identical (spot-check in review)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The resolver cannot be separated from `ctx` without capturing it whole
  (some Pi call has no narrow seam) — name the call; do not pass `ctx` into
  the new module.
- The smoke script fails for any reason other than an import path you can
  fix within scope.
- Preserving exact strings conflicts with the extraction (a string is built
  from handler-local state the resolver doesn't have) — report rather than
  approximating.

## Maintenance notes

- New routes should extend `resolveRoute` + catalog entries, leaving the
  handler untouched.
- Reviewer: check every `isSessionCurrent` guard survived at the same await
  boundaries — compare guard counts before/after
  (`grep -c "isSessionCurrent" …/index.ts …/route-resolution.ts`).
