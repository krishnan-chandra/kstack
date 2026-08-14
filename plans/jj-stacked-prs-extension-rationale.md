# Pi-native stacked PR publisher rationale

## Problem

Stack publication currently lives in Python scripts under `skills/jj-stacked-prs`, while its most important caller is the TypeScript `plan-implement` extension. A publisher child agent discovers the skill, runs the CLI, and parses the result after a broad parent confirmation. The migration must move deterministic stack reconciliation into Pi without losing the skill's useful local `jj` guidance. The difficult boundary is authorization: a plan ID identifies state, but it does not prove that a user approved remote mutation.

## Usage (caller's view)

A direct user gets one command namespace:

```text
/jj-stack inspect --top auth-rollout
/jj-stack plan --top auth-rollout --remote origin
/jj-stack publish --top auth-rollout --remote origin
```

Models get read-only inspection and planning tools. They do not get an apply tool.

`plan-implement` delegates the whole reconciliation boundary to one typed request:

```ts
const result = await requestStackPublication(pi, input, ctx, signal);
```

The stacked-PR extension computes the plan, shows the exact actions, asks for confirmation, recomputes state, and applies. The caller receives a typed outcome and PR map. It does not coordinate plan, grant, and apply calls.

Trusted parent code then prepares per-slice diffs, PR metadata, and reviewer evidence. A child with only `read,grep,find,ls` proposes titles, bodies, and reviewer recommendations. The parent validates and displays the proposal, asks for confirmation, and applies title/body updates through a narrow adapter restricted to the published PR map.

## Shape

`extensions/jj-stacked-prs` owns executable behavior. `skills/jj-stacked-prs` keeps workflow and recovery guidance.

`StackPublisher` is the deep module. Its public methods are `inspect`, `plan`, and `publish`. Pure stack and publication modules own blocker, slice, snapshot, fingerprint, and plan policy. Narrow `jj` and GitHub adapters validate external output and hide command protocols. A local process adapter owns timeouts, cancellation, output caps, and redaction.

The executable plan is an immutable in-memory value scoped to one publication request. `publish` holds a cross-process repository lock, renders and confirms the plan, then recomputes both the snapshot fingerprint and ordered plan ID before the first mutation. A mismatch returns `stale` and performs no mutation. The extension does not persist a mutable action list and does not expose private apply methods through tools or events.

The interface is deliberately smaller than the implementation. Callers can review the ordered actions, but they do not coordinate execution, comment ownership, retry policy, stale comparison, or subprocess commands. They supply stack identity and receive a closed result union.

## Synthesis decision

Candidate C (`/tmp/arena-pi-stack-publisher/candidate-c.md`) was the base. It was the only candidate that structurally prevented a model tool from authorizing apply, kept the skill, separated pure policy from effects, and gave `plan-implement` a typed integration path. The Sol cross-judge scored it 28/30 and selected it over A and B.

The final design simplifies Candidate C's public grant protocol. A single deep publication request owns planning, confirmation, stale checking, and apply. Because apply is not a public operation, no caller-visible grant is necessary.

The design grafts Candidate A's detailed stack, action, and partial-result types; base-to-top ordering; comment reconciliation; and parity checklist. It rejects A's model-callable apply tool, Pi API mistakes, custom-TUI requirement, and immediate Python deletion.

The design grafts Candidate B's audit metadata idea and opt-in real GitHub test recommendation. It defers a standalone core package until a second caller exists. It rejects B's public apply tool, force bypass, mutable resumable plans, disabled stale checks on retry, and removal of the workflow skill.

## Tradeoffs accepted

- We accept a Pi runtime requirement in exchange for extension-owned confirmation and typed in-process composition.
- We accept two stack-mode publication confirmations in `plan-implement` in exchange for showing both the exact reconciliation plan and the exact title/body edits before mutation.
- We accept no headless apply path in v1 in exchange for a clear human authorization boundary.
- We accept a temporary Python and TypeScript overlap in exchange for differential parity tests and a clean rollback point.
- We accept extension-local domain modules in exchange for avoiding a package abstraction before another caller needs it.
- We accept non-transactional partial results in exchange for honest recovery through fresh reconciliation instead of unsafe rollback.

## Alternatives considered

### Python engine behind a TypeScript wrapper

This shape preserves the current implementation, but the extension remains a stringly typed CLI adapter. Confirmation, cancellation, and typed composition stay outside the engine. It does not create deeper primitives.

### Public plan and apply tools

This shape is convenient for agents, but a model can call both tools. A required plan ID proves freshness only. Prose that says "call after approval" does not enforce approval.

### Separate plan, authorize, and apply event APIs

This shape can use opaque grants, but every caller must coordinate the same three-step protocol. That leaks the internal state machine and creates a shallow public surface. One `requestStackPublication` call hides the protocol and lets the owning extension control confirmation.

### Standalone core package plus extension

A separate package could serve future CLIs or other applications. Today, the extension is the only executable TypeScript caller. Creating a package now adds module and distribution boundaries without hiding more policy. Extract it when a second caller proves the contract.

## Open questions and risks

- Is the proposed two-confirmation `plan-implement` flow acceptable?
- What cancellation guarantee does RPC provide for a long-running command handler?
- Cancellation, timeout, shutdown, process error, or lost output can leave a remote mutation indeterminate; every such result must force a fresh plan.
- A crashed process can leave the cross-process publication lock behind; v1 requires manual inspection before removal.
- The read-only publisher child and narrow title/body adapter add scope, but they enforce the same no-model-owned-mutation rule after stack reconciliation.
- Navigation comments retain Python parity: they reconcile after a conclusive non-cancellation partial failure, but uncertain comment mutations return an indeterminate outcome.
- Which minimum `gh` version supports the exact paginated response contract?
- Differential tests must compare normalized behavior, not Python and TypeScript JSON hash formatting.

## Next implementation step

After approval, create language-neutral characterization fixtures and implement TypeScript inspection parity without changing any publication caller.
