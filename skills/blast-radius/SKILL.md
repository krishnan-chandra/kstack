---
name: blast-radius
description: Analyze what a code change could break outside its direct diff and callers, then prove the safety-critical assumption by running the affected code. Use for "blast radius", "what could this break", "is this change safe", risky small diffs, compatibility checks, lifecycle or timing changes, schema or wire-format changes, dependency upgrades, or a focused pre-merge risk review. Complements broad panel review; it is not a generic code review.
license: MIT
compatibility: A repository checkout with its normal test or runtime commands. Primarily read-only; may add a focused test or temporary proof script when that is the best evidence. Never commit, push, or publish.
---

# Blast radius

Assess what a change can break beyond the lines that changed, then test the fact that makes the change safe. A caller list is not the result. Search finds direct callers quickly; the useful work is finding contracts and runtime behavior that search cannot reveal.

Run the investigation directly in the model and session where the skill was invoked. Keep it focused on the concrete safety question; reserve Arena for the exceptional cases described below.

Use this for a risky narrow change or a specific safety question. For a broad diff review, use `/panel-review` first. Do not run this automatically for every change: it costs attention and only helps when a concrete cross-boundary risk exists.

## Operating principle

A convincing writeup is not evidence. For every safety-critical claim, report the strongest evidence reached:

1. **Claimed**: an unverified conclusion. This is not evidence.
2. **Located**: a relevant source line, pinned dependency source, or documented contract.
3. **Traced**: the suspected failure path was followed and shown not to reach the harmful effect.
4. **Executed**: a focused test or script ran the production code path and would fail if the claim were false.
5. **Observed**: the behavior was reproduced on the matching running surface.

Aim for **Executed**. Use **Observed** when the application surface makes it practical. Never present a lower level as proof. If a focused executable check is impractical, say why and name the closest check that remains.

## Workflow

### 1. Define the exact change

Establish the complete review scope before reading the implementation. Run `git status --short` to find worktree changes. For a revision range, inspect both names and content with `git diff --name-status <base>...<head>` and `git diff <base>...<head>`. For a working-tree review, inspect committed range changes as applicable, staged changes with `git diff --cached`, unstaged changes with `git diff`, and untracked files with `git ls-files --others --exclude-standard`. Read every relevant untracked file explicitly; do not silently omit it because it has no diff.

Then inspect the diff and surrounding implementation. State:

- the behavior before and after;
- changed, added, and removed symbols;
- the user-visible, data, or lifecycle effect that the diff implies but does not state; and
- the target revision or range under review.

Use non-mutating Git commands such as `git diff`, `git show`, `git log`, and `git blame`. Read the repository's test and runtime instructions before choosing a proof command.

### 2. Find the safety-critical fact

Ask: **What one fact would make most plausible failures impossible?** Prefer one or two load-bearing facts over an inventory of speculative worries.

Examples:

- A cleanup call only removes entries already unreachable from live state.
- A decoder accepts both the old and new serialized representation.
- A callback cannot run after its owner has been disposed.
- A new default is overridden for every existing deployment path.

Write the fact as a falsifiable statement. If no single fact dominates, use the smallest set of independent facts and explain why.

### 3. Follow boundaries that searches miss

Trace from the changed behavior through the relevant boundary types. Only investigate boundaries that the change can actually cross:

| Boundary | Look for |
| --- | --- |
| Dependency | Lockfile version, vendored or installed source, release notes, local patches, default behavior |
| Data | JSON, database columns, migrations, caches, queues, wire formats, persisted files, old readers and writers |
| Runtime | Scheduling, retries, cancellation, teardown, initialization order, transactions, concurrency, timeouts |
| Integration | Other languages, services, CLIs, SDKs, generated clients, plugins, webhooks, feature flags, configuration |
| Deployment | Environment defaults, rollout order, backward compatibility, mixed-version operation, downgrade behavior |

Search is still useful, but validate its assumptions. Read the actual dependency source at the pinned version. Check generated and serialized forms. Follow data at least one hop downstream. For a negative result, record what was searched and its scope rather than claiming an absolute absence.

### 4. Triage real risks

Keep risks only when a concrete failure mechanism survives investigation. For each risk, record:

- **Mechanism**: what input, state, ordering, or consumer triggers it;
- **Evidence**: exact `path:line`, dependency version, command output, or a bounded no-match search;
- **Likelihood** and **impact**: low, medium, or high, with a brief reason;
- **Check**: the cheapest command, test, or reproduction that distinguishes safe from unsafe; and
- **Status**: confirmed or unproven.

Do not inflate a hypothetical into a risk. Put investigated non-risks only in **Cleared**, with the evidence that eliminated them.

### 5. Prove the load-bearing fact

Choose the smallest executable check that uses the same implementation, dependency version, and input shape that ship. Prefer, in order:

1. an existing focused regression or integration test;
2. a small test beside the affected code;
3. a temporary or repository-approved script that imports the real code; or
4. a real-surface reproduction using the normal launch, readiness, drive, capture, and cleanup path.

Run the check. Capture the command, exit status, and output that establishes the fact. Keep a new test when it is a durable regression guard. Remove an ad hoc proof script unless the repository conventions or future risk justify retaining it. Do not add a brittle harness merely to upgrade the evidence level.

If the proof changes product code or needs a destructive command, stop and get explicit approval first. Otherwise, keep changes narrow and do not commit, push, create a PR, or publish anything.

### 6. Scale the review only when needed

For a wide or high-consequence change, use `/skill:arena` to obtain independent analyses. Give every candidate the same diff range, safety question, and required output. Judge candidates against source and executable evidence; merge only substantiated risks. Do not use Arena for a local change with a clear proof path.

## Output

Return this structure. Cite every source claim with a path and line, dependency version, or command output.

~~~~markdown
# Blast radius: <change or range>

## What changed
<Behavior before and after, including the implied effect.>

## Safety-critical fact
**Fact:** <falsifiable statement>

**Evidence level:** <Claimed | Located | Traced | Executed | Observed>

**Proof:**
```text
$ <command>
<relevant output>
```

<State `Unproven` instead when no executable proof was obtained, including why and the closest available check.>

## Risks
| Risk | Mechanism and evidence | Likelihood | Impact | Check | Status |
| --- | --- | --- | --- | --- | --- |
| <risk> | `<path:line>` ... | <level> | <level> | `<command>` | <confirmed/unproven> |

## Cleared
- <Concern> — <why it cannot happen, with evidence.>

## Before merge
- <Cheapest durable regression command or real-surface reproduction.>
- <Anything that remains unproven or needs a rollout safeguard.>
~~~~

Keep the report concise. Its value is the proof and the mechanisms, not a long list of callers. Remove secrets, personal data, and internal URLs before sharing it outside the repository.
