# Implementation Plans

Index maintained by the improve skill. Plan files are deleted once their
implementation ships and is verified; this README records what was done,
what was rejected, and why, so future audit rounds do not re-report settled
findings. Plan numbering is monotonic — the next new plan is `017`.

`land-workflow.md`, `jj-stacked-prs-extension.md`, and
`jj-stacked-prs-extension-rationale.md` in this directory are unrelated,
still-valid specifications (direction work), not numbered audit plans.

## Completed plans (files deleted after shipping)

Round 1 audit @ `d0a9409`, round 2 @ `7e18fff`. All 16 plans verified
complete on 2026-08-14: full suite green, typecheck clean.

| Plan | Title | Shipped as |
|------|-------|------------|
| 001  | Fix cross-process schema race in session-archive | PR #31 |
| 002  | Add root package.json and test scripts | PR #32 |
| 003  | Add a typecheck gate and fix all type errors | PR #33 |
| 004  | Extract one shared child-agent runner | PR #34 |
| 005  | Extract one shared kstack.json config loader | PR #35 |
| 006  | Fix pr-autopilot GitHub state-reading bugs | PR #36 |
| 007  | Guard panel-review against concurrent runs | PR #37 |
| 008  | Slim plan-implement/index.ts into phase modules | PR #38 |
| 009  | Split the pr-autopilot driver module | PR #39 |
| 010  | Cache parsed handoff history between tool calls | PR #40 |
| 011  | Add a root AGENTS.md | PR #41 |
| 012  | Extract one shared session-lifecycle core | PR #42 |
| 013  | Characterization tests for the pr-autopilot drive loop | committed 2026-08-14 |
| 014  | Slim the kstack-router command handler | committed 2026-08-14 |
| 015  | Extract panel-review's run pipeline into phase modules | PR #42 |
| 016  | Read-only transcript inspector overlay for panel-review | PR #44 |

Status values for future rows: TODO | IN PROGRESS | DONE | BLOCKED (with
one-line reason) | REJECTED (with one-line rationale)

## Findings considered and rejected

Round 2 (2026-08-14, @ `7e18fff`):

- **`noUncheckedIndexedAccess`**: measured at 197 new errors; `exactOptionalPropertyTypes`
  at 96. Large mechanical sweeps with modest payoff now that the strict baseline exists;
  revisit when the error counts drop naturally or a bug traces to unchecked indexing.
- **`github.ts` size** (719 lines): large but cohesive — flat, independently tested `gh`
  wrappers with no shared mutable state. Splitting adds navigation cost without reducing
  coupling. Not worth doing.
- **`handoff/index.test.ts` size** (849 lines): a test file; splitting has no leverage.

Round 1 (@ `d0a9409`):

- **Async `collectScope` in panel-review** (`review-scope.ts` uses `execFileSync` with a
  64 MB buffer on the extension-host event loop): the freeze is real but bounded and
  happens once, immediately before an interactive confirm. Low impact for typical diffs;
  not worth the refactor risk now.
- **Widen `isForbiddenStagingPath` blocklist** (`pr-autopilot/github.ts`): the blocklist
  (.env, workflows, keys) can't be complete by construction, and the fixer's diff is
  user-confirmed before push. Recorded as a known limitation, not a plan.
- **In-process request/claim pattern duplicated** across plan-implement, panel-review, and
  pr-autopilot `api.ts`/`index.ts`: rejected at three copies ("extraction would add
  coupling for ~40 saved lines"). NOTE: re-opened in the round-3 audit after `land`
  added a fourth copy.
- **`sendPhaseMessage(pi, mode, phase, 0, …)` always reports cycles=0 during pr-autopilot
  runs** (`pr-autopilot/index.ts`): cosmetic; folded into plan 009's scope notes.

Round 3 (2026-08-14, @ `98d65f3`) — audit complete, plan selection pending:

- **Splitting `pr-autopilot/driver.ts`'s drive loop** (~300 lines): a cohesive state
  machine with characterization tests from plan 013. Not worth doing.
- **Retiring the `autopilot.ts` re-export shim**: tests intentionally exercise the
  public surface through it. Not worth doing.
- **Direct tests for `shared/pi-json-lines.ts`**: thoroughly exercised via both
  runner test suites. Not worth doing.
- **Untested `index.ts` adapters**: accepted by the repository's extension ground
  rules (thin adapters; deterministic logic lives in tested named modules).
