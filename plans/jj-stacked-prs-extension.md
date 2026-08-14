# Pi-native stacked PR publishing

## Status

Proposed architecture. This document stops at the design checkpoint. It does not authorize implementation or remote mutation.

## Goal

Move stacked PR reconciliation from `skills/jj-stacked-prs/scripts/*.py` into a Pi extension without turning the work into a line-for-line TypeScript port.

The extension must own deterministic inspection, planning, confirmation, stale-state checks, and remote mutation. The skill must continue to own local `jj` workflow guidance: shaping a stack, editing a middle change, absorbing fixes, syncing with trunk, and advancing after a merge.

The migration is complete when:

- direct users can inspect and publish a linear bookmark stack through Pi;
- `plan-implement` calls a typed in-process API instead of asking a child agent to run `publish_stack.py`;
- model-callable tools remain read-only;
- stack publication cannot begin without an exact Pi confirmation;
- the TypeScript engine preserves current blocker, ordering, idempotency, and partial-failure behavior;
- the Python publisher and Python runtime requirement are removed after parity is proven.

## Current contract

The current implementation has three callers:

1. A user follows `skills/jj-stacked-prs/SKILL.md` and invokes `inspect_stack.py` or `publish_stack.py`.
2. A `plan-implement` implementer or fixer consults the skill for local stack operations but never publishes.
3. A `plan-implement` publisher child invokes the Python plan/apply workflow after the parent asks for broad publication approval.

The migration must preserve these invariants:

- One bookmark is one PR boundary. Several `jj` changes can belong to one slice.
- A selected stack is linear and rooted at `trunk()`.
- Inspection and planning do not fetch, install, mutate, or initiate authentication. GitHub planning uses credentials that `gh` already resolves and can fail when they are absent.
- Publication pushes only selected bookmarks through `jj`.
- Missing PRs are drafts. Existing PR title, body, and draft state remain unchanged during stack reconciliation.
- Higher PRs target the bookmark below them. The bottom PR targets the GitHub default branch.
- Existing PR bases can be repaired after restacking.
- Navigation comments are kstack-owned and updated instead of duplicated.
- A stale plan performs no mutation.
- A partial apply is not rolled back. Recovery is a fresh plan against the resulting state.
- The subsystem never merges, marks ready, assigns reviewers, deletes branches, or uses raw Git force-push.

## Caller experience

### Direct interactive use

A user inspects a stack:

```text
/jj-stack inspect --top auth-rollout
```

The command shows the base-to-top stack, blockers, and publication readiness. It does not mutate.

A user previews publication:

```text
/jj-stack plan --top auth-rollout --remote origin
```

The command shows the exact bounded action summary and a short display form of the plan ID. It does not create an executable persisted plan.

A user publishes:

```text
/jj-stack publish --top auth-rollout --remote origin
```

The extension:

1. computes a fresh plan;
2. shows the exact push, draft-creation, base-repair, and comment actions;
3. asks for confirmation through `ctx.ui.confirm`;
4. recomputes the snapshot and plan;
5. refuses all mutation if either identity changed;
6. applies actions base to top;
7. reports completed actions, PR URLs, comment errors, and recovery instructions.

The command requires `ctx.hasUI`. It works in TUI and RPC modes. It fails closed in print and JSON modes because those modes cannot provide a confirmation dialog.

### Model use

The extension registers two read-only tools:

```ts
jj_stack_inspect({
  repoPath?: string,
  top?: string,
  trunkRevset?: string,
  maxStack?: number,
}): StackInspectionSummary
```

```ts
jj_stack_plan({
  repoPath?: string,
  top: string,
  remote: string,
  trunkRevset?: string,
  maxStack?: number,
}): StackPublicationSummary
```

Each Pi `execute` handler returns `{ content, details }`. `content` contains the bounded human summary and an honest truncation notice. `details` contains the validated typed summary, also bounded to the declared stack limit. The signatures above describe `details`, not the raw Pi tool-result envelope.

The extension does not register an apply tool. A plan ID proves state identity, not user approval. Tool prose cannot turn a model call into an authorization boundary.

### `plan-implement` use

Stack mode replaces child-driven reconciliation with one typed request:

```ts
const publication = await requestStackPublication(
  pi,
  {
    repositoryPath: workflowCwd,
    trunkRevset: "trunk()",
  },
  ctx,
  signal,
);
```

`requestStackPublication` asks the stacked-PR extension to plan, show the exact actions, confirm, stale-check, and apply. The caller receives a typed outcome and a bookmark-to-PR map. The typed helper does not accept preapproval. As with every Pi extension API, this protects against accidental misuse by normal callers, not a malicious loaded extension. Extensions already run with full user permissions and can invoke `jj` or `gh` directly.

After reconciliation, `plan-implement` prepares bounded, mode-`0600` inputs for a read-only publisher child: each slice diff, current PR metadata, and reviewer-ownership evidence collected by trusted parent code. The child runs with only `read,grep,find,ls` and returns a validated structured proposal containing titles, bodies, and reviewer recommendations. It cannot execute `jj`, `git`, or `gh`.

The parent displays the proposed title/body changes and asks for a second confirmation. A narrow parent-owned GitHub adapter applies title/body updates only to PR numbers in the returned publication map. Reviewer recommendations are display-only.

This creates two exact approval boundaries in stack mode:

1. publish the stack reconciliation plan;
2. apply the displayed title/body updates to the resulting PRs without changing draft state.

Single-PR mode keeps its current publisher flow until a separate migration adopts the same read-only proposal pattern.

## Public extension contract

### Command

Register one command with three subcommands:

```text
/jj-stack inspect [--top <bookmark>] [--trunk <revset>] [--max-stack <n>]
/jj-stack plan --top <bookmark> --remote <name> [--trunk <revset>] [--max-stack <n>]
/jj-stack publish --top <bookmark> --remote <name> [--trunk <revset>] [--max-stack <n>]
```

The command adapter validates arguments and delegates to one service. It does not reproduce domain rules.

### Read-only tools

Register `jj_stack_inspect` and `jj_stack_plan` with TypeBox schemas. Both tools:

- use `ctx.cwd` unless `repoPath` is supplied;
- canonicalize and validate the repository path;
- accept bounded values only;
- return at most 50 slices and 50 KiB of model-facing text;
- disclose truncation;
- never fetch or mutate.

### Event-bus API

Expose two claimed/completion request helpers in `api.ts`.

The read-only request supports callers that need structured planning without model mediation:

```ts
export interface StackPlanRequestInput {
  repositoryPath: string;
  topBookmark?: string;
  remote?: string;
  trunkRevset?: string;
  maxStack?: number;
}

export function requestStackPlan(
  pi: ExtensionAPI,
  input: StackPlanRequestInput,
  signal?: AbortSignal,
): Promise<
  | { handled: true; outcome: StackPlanOutcome }
  | { handled: false }
>;
```

The deep publication request owns the whole mutation boundary:

```ts
export function requestStackPublication(
  pi: ExtensionAPI,
  input: StackPlanRequestInput,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<
  | { handled: true; outcome: StackPublicationOutcome }
  | { handled: false }
>;
```

The event contract follows the repository's synchronous claim pattern:

```ts
export const STACK_PLAN_REQUEST_EVENT = "kstack:jj-stacked-prs:plan-request";
export const STACK_PUBLICATION_REQUEST_EVENT = "kstack:jj-stacked-prs:publish-request";

interface StackPlanRequest {
  schemaVersion: 1;
  input: StackPlanRequestInput;
  signal?: AbortSignal;
  claimed: boolean;
  completion?: Promise<StackPlanOutcome>;
}

interface StackPublicationRequest {
  schemaVersion: 1;
  input: StackPlanRequestInput;
  ctx: ExtensionCommandContext;
  signal?: AbortSignal;
  claimed: boolean;
  completion?: Promise<StackPublicationOutcome>;
}
```

Each listener validates schema version, bounded strings/numbers, signal shape, context shape, and `claimed === false`. The first valid listener sets `claimed = true` synchronously and assigns `completion` before returning. Later listeners do nothing. A helper returns `handled: false` when no listener claims the request and awaits the promise only after a successful claim.

The publication listener must:

- reject a request without `ctx.hasUI`;
- validate the request;
- create a `PublicationInteraction` adapter around the supplied live Pi context;
- call `StackPublisher.publish` once;
- return its typed outcome.

`StackPublisher.publish` owns top and remote resolution, locking, planning, confirmation, stale checking, apply, and lock cleanup. The listener never coordinates those stages.
`pi.events` provides in-process composition, not caller authentication. Validate every request shape, but scope the confirmation guarantee to the command, tools, and trusted extension helpers shipped by kstack. A malicious loaded extension can forge an event context or bypass this subsystem and run `jj` or `gh` directly; ordinary extension code is not a sandbox. Within the supported surfaces, no request accepts a preapproved flag, grant string, or executable action list. None of kstack's registered model tools emits the publication event; a third-party custom tool is arbitrary loaded extension code and is outside that guarantee.

### Top and remote discovery

Direct `plan` and `publish` commands require `--top` and `--remote`; explicit values keep shell-like use predictable.

The `plan-implement` event request may omit both values. The extension resolves them without model inference:

- inspect `trunk()..@` and accept an inferred top only when one unique topmost bookmark is the final PR boundary;
- reject inference when any non-empty unbookmarked change exists above that boundary, and report the excluded tail; an empty working-copy child is allowed;
- list Git remotes, parse their URLs, and accept an inferred remote only when exactly one resolves to GitHub;
- if several GitHub remotes exist, use `ctx.ui.select` before planning;
- include the selected top, remote name, remote URL fingerprint, and target GitHub repository in the confirmation and snapshot fingerprint.

A read-only event or tool request without UI returns a blocker when remote selection is ambiguous.

## Core types

External command output is untrusted until an adapter validates it into these domain types.

```ts
export interface StackCommit {
  changeId: string;
  commitId: string;
  subject: string;
  bookmarks: readonly string[];
  parents: readonly string[];
  empty: boolean;
  conflicted: boolean;
  divergent: boolean;
  merge: boolean;
  workingCopy: boolean;
}

export interface StackSlice {
  bookmark: string;
  baseBookmark: string | null;
  changeIds: readonly string[];
  subject: string;
}

export interface StackInspection {
  schemaVersion: 2;
  repositoryRoot: string;
  trunk: { revset: string; commitId: string };
  topBookmark: string | null;
  topCommitId: string | null;
  commits: readonly StackCommit[];
  slices: readonly StackSlice[];
  blockers: readonly StackBlocker[];
  truncated: boolean;
}
```

Blockers use stable codes plus human text. Callers can branch on the code without reconstructing policy from prose.

```ts
export type StackBlockerCode =
  | "missing-top"
  | "empty-stack"
  | "top-not-final-boundary"
  | "unresolved-revision"
  | "ambiguous-local-bookmark"
  | "missing-remote"
  | "ambiguous-remote"
  | "non-github-remote"
  | "not-rooted-at-trunk"
  | "conflict"
  | "divergence"
  | "merge"
  | "empty-boundary"
  | "empty-description"
  | "multiple-bookmarks"
  | "ambiguous-pr"
  | "remote-bookmark-conflict"
  | "ambiguous-navigation-comment"
  | "initial-title-too-long"
  | "truncated";

export interface StackBlocker {
  code: StackBlockerCode;
  message: string;
  changeId?: string;
  bookmark?: string;
}
```

A normalized snapshot contains every value that can change the action plan:

```ts
interface PublicationSnapshot {
  schemaVersion: 1;
  repositoryRoot: string;
  remote: { name: string; urlFingerprint: string };
  githubRepository: { owner: string; repo: string; defaultBranch: string };
  authenticatedGitHubLogin: string;
  inspection: StackInspection;
  localBookmarks: readonly BookmarkTarget[];
  remoteBookmarks: readonly BookmarkTarget[];
  matchingOpenPrs: readonly OpenPullRequest[];
  navigationComments: readonly {
    prNumber: number;
    commentId: number;
    author: string;
    bodyDigest: string;
    schemaVersion: number;
    etag: string;
  }[];
}
```

The snapshot fingerprint is the SHA-256 digest of a versioned canonical representation. The plan ID is a separate SHA-256 digest of the snapshot fingerprint, base-to-top `coreActions`, then base-to-top `commentActions`. Rendering, hashing, execution records, and parity fixtures use that same two-group canonical order. Comment actions are deferred until core processing stops or completes; they are not interleaved with core actions.

```ts
export interface StackPublicationPlan {
  schemaVersion: 2;
  snapshotFingerprint: string;
  planId: string;
  repository: string;
  remote: string;
  topBookmark: string;
  coreActions: readonly CorePublicationAction[];
  commentActions: readonly NavigationCommentAction[];
  blockers: readonly StackBlocker[];
}

export type CorePublicationAction =
  | { kind: "push-bookmark"; bookmark: string; localCommitId: string; remoteCommitId: string | null }
  | { kind: "create-draft-pr"; bookmark: string; targetBase: string; initialTitle: string; initialBody: string }
  | { kind: "repair-pr-base"; bookmark: string; prNumber: number; currentBase: string; targetBase: string; expectedEtag: string };

export interface NavigationCommentAction {
  kind: "reconcile-navigation-comment";
  bookmark: string;
  prNumber: number | null;
  templateVersion: number;
  expectedComment: { commentId: number; author: string; schemaVersion: number; bodyDigest: string; expectedEtag: string } | null;
}
```

The full digests stay internal. UI and model summaries can display a short prefix, but no API accepts a short prefix as identity. Every `create-draft-pr` action binds the exact initial title and body into the confirmed plan and plan ID. The confirmation renders every effect-bearing initial title and body in full; publication blocks if the complete bounded values cannot fit the confirmation contract.

The initial title is the trimmed first description line of the change that carries the slice bookmark. An empty title is the existing `empty-description` blocker. A title above 256 UTF-8 bytes is `initial-title-too-long`; the engine does not truncate it silently. The initial body is a versioned fixed template that names the validated bookmark and states that `plan-implement` may replace the text later. It is capped at 1 KiB. These normalization and template rules are versioned inputs to the plan ID. The later metadata phase can propose replacements.

Navigation comments are a bounded deterministic post-creation reconciliation policy because new PR numbers and URLs do not exist at confirmation time. More than one valid kstack-owned comment on one PR is `ambiguous-navigation-comment` and blocks publication; the engine neither selects nor deletes one. The confirmation shows the template version, target bookmarks, and a body preview with placeholders. For existing PRs, the snapshot and plan bind the matched comment ID, author, schema, body digest, and ETag. Immediately before an update, the GitHub adapter re-reads that comment and requires those values to match, then sends the PATCH with `If-Match`. A mismatch or HTTP 412 returns stale comment reconciliation and does not overwrite concurrent edits. Before a comment POST, the adapter re-lists comments and requires that no valid owned comment exists; a newly discovered comment returns stale instead of creating a duplicate. For new PRs, the plan binds `prNumber: null`, the bookmark, and template version. After core actions, the engine derives the final body only from the confirmed slice order and newly returned PR map. It never uses untrusted comment metadata to add targets or actions. The authenticated GitHub login is part of the snapshot because it controls comment ownership.
Publication returns a closed result union. Expected repository and remote states use `blocked`, `busy`, `stale`, or `partial`. `failed` is strictly pre-mutation: inspection, planning, confirmation, lock I/O, or subprocess setup can return it only while `completed` is empty. After the first mutation starts, a conclusive failure is `partial`; an uncertain response is `indeterminate`. Malformed output from a mutating command is uncertain. Every message is bounded and redacted. The public event helper resolves with the union for expected operational failures; programmer errors can still reject the completion promise.


```ts
export interface KnownPrMap {
  repository?: { owner: string; repo: string };
  remote?: string;
  topBookmark?: string;
  entries: readonly {
    bookmark: string;
    baseBookmark: string | null;
    changeIds: readonly string[];
    headRepository: string;
    prNumber: number;
    url: string;
    draft: boolean;
  }[];
}

export interface PublishedPrMap extends KnownPrMap {
  repository: { owner: string; repo: string };
  remote: string;
  topBookmark: string;
}
```

A `completed` map contains exactly one unique entry for every selected slice, in base-to-top order. The publisher validates completeness before returning it. Partial, cancelled, and indeterminate outcomes use `KnownPrMap`, which contains only PR identities proven by fresh reads. These slice descriptors let `plan-implement` materialize trusted diffs without reconstructing topology.

```ts
export type StackPublicationOutcome =
  | { status: "completed"; planId: string; completed: readonly CompletedAction[]; pullRequests: PublishedPrMap; commentErrors: readonly CommentError[] }
  | { status: "declined"; planId: string }
  | { status: "busy"; lockPath: string }
  | { status: "blocked"; blockers: readonly StackBlocker[] }
  | { status: "stale"; plannedId: string; currentId: string; currentSummary: StackPublicationSummary }
  | { status: "partial"; planId: string; completed: readonly CompletedAction[]; failed: FailedAction; pullRequests: KnownPrMap; commentErrors: readonly CommentError[] }
  | { status: "cancelled"; planId?: string; completed: readonly CompletedAction[]; pullRequests?: KnownPrMap }
  | { status: "indeterminate"; planId?: string; completed: readonly CompletedAction[]; inFlight: IndeterminateAction; reason: "cancelled" | "timeout" | "process-error" | "shutdown"; pullRequests: KnownPrMap }
  | { status: "failed"; phase: "inspect" | "plan" | "confirm"; message: string; completed: readonly [] };
```

## Internal service

`StackPublisher` is the deep module. Commands, tools, and event listeners call it directly. They do not coordinate its internal stages.

```ts
export class StackPublisher {
  constructor(
    private readonly stackRepository: StackRepository,
    private readonly pullRequests: PullRequestRepository,
    private readonly lock: PublicationLock,
    private readonly limits: StackPublisherLimits,
  ) {}

  inspect(input: StackInspectInput, signal?: AbortSignal): Promise<StackInspection>;

  plan(input: StackPlanInput, signal?: AbortSignal): Promise<StackPublicationPlan>;

  publish(
    input: StackPlanInput,
    interaction: PublicationInteraction,
    signal?: AbortSignal,
  ): Promise<StackPublicationOutcome>;

  shutdown(): Promise<{ settled: boolean }>;
}
```

`PublicationInteraction` is an internal adapter created from the live Pi context. It gives the deep publisher the two UI decisions it owns without exposing stage coordination to the event listener. The event payload never carries an approval boolean. The adapter passes the signal to each Pi dialog and checks `signal.aborted` after the dialog settles, so an externally aborted dialog returns `"cancelled"`. Standard `ctx.ui.confirm` reports both **No** and Escape as `false`; both are `"declined"` unless the signal is also aborted.

```ts
interface PublicationInteraction {
  chooseRemote(
    choices: readonly GitHubRemoteChoice[],
    signal?: AbortSignal,
  ): Promise<{ status: "selected"; remote: string } | { status: "cancelled" }>;

  confirm(
    summary: StackPublicationSummary,
    signal?: AbortSignal,
  ): Promise<"approved" | "declined" | "cancelled">;
}
```

`publish` follows this private state machine:

```text
snapshot -> plan -> render summary -> confirm
                              |
                              +-- declined -> stop

confirmed -> fresh snapshot -> fresh plan
                              |
                              +-- identity changed -> stale, zero mutations
                              |
                              +-- same identity -> apply coreActions base to top
                                                    |
                                                    +-- cancel before action -> cancelled, no comments
                                                    +-- uncertain in-flight action -> indeterminate, no comments
                                                    +-- conclusive core failure -> reconcile known-PR comments
                                                    |                              |
                                                    |                              +-- conclusive comment errors -> partial
                                                    |                              +-- uncertain comment -> indeterminate
                                                    +-- core success -> reconcile all comments
                                                                           |
                                                                           +-- conclusive comment errors -> completed with errors
                                                                           +-- uncertain comment -> indeterminate
                                                                           +-- success -> completed
```

The executable plan remains an immutable in-memory value for one request. The extension does not persist an action list that a later process can edit and execute. A later command always replans and confirms again.

All snapshot, action, fingerprint, and stale-check identities use full commit IDs. Short change IDs and commit IDs are display values only.

## Publication lock

Publication uses a cross-process, per-repository lock. Before it builds the plan that will be shown for confirmation, the extension atomically creates:

```text
$PI_CODING_AGENT_DIR/kstack/locks/stack-publication/<repository-identity-hash>/
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`. The lock directory contains a mode-`0600` metadata file with a random owner ID, PID, repository root, session ID when available, and creation time. The extension holds the lock through confirmation, stale checking, and apply. Cleanup in `finally` removes it only when the owner ID matches, every spawned mutator has closed, and no action remains in flight. Shutdown uses the same conditional cleanup. An indeterminate or unsettled process leaves the lock for manual recovery.

Contention fails closed with `status: "busy"`. V1 does not automatically break a lock left by a crashed process because PID reuse and uncertain in-flight remote mutation make automatic recovery unsafe. The error names the lock path and documents manual inspection and removal. Read-only inspect and plan calls do not acquire the lock.

The lock prevents two Pi processes on the same machine from confirming the same missing-PR plan and creating duplicates. GitHub and `jj` remain the final concurrency checks for actors on other machines.

`StackPublisher` retains the active publication promise, controller, lock owner, and current subprocess-close promise. `shutdown()` aborts the controller and awaits both subprocess closure and publication settlement through the kill grace period. It reports `settled: false` and leaves the lock when closure cannot be proven. `index.ts` awaits `shutdown()` from `session_shutdown`; it does not manipulate the lock directly.

## Effect boundaries

### `StackRepository`

The `jj` and read-only Git adapter owns:

- minimum `jj` version validation;
- workspace and colocated Git validation;
- exact single-revision resolution;
- strict `jj` template parsing;
- local and selected-remote bookmark snapshots;
- selected remote URL lookup and redaction;
- `jj git push --remote <remote> --bookmark <bookmark>`.

It does not fetch. It never invokes raw Git mutation.

### `PullRequestRepository`

The `gh` adapter owns:

- GitHub URL parsing;
- repository default-branch lookup;
- paginated open-PR lookup;
- exact head-repository and bookmark matching;
- draft PR creation;
- base-only PR repair;
- authenticated-user lookup;
- validated kstack navigation-comment upsert.

It does not edit existing PR title, body, or draft state.

### Bounded subprocess execution

Do not assume that `pi.exec` enforces a hard output-memory cap. Add `extensions/shared/bounded-process.ts`, now justified by two concrete mutation callers: the stacked-PR engine and `plan-implement` metadata adapter. Base it on the proven process lifecycle in `extensions/plan-implement/agent-runner.ts`:

- `shell: false` and argument arrays only;
- per-command timeout;
- `AbortSignal` support;
- bounded stdout and stderr buffers;
- process-group termination where the platform supports it;
- SIGTERM followed by a bounded SIGKILL grace period;
- no environment or credential logging;
- redacted, bounded diagnostics.

Keep stack-specific command policy, redaction, and parsing in each adapter. The shared module owns only process spawning, byte caps, timeout, signal composition, process-tree termination, and proven-close reporting.

## Confirmation and mode behavior

### TUI

Use standard `ctx.ui.confirm` for the mutation gate. A custom TUI component is optional polish, not part of the safety contract. If implementation adds `BorderedLoader`, guard it with `ctx.mode === "tui"` and connect its signal to the publisher.

### RPC

RPC has `ctx.hasUI === true`, so the standard confirmation dialog works through the RPC UI protocol. Do not call `ctx.ui.custom`.

### Print and JSON

The read-only tools work. `/jj-stack publish` fails closed because `ctx.hasUI === false`. Avoid writing arbitrary stdout from an extension command because that can corrupt JSON mode.

### Cancellation

The engine checks cancellation before each remote mutation and passes the signal into each subprocess and to `ctx.ui.select` or `ctx.ui.confirm`. Cancellation before a plan exists returns `cancelled` without a plan ID. It never starts another action after cancellation is observed.

Cancellation, timeout, shutdown, a process error, or lost output can occur after a remote accepted a mutation but before the adapter observed a conclusive response. In that case the result is `indeterminate` and records the in-flight action. The extension does not claim that the action failed or succeeded. Recovery requires a fresh plan.

If cancellation causes core execution to stop, the extension skips every remaining mutation, including navigation comments.

`StackPublisher` creates an extension-owned shutdown controller and combines it with the caller signal through `AbortSignal.any`. The combined signal is the only signal passed to interactions and subprocesses, so caller cancellation and shutdown cannot mask each other.

Sources of cancellation are:

- a caller-supplied signal on the event request;
- a TUI loader signal, if the command uses `BorderedLoader`;
- `session_shutdown`, which aborts any active extension-owned controller and awaits publication settlement.

Shutdown cleanup must not release the publication lock while a subprocess can still mutate the remote. The shutdown handler aborts, waits through process termination and the SIGKILL grace period, and removes the lock only after the process closes and the publication promise settles. If settlement cannot be proven, it leaves the lock for manual recovery.

RPC command cancellation needs an isolated smoke test before the README promises it. If Pi does not surface a usable signal to command handlers, v1 documents session shutdown as the RPC cancellation boundary.

Cancellation is not rollback. A fresh plan is the only retry path.

## Apply ordering and recovery

The engine executes core actions base to top:

1. push the slice bookmark if the selected remote target differs;
2. create the missing draft PR;
3. repair an existing PR base if needed.

Immediately before draft creation, the GitHub adapter re-queries the exact target repository, head repository, and bookmark and requires that no matching open PR exists. A newly discovered PR returns stale instead of creating a duplicate.

Before base repair, the GitHub adapter re-reads the PR and verifies repository, head repository, head bookmark, PR number, current base, and ETag. It sends the PATCH with `If-Match`; a changed value or HTTP 412 returns stale instead of overwriting another actor's update. Slice 2 must verify GitHub's conditional PATCH behavior against the disposable repository before TypeScript apply can be enabled. If GitHub does not honor `If-Match` for this endpoint, implementation returns to the design checkpoint rather than silently weakening the invariant.

A conclusive core failure stops later core actions. The result records every completed action and the first failed action. If cancellation, timeout, process failure, shutdown, or lost output leaves an action's remote outcome unknown, the result uses `indeterminate` instead of `failed` or `partial`.

Navigation comments are reconciliation work, not core publication. To preserve current Python behavior, the engine runs them after a conclusive non-cancellation core failure or complete core success. It builds comments from PRs that are known to exist and updates only validated kstack-owned comments. Cancellation skips comment mutations.

A conclusive GitHub rejection becomes a non-fatal `commentError` on `completed` or `partial`. Cancellation, timeout, shutdown, process error, or lost output during a comment POST/PATCH produces `indeterminate` with the comment action as `inFlight`; GitHub may have accepted it. Comment failures never roll back valid pushes or PR changes.

Recovery always uses a new plan:

- an already pushed bookmark becomes a no-op;
- a created PR is discovered and reused;
- a repaired base is already correct;
- a valid navigation comment is updated rather than duplicated.

The engine never resumes an old executable plan and never disables stale-state checks after partial failure.

## `plan-implement` integration

Stack mode changes as follows:

1. Keep planner, implementer, panel review, and fixer behavior unchanged.
2. Add the `jj-stacked-prs` extension to stack-mode preflight.
3. Replace the current broad stack publish confirmation and publisher-child reconciliation with `requestStackPublication`.
4. On `completed`, write the returned PR map, per-slice diffs, current PR metadata, and trusted reviewer-ownership evidence to the existing private review directory.
5. Run the publisher child with only `read,grep,find,ls`. Require a validated structured proposal for titles, bodies, and reviewer recommendations.
6. Display the exact proposed title/body updates and ask for confirmation.
7. Apply confirmed title/body updates through a narrow parent-owned GitHub adapter restricted to PR numbers in the publication map.

A busy, declined, blocked, stale, partial, cancelled, indeterminate, or failed reconciliation does not start the publisher child. The child cannot execute stack or GitHub mutations; this is enforced by its tool allowlist rather than its prompt.

`WorkflowLifecycle` gains parent-owned `stack-publishing` and `stack-metadata` phases, each with an `AbortController`. The existing abort shortcut and session-shutdown path abort the active controller. The existing child lifecycle still owns the read-only proposal child. Tests cover shortcut and shutdown cancellation before confirmation, between actions, during an in-flight publication subprocess, and during an in-flight metadata PATCH.

The parent derives neither topology nor remote policy. The stacked-PR extension returns the selected top and remote in its outcome after it performs unique inference or user selection.
## Skill ownership after migration

Keep `skills/jj-stacked-prs`.

The skill continues to teach:

- stack creation and boundary placement;
- edits in the middle of a stack;
- `jj absorb`;
- synchronization with trunk;
- review fixes in the correct slice;
- advancing after a merge;
- `jj op log` and `jj undo` recovery.

The skill changes its publishing guidance:

- direct users run `/jj-stack inspect`, `/jj-stack plan`, or `/jj-stack publish`;
- agents use the read-only tools;
- `plan-implement` uses the extension event API;
- the skill no longer instructs models to invoke an apply CLI.

The final target has no standalone Python CLI. The Python scripts remain during parity work, then are removed. If a future non-Pi caller needs read-only inspection, add a Node entry point that reuses the TypeScript domain code.

## Target module layout

Keep the call chain short and group modules by the knowledge they own:

```text
extensions/jj-stacked-prs/
├── index.ts                 # thin Pi registration and lifecycle adapter
├── api.ts                   # two claimed/completion event contracts
├── args.ts                  # /jj-stack parser and validation
├── types.ts                 # public domain and result types
├── stack.ts                 # stack normalization, blockers, and slice derivation
├── publication.ts           # snapshot fingerprint and ordered plan construction
├── publisher.ts             # deep inspect/plan/publish service and apply state machine
├── jj.ts                    # validated jj/Git adapter
├── github.ts                # validated GitHub/PR/comment adapter
├── process.ts               # stack command policy/redaction over shared bounded process
├── publication-lock.ts      # cross-process repository lock and ownership cleanup
├── render.ts                # bounded command/tool summaries
├── *.test.ts
└── README.md
```

Do not create a separate package during this migration. Extract a core package only after a second non-extension caller needs the pure domain API.

The stack-mode metadata phase adds two focused modules under `extensions/plan-implement/`:

```text
extensions/shared/
└── bounded-process.ts         # capped spawn, timeout, signals, process-close proof

extensions/plan-implement/
├── stack-publish-proposal.ts  # bounded child input/output schema and validation
└── stack-pr-metadata.ts       # narrow confirmed title/body update adapter
```

`stack-publish-proposal.ts` builds child inputs from parent-collected diffs, PR metadata, and bounded output from the existing reviewer analyzer. It validates one proposal per known bookmark, title/body byte limits, reviewer schema, duplicate entries, unknown PRs, and total output size. Each proposal binds the exact prior title, body digest, and PR ETag shown to the child.

`stack-pr-metadata.ts` pins the GitHub owner and repository from the publication outcome. Before every update it re-reads the PR and verifies the PR number, exact head repository, head bookmark, expected repository, prior title, prior body digest, and ETag. It rejects duplicate and unknown PR entries, changed identity, stale metadata, and any field other than title/body. The parent renders one immutable validated proposal, confirms its digest, and passes that same object to the adapter. The adapter applies exactly those title/body values with `If-Match` and never changes draft state. HTTP 412 is stale. Existing published PRs may be draft or non-draft.

Metadata updates run base to top under a separate `stack-metadata` lifecycle controller. They use this closed outcome:

```ts
type StackMetadataOutcome =
  | { status: "completed"; updated: readonly MetadataUpdate[] }
  | { status: "stale"; prNumber: number; reason: string; updated: readonly MetadataUpdate[] }
  | { status: "partial"; failed: FailedMetadataUpdate; updated: readonly MetadataUpdate[] }
  | { status: "cancelled"; updated: readonly MetadataUpdate[] }
  | { status: "indeterminate"; inFlight: IndeterminateMetadataUpdate; updated: readonly MetadataUpdate[] }
  | { status: "failed"; message: string; updated: readonly MetadataUpdate[] };
```

The adapter uses `extensions/shared/bounded-process.ts`. The parent checks cancellation before each update and passes the controller signal into `gh`. A timeout, shutdown, cancellation, process error, or lost response during a PATCH is indeterminate because GitHub may have accepted it. Recovery re-reads every PR before proposing or applying another metadata update.

`WorkflowLifecycle` retains the active metadata promise and process-close promise. Its async `session_shutdown` path aborts the controller, awaits process termination through the kill grace period, then awaits metadata settlement. If closure is uncertain, it reports an indeterminate update and does not claim clean completion.
## Migration plan

### Slice 1: Pin behavior and port inspection

- Convert the Python fixtures into language-neutral JSON fixtures.
- Keep the current Python characterization tests.
- Add TypeScript tests for strict parsing, blockers, top resolution, and slice derivation.
- Add `StackPublisher.inspect` and the `jj_stack_inspect` read-only tool.
- Keep all publication callers on Python.

Exit criterion: TypeScript inspection produces equivalent domain results and blocker codes for every fixture.

Rollback: remove the new extension; existing behavior is untouched.

### Slice 2: Port read-only planning

- Add GitHub and selected-remote read adapters.
- Add snapshot canonicalization, full SHA-256 fingerprints, plan construction, and bounded rendering.
- Register `/jj-stack inspect`, `/jj-stack plan`, and `jj_stack_plan`.
- Differentially compare Python and TypeScript action plans. Compare actions and blockers, not hash formatting.
- Keep Python apply authoritative.

Exit criterion: every fixture produces equivalent ordered actions, PR matching, bases, blockers, and comment intent.

Rollback: disable the new read-only surfaces.

### Slice 3: Add private TypeScript apply

- Add the private apply state machine and mutation adapter methods.
- Implement `/jj-stack publish` and the deep publication event listener behind a migration-only flag; keep both mutation surfaces disabled by default.
- Test stale plans, cancellation, first publication, restacks, partial failures, and comment reconciliation with fake executables.
- Run isolated apply characterization against fake `jj` and `gh` binaries that enforce the real command shapes and simulate every remote response class.
- Run an opt-in disposable-repository smoke test for first publication and restack repair before enabling TypeScript mutation.
- Do not run live GitHub mutation in the default automated suite.

Exit criterion: the TypeScript engine satisfies the current publication contract, matches normalized Python apply traces for shared scenarios, and performs zero mutation on declined, blocked, stale, or non-UI paths. Only then enable the command and listener.

Rollback: disable both `/jj-stack publish` and the mutation listener, then leave `plan-implement` and skill publishing on Python.

### Slice 4: Move `plan-implement`

- Require the new extension in stack preflight.
- Call `requestStackPublication` in the parent.
- Pass the returned PR map to the narrowed publisher child.
- Change `agent-runner.ts` so the stack-mode publisher role receives `--tools read,grep,find,ls`; do not rely on prompt prohibitions.
- Add the structured proposal validator and narrow metadata adapter.
- Replace the stack section of `prompts/publisher.md` so the child proposes metadata and reviewers but never publishes.
- Update `agent-runner.ts` output parsing for the validated structured proposal envelope.
- Update stack-mode skill policy and preflight: require the `jj-stacked-prs` extension for reconciliation, retain `write-pr` guidance only for prose quality, and remove obsolete Python publication instructions.
- Add tests for busy, declined, stale, partial, cancelled, indeterminate, missing-listener, malformed proposal, and completed outcomes.
- Keep single-PR behavior unchanged.

Exit criterion: no stack-mode child invokes Python, pushes bookmarks, creates PRs, repairs bases, or writes navigation comments.

Rollback: restore the old stack publisher child path while leaving the extension available for direct use.

### Slice 5: Remove Python publication

- Update the skill, references, evals, root README, and plan-implement README.
- Remove `publish_stack.py`, `github_stack.py`, `stack_model.py`, `inspect_stack.py`, and their Python tests.
- Remove the Python requirement from the package.
- If a future caller needs inspection outside Pi, add a Node-based read-only entry point in a separate change rather than retaining the Python runtime.
- Remove migration-only differential tests after retaining equivalent TypeScript fixtures.

Exit criterion: repository search finds no operational Python publisher reference, and all extension and skill tests pass.

## Test matrix

### Pure domain

- all existing blockers and stable blocker codes;
- multi-change slices;
- selected top is the final boundary;
- canonical snapshot ordering;
- full fingerprint and plan-ID determinism;
- wrong base, missing PR, existing PR, and ambiguous PR plans;
- exact base-to-top action ordering;
- authenticated GitHub login and existing navigation-comment identity/body digest affect stale identity;
- apply-time comment revalidation rejects changed ID, author, schema, or body digest;
- new-PR comment policy binds template version and selected slice order;
- full commit IDs in snapshots, actions, fingerprints, and stale checks;
- empty selected range maps to `empty-stack`.

### Adapters

- minimum `jj` version and workspace checks;
- local versus remote bookmark filtering;
- bookmark conflicts;
- HTTPS, SCP-style SSH, and `ssh://` GitHub URLs;
- credential redaction;
- pagination and exact head-repository matching;
- malformed or oversized output;
- timeout, abort, process error, and nonzero exit;
- shell-safe argument arrays.

### Publisher

- confirmation renders the selected repository, top, remote URL fingerprint, every core action, full bounded initial title/body, and versioned comment policy without truncation;
- the rendered confirmation comes from one immutable plan; the fresh plan has the same full fingerprint, plan ID, and canonical effect-bearing values, and only that matching fresh plan is applied;
- declined confirmation performs zero mutation;
- same-repository concurrent publication fails with `busy`;
- the lock is released on success, failure, decline, stale result, and owned shutdown cleanup;
- stale recomputation performs zero mutation;
- missing PRs are drafts;
- existing metadata remains unchanged except base repair;
- first-publication comments contain all created PR numbers;
- core failure stops later core actions;
- comment failure reports without rollback;
- cancellation stops before the next mutation and skips comments;
- cancellation, timeout, shutdown, process error, and lost output during a subprocess report an indeterminate in-flight action;
- lock cleanup waits for subprocess closure and leaves the lock when settlement is uncertain;
- replan after partial or indeterminate completion emits residual actions only.

### Pi adapter

- command and tool registration;
- TypeBox validation;
- TUI and RPC confirmation paths, including signal cancellation during selection and confirmation;
- print and JSON mutation refusal;
- synchronous event claim and awaited completion;
- missing listener;
- session shutdown aborts an active publication;
- bounded tool content and honest truncation.

### `plan-implement`

- stack preflight requires both the skill and extension;
- parent owns deterministic reconciliation;
- stacked-PR extension, not the parent, derives the unique top boundary and selected GitHub remote without model inference;
- publisher child receives a PR map, per-slice diffs, PR metadata, and reviewer evidence;
- publisher child has only `read,grep,find,ls` and cannot execute stack mutation;
- malformed, oversized, duplicate, and unknown-PR proposal entries are rejected;
- structured title/body proposals are bound to the displayed confirmation;
- metadata apply revalidates GitHub repository, head repository, bookmark, and PR number;
- metadata apply rejects a concurrent title/body edit after confirmation as stale;
- metadata apply supports cancellation and reports partial or indeterminate updates;
- busy and every other non-completed reconciliation skip the child;
- single-PR flow is unchanged.

### Optional real-service checks

Keep real GitHub tests opt-in and manual. Use a dedicated disposable repository and account. Cover first publication, restack base repair, and comment update. Never run them in the default suite.

## Limits

Start with the current limits unless parity tests justify a change:

| Item | Limit |
| --- | ---: |
| Stack commits and slices | 50 |
| Subprocess timeout | 20 seconds for `jj`, 30 seconds for `gh` |
| Captured stdout per process | 512 KiB |
| Captured stderr per process | 64 KiB |
| Model-facing tool content | 50 KiB or 2,000 lines |
| Abort grace before SIGKILL | 5 seconds |

The README must state the limits and whether each applies per command, request, or process.

## Security model

The extension runs with the user's OS permissions. Confirmation, narrow adapters, stale checks, and typed requests reduce accidental misuse. They are not a sandbox.

Treat these values as untrusted:

- repository content and configuration;
- `jj`, Git, and `gh` output;
- GitHub PR and comment bodies;
- event request payloads;
- tool parameters and command arguments.

Validate them at the adapter or API boundary. Never place credentials, raw environment values, unredacted remote URLs, or full authentication diagnostics in tool content, session entries, or errors.

## Non-goals

This migration does not add:

- non-linear stacks or merge-commit stacks;
- hidden fetch;
- GitHub authentication setup;
- dependency installation;
- arbitrary GitHub API or `jj` tools;
- PR merge, ready state, reviewer assignment, labels, or branch deletion;
- PR title/body generation in the deterministic engine;
- automatic rollback;
- CI publishing or a headless apply bypass;
- a shared core package before a second caller exists.

## Open questions

1. Is the two-confirmation stack publish flow in `plan-implement` acceptable: one exact reconciliation confirmation, then one title/body confirmation after the read-only child returns its proposal?
2. Does RPC expose a cancellation mechanism that can abort a long-running command handler, or should v1 promise only session-shutdown cancellation in RPC mode?
3. What minimum `gh` version should the extension enforce for the paginated fields it consumes?

## Verification commands after implementation

```bash
node --test extensions/jj-stacked-prs/*.test.ts
node --test extensions/plan-implement/*.test.ts
node --test skills/jj-stacked-prs/skill.test.mjs
node --test install.test.mjs \
  extensions/session-archive/*.test.ts \
  extensions/handoff/*.test.ts \
  extensions/panel-review/*.test.ts \
  extensions/plan-implement/*.test.ts \
  extensions/kstack-router/*.test.ts \
  extensions/shared/*.test.ts
```

Run an isolated extension load after unit tests:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -e extensions/jj-stacked-prs/index.ts
```

The smoke test must use fake `jj` and `gh` executables. It must not mutate a real GitHub repository.
