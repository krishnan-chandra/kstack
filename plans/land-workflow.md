# Land workflow for kstack

## Status

Implementation plan for another model. This file is a read-only specification: do not edit it while implementing unless the user explicitly asks. Execute every numbered item; report omitted work as `skip: <reason>` rather than silently dropping it.

## Goal

Add a deterministic, confirmation-gated landing workflow that composes with `pr-autopilot`, can be invoked directly, and is offered as the final optional phase of `plan-implement` after successful draft publication.

The workflow must reuse `pr-autopilot` for review-thread and CI readiness instead of duplicating that state machine. Its own responsibilities are the irreversible final mile:

1. pin a specific PR and exact head SHA;
2. obtain fresh merge-ready evidence from `pr-autopilot`;
3. show the exact merge operation and obtain explicit confirmation;
4. merge or enqueue through GitHub without bypassing branch protection;
5. verify the remote merge rather than trusting command exit status;
6. for a jj stack, advance the local stack, republish the rewritten remainder through the existing two-phase publisher, and continue at the next frontier;
7. stop safely and report recovery information after any partial failure.

## Done predicate

The change is done when all of the following are true:

- `/land` can land one ordinary GitHub PR after a fresh `pr-autopilot` readiness check.
- `/land` can land a linear jj PR stack bottom-to-top, one confirmed frontier at a time, using the existing `jj-stacked-prs` inspection and publication contracts.
- `plan-implement` offers an optional `pr-autopilot watch -> land` continuation only after the publisher has completed and the published target has been resolved independently from live GitHub/local state.
- No path merges a draft, stale head, failing/pending CI state, unresolved review thread, conflicting/behind PR, or GitHub-blocked PR.
- No path uses `--admin`, bypasses branch protection, directly force-pushes a jj bookmark, guesses among repositories/remotes/PRs, or treats a successful `gh pr merge` exit as proof that the PR landed.
- Every GitHub and jj mutation is preceded by a fresh state check and an explicit confirmation that names the PR, URL, head SHA, merge method, and stack consequences.
- Cancellation and partial failure leave an honest, recoverable result, including the latest jj operation ID when local stack history was touched.
- Focused extension tests, jj helper tests, all affected extension suites, and an isolated GitHub/jj smoke test pass.

## Current behavior and constraints

### `pr-autopilot`

- `extensions/pr-autopilot/autopilot.ts` already owns target discovery, review-thread/CI snapshots, exact-head settle reads, draft-to-ready confirmation, bounded watches, fixes, pushes, and the `isMergeReady` predicate.
- `runAutopilot("check", ...)` performs two fresh reads and can return a structured `AutopilotResult` with the exact verified `PRState`.
- `runAutopilot("watch", ...)` drives the frontier until merge-ready or blocked.
- `extensions/pr-autopilot/index.ts` already has an event-bus request contract, but it is embedded in the adapter, accepts `mode: string`, resolves completion as `void`, and therefore cannot give a caller structured readiness evidence.
- Autopilot deliberately never merges, never restacks, and never rewrites shared history. Preserve those invariants.
- Autopilot's target fallback (`findLowestUnmergedPR`) is acceptable for its interactive command but is too broad for an irreversible landing request. Land must use an explicit PR or a target derived from the current workstream branch/local jj stack.

### `plan-implement`

- `extensions/plan-implement/index.ts` currently runs planner -> implementer -> panel review -> review fixer -> publisher, then terminates.
- Publication is independently confirmed and creates/updates draft PRs. The publisher final text is prose and must not be parsed as a machine-readable PR manifest.
- Single-PR mode already retains `workstreamCheckpoint.branch`; managed worktree mode retains the same branch and worktree path.
- Stack mode already has a validated colocated jj workspace and the `jj-stacked-prs` skill, but it does not retain a structured post-implementation stack manifest.
- `WorkflowLifecycle` phases stop at `publishing`; the abort shortcut only owns child processes. A nested land request must have its own cancellation lifecycle and must not be represented as a plan-implement child.

### `jj-stacked-prs`

- `skills/jj-stacked-prs/scripts/inspect_stack.py` is the canonical read-only local stack model and reports stable change IDs, commit IDs, bookmarks, top, blockers, and truncation.
- `skills/jj-stacked-prs/scripts/publish_stack.py` is the canonical push/base-repair mechanism. Its `plan` is read-only and its `apply` rejects stale plan IDs. Reuse it; do not issue direct force-pushes from the land extension.
- The documented advance operation is: verify the bottom PR merged, abandon only the merged segment while local bookmarks still exist, fetch, rebase the remaining selected stack onto `trunk()`, inspect, then preview/confirm/apply publication repair.
- A final-slice merge needs an executable and tested cleanup rule; the existing prose only spells out the case where a next bookmark remains.

## Product contract

### New extension and command

Create `extensions/land/` with a thin Pi adapter and the command:

```text
/land [--pr <number>] [--top <bookmark>] [--method merge|squash|rebase] [--readiness check|watch]
```

Defaults:

- `--readiness check`: land is a final gate by default, not another long-running fixer. A user who wants babysitting can run `/pr-autopilot --mode watch` first or choose `--readiness watch`.
- No implicit merge method. If `--method` is absent, use `ctx.ui.select` after querying the repository's allowed merge methods. Never choose an unsupported method or fall through to an interactive `gh` prompt.
- No `--admin`, force, branch-protection bypass, or automatic local/remote branch deletion option.

Target rules:

1. `--pr` targets exactly that PR and is single-PR mode unless `--top` is also supplied and the PR is proven to be the bottom bookmark of that selected jj stack.
2. `--top` selects a local jj stack. Resolve the bottom PR by matching the bottom bookmark to one open GitHub PR head in the current repository.
3. With neither flag, first inspect for an unambiguous jj stack rooted at `trunk()`; otherwise resolve the open PR whose head is the current Git branch.
4. Never fall back to the globally lowest PR authored by the user. Ambiguous/no-match results stop before mutation and list the candidates/evidence.
5. Repository identity comes from the current checkout through authenticated `gh`; no arbitrary `--repo` input in the first version.

The command lands an ordinary PR once. For a selected stack, it loops bottom-to-top until the stack is complete, a frontier is blocked, the user declines a merge or republish confirmation, cancellation occurs, or a partial failure occurs.

### Plan-implement integration

After a publisher result with `status === "completed"`:

1. Independently resolve the publication target:
   - single/worktree: query the open PR whose `headRefName` exactly equals `workstreamCheckpoint.branch`, and require one match;
   - stack: run the canonical inspector, require one unblocked/non-truncated selected stack, retain its explicit top bookmark, and require one open PR for every bookmark before offering landing.
2. If target resolution fails, keep the existing successful publication result, report why landing was not offered, and stop. Do not reinterpret publisher prose.
3. If the `land` or `pr-autopilot` event-bus listener is unavailable, report the optional continuation as unavailable without turning publication into a failure.
4. Ask: `Run PR autopilot watch and land this PR/stack now?` The body must say that this may mark drafts ready, push fixes after their existing confirmations, merge/enqueue PRs after a separate per-PR confirmation, and rewrite/republish the remaining jj stack after separate previews.
5. On approval, invoke the land API with `readiness: "watch"` and the exact resolved target. The land workflow itself invokes autopilot and owns all later confirmations.
6. Display the structured landing result as a `Land` card/summary after the existing Publisher card. Declining or a blocked landing does not retroactively fail implementation, review, or publication.

Do not add an unconditional `--land` behavior that silently merges every `plan-implement` run. The final continuation is always optional and explicitly confirmed. A future configuration default is out of scope.

### Router integration

Add a `land` route to `kstack-router` so explicit and classified requests such as "land this PR", "merge this stack", or "ship the merge-ready PR" dispatch to the land in-process API. Keep vague deployment/release requests unsupported. The router route must pass only parsed land options; it must not synthesize slash-command strings.

## Architecture

### 1. Structured autopilot API

Extract the embedded request contract from `extensions/pr-autopilot/index.ts` into `extensions/pr-autopilot/api.ts`.

Define a strict request/outcome contract:

```ts
interface PrAutopilotRequest {
  schemaVersion: 1;
  mode: AutopilotMode;
  prNumber: number;
  ctx: ExtensionCommandContext;
  claimed: boolean;
  completion?: Promise<AutopilotResult>;
}

type PrAutopilotRequestResult =
  | { handled: false }
  | { handled: true; outcome: AutopilotResult };
```

Requirements:

- Validate `mode` against the real `AutopilotMode` set, not `string`.
- Require an explicit positive PR number for API callers that can lead to landing. Keep the slash command's current optional auto-detection behavior internal to its adapter.
- Make the core adapter runner return `AutopilotResult` for every early error, decline, abort, and normal completion. Add a `declined` or equivalent explicit status if needed rather than encoding confirmation decline as an arbitrary blocker string.
- Preserve existing command rendering and notifications; command callers may ignore the returned object.
- Keep one-autopilot-per-session lifecycle enforcement.
- Add `api.test.ts` covering synchronous claim, awaited structured outcome, malformed modes/numbers, missing listener, one claimant, and listener failure propagation.

Do not move merge behavior into autopilot. The API is only a composability seam around its existing readiness state machine.

### 2. Land extension module split

Use this initial shape, adjusting only if implementation evidence supports a smaller split:

```text
extensions/land/
├── index.ts              # command/API registration, UI, lifecycle adapter
├── api.ts                # typed in-process request/response contract
├── command.ts            # strict args/token parsing
├── github.ts             # bounded typed gh queries, merge invocation, polling
├── target.ts             # single-PR and jj-stack target resolution
├── stack.ts              # inspector/publisher adapters and jj advance plan
├── orchestrator.ts       # deterministic state machine with injected effects
├── lifecycle.ts          # one active landing run, abort/poll cancellation
├── types.ts              # domain types, result states, limits
├── *.test.ts
└── README.md
```

Do not spawn an LLM. All decisions are state validation, user selection/confirmation, GitHub CLI calls, or canonical jj helper calls.

### 3. Land API

Expose `kstack:land:request` through `extensions/land/api.ts`:

```ts
type LandTarget =
  | { kind: "single"; prNumber: number; expectedHeadRef: string }
  | { kind: "stack"; topBookmark: string };

interface LandOptions {
  target: LandTarget;
  readiness: "check" | "watch";
  method?: "merge" | "squash" | "rebase";
}

interface LandRequest {
  schemaVersion: 1;
  options: LandOptions;
  ctx: ExtensionCommandContext;
  claimed: boolean;
  completion?: Promise<LandResult>;
}
```

`LandResult` must be structured and bounded. Include:

- terminal status: `landed | partially-landed | blocked | declined | aborted | failed`;
- each frontier PR number, URL, expected head SHA, method, and state (`landed | queued | blocked | not-attempted`);
- whether autopilot ran and its terminal status;
- stack top and remaining bookmarks;
- completed local/remote mutations;
- latest/recovery jj operation ID when applicable;
- actionable blockers without raw unbounded command output.

The request must be claimed synchronously and awaited like the existing panel-review and plan-implement APIs.

### 4. GitHub boundary

Implement typed wrappers around `gh`, with injected `ExecFn`, bounded timeout/output, and strict JSON parsing.

Read-only snapshot must include at least:

- repository `nameWithOwner` and default branch;
- allowed merge methods (merge commit, squash, rebase) and whether merge queue/auto-merge behavior is relevant, using documented `gh` JSON/GraphQL fields verified against the installed CLI;
- PR number, URL, title, state, draft flag, head/base refs, exact head OID, mergeability/merge-state, merged timestamp, and merge commit OID;
- the open PR mapping for a set of exact head refs/bookmarks.

Merge execution:

- immediately before confirmation, obtain a fresh autopilot `check`/`watch` result for the exact PR;
- require `status === "merge-ready"`, `mergeReady === true`, and `prState.verifiedHeadSha === prState.headSha`;
- show PR URL, base/head refs, full or abbreviated pinned SHA, selected method, and whether GitHub may enqueue rather than merge immediately;
- after confirmation, re-read the PR and require the same open, non-draft head SHA;
- call `gh pr merge <number> --<method> --match-head-commit <sha>` (or the documented merge-queue-safe equivalent discovered during implementation);
- never add `--admin`, `--delete-branch`, or an unconfirmed `--auto`;
- if repository policy requires a merge queue, allow GitHub's normal queue path but report `queued` distinctly until remote state becomes `MERGED`;
- poll `gh pr view` with cancellation and bounded backoff until `MERGED`, a terminal non-merged state, head drift, or the wall-clock limit. A queued-but-not-yet-merged timeout is `partially-landed`, not success;
- verify `state === MERGED`, `mergedAt` is present, the merged PR's head ref/head OID match the pinned target, and a merge commit OID is present when GitHub supplies one.

Default limits in `types.ts`:

- individual `gh` query: 15 seconds;
- merge command: 60 seconds;
- poll interval: 10 seconds;
- maximum landing wait per PR: 30 minutes;
- max stack slices: 20;
- retained stderr/diagnostic text: 8 KiB.

Use an abort controller owned by the land lifecycle because command contexts normally have no active `ctx.signal`. Register a dedicated shortcut (for example Ctrl+Shift+L) and document that aborting cannot undo a merge or dequeue an already accepted merge automatically.

### 5. Target resolution

Single target:

- require authenticated `gh` and one repository;
- resolve by explicit PR or exact current/workstream branch;
- if both are supplied, require agreement;
- reject closed/merged PRs unless this is an idempotent resume of a previously started landing result;
- do not require the local branch to equal the PR head for read-only readiness/merge operations, but require repository identity and exact expected head-ref agreement.

Stack target:

- invoke `skills/jj-stacked-prs/scripts/inspect_stack.py --repo <cwd> --top <top>` through `pi.exec("python3", ...)` with shell disabled;
- verify schema version, non-truncated output, no blockers, a linear stack, one bookmark per PR boundary, and at most the configured slice limit;
- derive bookmark order base-to-top using the same semantics as `derive_slices`; prefer adding a machine-readable `slices` array to the inspector model rather than reimplementing bookmark-boundary rules in TypeScript. Update the Python model/tests and keep old fields compatible;
- query open PRs once and require exactly one PR for each bookmark head. Validate each PR base is the previous bookmark (bottom targets the default branch);
- use the bottom slice as the only current frontier.

### 6. jj advancement

Add a deterministic, stale-state-protected advance helper under `skills/jj-stacked-prs/scripts/`, rather than embedding fragile revset assembly throughout the extension:

```text
advance_stack.py plan  --repo <path> --top <bookmark> --merged-bookmark <bookmark> --expected-head <sha>
advance_stack.py apply --repo <path> --top <bookmark> --merged-bookmark <bookmark> --expected-head <sha> --plan-id <id>
```

This belongs with `jj-stacked-prs` because it defines canonical jj history behavior and should also be usable outside `/land`.

`plan` must be read-only and return bounded JSON containing:

- current stack model and slices;
- merged slice and next slice, if any;
- exact revsets/commands to abandon and rebase;
- current `trunk()` commit, bookmark targets, working-copy change ID, and latest jj operation ID;
- a deterministic plan ID over all mutation-relevant local state;
- blockers for conflict, divergence, merge commits, truncation, missing bookmarks, mismatched expected head, a merged bookmark that is not the bottom slice, or dirty/unmodeled working-copy content.

`apply` must recompute and reject a stale plan before mutation. It must:

1. capture and return the pre-mutation jj operation ID;
2. abandon only the merged segment while the local bookmark still exists;
3. if slices remain, fetch the selected remote, rebase only the selected remaining stack onto `trunk()`, and leave unrelated bookmarks untouched;
4. if the final slice was merged, remove the completed local stack safely and leave a usable empty working-copy change on current `trunk()`; prove the exact final-slice revset in fixture tests before adopting it;
5. run the inspector after mutation and return the post-state plus the latest operation ID;
6. stop on conflicts/blockers and never use `--ignore-immutable`, direct Git rebase/reset, or force-push.

Remote selection must be explicit in the helper/API once more than one GitHub remote exists. If exactly one GitHub remote exists it may be selected deterministically; otherwise prompt before any stack mutation.

After a successful local advance with remaining slices:

1. invoke `publish_stack.py plan` for the retained top bookmark/remote;
2. show its exact bounded JSON plan and ask a separate confirmation to republish rewritten bookmarks and repair bases;
3. invoke `publish_stack.py apply --plan-id <id>` only after confirmation;
4. treat `partial`, `stale_plan`, `blocked`, and comment errors honestly;
5. re-inspect the stack and re-query all remaining PR head/base mappings before moving to the next frontier.

The original merge cannot be rolled back by jj recovery. On local advance failure, report the remote PR as merged plus `jj undo`/`jj op restore <pre-op-id>` guidance. On publisher failure, keep the locally advanced stack, report which actions completed, and require a fresh publisher plan on retry.

### 7. Orchestrator state machine

Implement a pure/injected orchestrator with these phases:

```text
resolve-target
-> readiness (autopilot check/watch)
-> preview-merge
-> confirm-merge
-> revalidate-head
-> merge-or-enqueue
-> verify-remote-merge
-> [stack only] plan-advance
-> confirm-advance
-> apply-advance
-> inspect
-> [remaining stack] plan-republish
-> confirm-republish
-> apply-republish
-> verify-frontier
-> repeat or finish
```

Rules:

- Only one land run per session. A second request is rejected.
- Each frontier gets a fresh autopilot run; never reuse readiness evidence from the prior slice.
- Each merge gets its own confirmation. An initial stack confirmation is not blanket authority to merge later PRs whose state was unknown at that time.
- The advance confirmation shows the exact helper plan and recovery operation ID.
- The republish confirmation remains separate because it can force-update every remaining bookmarked branch through the canonical publisher.
- If autopilot is unavailable, blocked, incomplete, declined, aborted, or failed, stop before merge and preserve its structured reason.
- If GitHub says the PR is already merged, only resume stack advancement when its head ref/OID match the expected bottom slice and the local model still contains that slice. Otherwise stop as ambiguous.
- If the session shuts down, abort polling/subprocesses, invalidate stale callbacks, and leave already-completed external mutations reported in the result.

### 8. Pi adapter and rendering

`extensions/land/index.ts` should:

- register `/land`, its argument completions for finite enum values, the abort shortcut, a compact `land` message renderer, and the event-bus listener;
- require `ctx.hasUI`, call `ctx.waitForIdle()`, and use only normal dialogs (`select`, `confirm`, notifications); no custom TUI component is needed;
- keep `index.ts` limited to registration, Pi context adaptation, progress status, and result rendering;
- render collapsed status as one line and expanded status as the per-frontier table plus recovery details;
- clear status in every exit path and perform no startup/background work in the factory.

## Ordered implementation steps and commit checkpoints

### Commit 1: Make pr-autopilot composable with structured outcomes

Files:

- create `extensions/pr-autopilot/api.ts` and `api.test.ts`;
- edit `extensions/pr-autopilot/index.ts`, `autopilot.ts`, `types.ts`, and affected tests/README.

Work:

- extract/strictly validate the event-bus API;
- return `AutopilotResult` from the adapter for all paths;
- preserve slash-command behavior and the no-merge invariant;
- require exact PR numbers for API calls;
- add tests for structured completion and lifecycle/error paths.

Verification checkpoint:

```bash
node --test extensions/pr-autopilot/*.test.ts
```

### Commit 2: Add canonical stack-slice and advance helpers

Files:

- edit `skills/jj-stacked-prs/scripts/stack_model.py` and inspector tests to expose stable slices;
- create `skills/jj-stacked-prs/scripts/advance_stack.py` plus focused Python tests;
- update `skills/jj-stacked-prs/SKILL.md`, `references/workflows.md`, and `references/safety-and-recovery.md`.

Work:

- add backward-compatible slice output;
- implement read-only plan/stale-plan apply;
- cover remaining-stack and final-slice cases in temporary colocated jj repositories;
- capture operation IDs and bounded partial results.

Verification checkpoint:

```bash
python3 -m unittest discover -s skills/jj-stacked-prs/tests -p 'test_*.py'
python3 -m py_compile skills/jj-stacked-prs/scripts/*.py
node --test skills/jj-stacked-prs/skill.test.mjs
```

Do not proceed until the final-slice fixture proves the cleanup revset and resulting working-copy state.

### Commit 3: Implement the deterministic land core

Files:

- create `extensions/land/types.ts`, `command.ts`, `github.ts`, `target.ts`, `stack.ts`, `orchestrator.ts`, and colocated tests.

Work:

- strict command parsing and target resolution;
- GitHub repository/PR/merge-policy snapshots;
- exact-head merge invocation and bounded verification polling;
- autopilot API composition;
- stack inspector/advance/publisher adapters;
- deterministic orchestration with injected exec, confirm, clock/sleep, and abort dependencies.

Verification checkpoint:

```bash
node --test extensions/land/{command,github,target,stack,orchestrator}.test.ts
```

### Commit 4: Wire `/land` and its in-process API

Files:

- create `extensions/land/api.ts`, `lifecycle.ts`, `index.ts`, API/lifecycle/adapter tests, and `README.md`.

Work:

- command/API registration;
- UI selections and confirmation previews;
- one-run/session cancellation;
- compact result card and bounded failure reporting;
- document security, cancellation, merge queue behavior, partial failure, and recovery.

Verification checkpoint:

```bash
node --test extensions/land/*.test.ts
pi -e extensions/land/index.ts
```

The load smoke test must not invoke `/land` against a real repository.

### Commit 5: Add the optional terminal phase to plan-implement

Files:

- edit `extensions/plan-implement/index.ts`, `lifecycle.ts`, `types.ts`, `README.md`, and focused tests;
- add a small deterministic publication-target resolver module if needed rather than expanding `index.ts` further.

Work:

- retain/resolve exact post-publish target state without parsing publisher prose;
- after successful publication, offer the optional watch-and-land continuation;
- invoke `requestLand` with `readiness: "watch"`;
- display result without changing the already-completed publish outcome;
- represent parent progress as `landing` while leaving cancellation to the land lifecycle;
- ensure publisher decline/failure never triggers landing.

Verification checkpoint:

```bash
node --test extensions/plan-implement/*.test.ts
```

### Commit 6: Router and package documentation

Files:

- edit the kstack-router route types/catalog/classifier/dispatch/playbook and tests;
- add `extensions/kstack-router/playbooks/land.md` if route-specific framing is useful;
- edit root `README.md`, `kstack.example.json` only if a landing limit becomes configurable, and development test commands.

Work:

- route explicit landing intent to the typed API;
- keep deploy/release/destructive ambiguity unsupported;
- add root extension table entry and command examples;
- make clear that autopilot gets a PR ready while land performs the confirmed merge/stack advance.

Verification checkpoint:

```bash
node --test extensions/kstack-router/*.test.ts
node --test install.test.mjs
```

### Commit 7: Whole-workflow regression and smoke tests

Run:

```bash
node --test extensions/pr-autopilot/*.test.ts \
  extensions/land/*.test.ts \
  extensions/plan-implement/*.test.ts \
  extensions/kstack-router/*.test.ts \
  extensions/panel-review/*.test.ts \
  extensions/shared/*.test.ts
python3 -m unittest discover -s skills/jj-stacked-prs/tests -p 'test_*.py'
python3 -m py_compile skills/jj-stacked-prs/scripts/*.py
node --test skills/jj-stacked-prs/skill.test.mjs
```

Add an isolated smoke script that creates:

- a temporary bare Git remote and colocated jj workspace for local advance behavior;
- a disposable GitHub test repository or fully mocked `gh` executable for merge/queue state transitions.

The default smoke path must make no real GitHub mutation. Any optional live GitHub smoke test must name the repository and PR, require an explicit environment opt-in, use a disposable fixture PR, and disclose the mutation before running.

Smoke scenarios:

1. single PR: autopilot check returns merge-ready, confirmation accepted, exact-head merge succeeds, remote verification reports merged;
2. head changes between readiness and merge: no merge command is issued;
3. queue path: command is accepted, polling reports queued, then merged;
4. queue timeout: result is partial, not landed;
5. two-slice jj stack: bottom merges, local advance rewrites only the remainder, publisher stale-plan protection works, next frontier becomes selectable;
6. final jj slice: local stack cleanup leaves a valid empty working copy on trunk;
7. cancellation during polling and during a subprocess;
8. publication/advance partial failure includes completed actions and recovery operation ID;
9. plan-implement publisher success -> optional land accepted; publisher decline/failure -> no land request.

## Test matrix

At minimum, cover these failure boundaries with deterministic tests:

| Boundary | Required assertion |
| --- | --- |
| malformed `/land` flags | rejected before GitHub/jj calls |
| missing `gh` auth/repository | no mutation; actionable blocker |
| ambiguous branch or bookmark-to-PR mapping | no mutation; candidates reported |
| autopilot listener absent | no merge offered |
| autopilot non-ready/blocked/aborted | exact status propagated; no merge |
| draft or unverified/stale head | no merge |
| method unsupported by repository | selection rejected; no merge |
| confirmation declined | no merge and `declined` result |
| head drift after confirmation | `--match-head-commit` not relied on alone; stop before merge |
| merge command error | no local jj advance |
| merge command success but remote still open | queued/partial, never false success |
| wrong merged head/ref | no jj advance |
| stack inspector blocker/truncation | no merge/advance |
| merged bookmark not bottom | no advance |
| stale advance plan | no jj mutation |
| jj advance conflict/partial failure | remote merge retained; recovery op reported |
| republish declined/partial | local state retained; exact remaining work reported |
| session shutdown | abort active work; stale callbacks do not render/mutate |
| second concurrent land run | rejected |

## Security and trust boundary

- GitHub PR titles, bodies, comments, check names/logs, and CLI stderr are untrusted data. Land does not send them to a model, but still bounds and treats them only as display/evidence.
- Use `pi.exec`/argument arrays with `shell: false`; never interpolate user input into shell source.
- Validate PR numbers, bookmark/ref names, repository identity, merge methods, JSON schemas, plan IDs, and head SHAs.
- Revalidate at the irreversible boundary: after confirmation and immediately before merge/advance/apply.
- Never print tokens, remote credentials, full environment, or unbounded command output.
- Confirmations are accidental-misuse controls, not a sandbox. Document that extensions execute with the user's full GitHub and filesystem permissions.
- Do not allow arbitrary repository paths through the public command/API. Plan-implement may pass its already-owned managed-worktree path internally after containment/ownership checks.

## Failure and recovery policy

- Before merge: all failures are non-mutating and return `blocked`, `declined`, `aborted`, or `failed` precisely.
- After GitHub accepts a merge/queue request: report `partially-landed` until remote `MERGED` proof exists.
- After remote merge but before local jj advance: report the PR as landed and the stack as not advanced; rerunning `/land --top ...` must detect and resume this state safely.
- After jj mutation failure: include pre/post operation IDs and recommend `jj op show`, `jj undo`, or `jj op restore` without running recovery automatically.
- After republish partial failure: include publisher completed/failed actions and require a fresh `publish_stack.py plan`; never issue an ad hoc force-push.
- A rerun must be idempotent at every phase and must not try to merge an already merged PR twice.

## Explicit non-goals

- Replacing or weakening `pr-autopilot`'s CI/review/fix state machine.
- Automatic merges without a per-PR user confirmation.
- Admin merges, branch-protection bypass, direct force-push, history repair by guessing, or automatic rollback of a GitHub merge.
- Supporting non-GitHub forges, Graphite commands, merge-commit stacks, parallel/multi-base jj stacks, or deployment/release automation.
- Automatically deleting remote branches, cleaning managed worktrees, or archiving Pi sessions. Existing `pr-autopilot cleanup`, `git-worktrees`, and `session-archive` remain explicit follow-ups.
- Persisting a daemon across sessions to wait indefinitely for reviews. A land run is bounded; rerun it after a blocker clears.
- Parsing model/publisher prose as machine-readable workflow state.

## Documentation updates

- New `extensions/land/README.md`: command/API, target rules, autopilot composition, methods/merge queues, confirmations, jj advancement, limits, cancellation, partial failure, recovery, tests, and non-goals.
- `extensions/pr-autopilot/README.md`: document the structured API and point merge-ready users to `/land`; retain the no-merge invariant.
- `extensions/plan-implement/README.md`: add the optional terminal continuation after publication and make clear that declining it leaves the existing draft-publish workflow unchanged.
- `skills/jj-stacked-prs` docs: make `advance_stack.py` canonical and keep manual commands as recovery/reference.
- Root `README.md`: add Land to the extension table and show:

```text
/pr-autopilot --mode watch --pr 42
/land --pr 42 --method squash
/land --top auth-stack --readiness watch
```

## Implementation cautions

- `plans/` is currently ignored by `.gitignore`; this specification exists locally for execution but will not appear in a normal commit unless the repository's plan-file policy is intentionally changed.
- Verify the installed `gh` version and supported `gh pr merge` flags before coding. In particular, test the exact behavior of `--match-head-commit` and merge queues rather than assuming it.
- Do not let `extensions/plan-implement/index.ts` grow another deeply nested phase. Extract target resolution and terminal-phase orchestration into testable modules.
- Do not import Python internals into TypeScript. Treat the scripts as bounded JSON subprocess contracts.
- Keep the landing workflow deterministic. No planner, fixer, triager, or synthesis model belongs in the new extension.
