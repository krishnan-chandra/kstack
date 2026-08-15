# Pi extension ground rules

These rules combine current Pi documentation with the implementation lessons from `session-archive`, `handoff`, and `panel-review`.

## Repository shape

- Put each extension in `extensions/<name>/` with an `index.ts` default factory.
- Keep `index.ts` focused on Pi registration and lifecycle adaptation.
- Put deterministic logic in named modules and colocate Node tests as `*.test.ts`.
- Keep prompts and rubrics as Markdown assets when they benefit from independent review.
- Add a focused README and update the root README.
- Avoid runtime dependencies unless the platform cannot provide the capability. Runtime package dependencies belong in `dependencies`, not `devDependencies`.

## Source of truth

Use this precedence when sources disagree:

1. installed Pi types and runtime behavior;
2. installed Pi documentation;
3. installed Pi examples;
4. this repository's current tests and code;
5. archived session decisions and older plans.

History explains intent but can be stale. This repository uses the `@earendil-works/*` package namespace and `typebox`; do not copy imports from older or upstream forks without verifying them.

## Public API design

- Start with the smallest command/tool/event surface that fulfills the contract.
- Commands are appropriate for explicit user intent, confirmation, editors, and session replacement.
- Tools are appropriate for narrow model-callable operations with schemas and bounded results.
- Events are appropriate for behavior that must happen consistently across turns or lifecycle transitions.
- Skills are preferable when instructions plus existing tools are sufficient.
- Do not expose arbitrary paths, SQL, shell, provider payloads, or generic mutation when a typed operation will do.
- Persist only state that must survive restart or remain in model context; choose `custom` versus `custom_message` deliberately.

## Architecture and testability

A useful default split is:

```text
extensions/example/
├── index.ts              # registrations and Pi contexts
├── args.ts               # command parsing
├── config.ts             # loading and validation
├── orchestrator.ts       # workflow and injected effects
├── domain-module.ts      # pure deterministic behavior
├── *.test.ts
├── prompts/              # auditable model instructions, if needed
└── README.md
```

This is a guide, not required boilerplate. Small extensions should remain one file. Extract modules around behavior and boundaries, not arbitrary line counts.

Prefer dependency injection for filesystem, Git, spawn, time, and model boundaries. Tests should exercise real deterministic behavior without loading Pi or making provider calls. Keep extension-specific modules independent until multiple callers demonstrate a meaningful shared invariant.

Prefer exhaustive `if` / `else if` / `switch` over nested ternaries. A one-level `a ? b : c` is fine; a chain of `? :` is not.

## Lifecycle invariants

- Extension factories may be async for bounded startup discovery, but must not start background resources.
- Start session-scoped resources on `session_start` or on demand and close them idempotently on `session_shutdown`.
- Use `agent_settled`, not merely `agent_end`, when no automatic continuation may remain.
- Understand parallel tool ordering; sibling tool results may not yet be in `SessionManager` during `tool_call`.
- Use `ctx.signal` where available for nested model calls, fetches, and subprocess work.
- Command handlers that alter sessions should `await ctx.waitForIdle()` when required by their contract.
- Session replacement tears down the old runtime. In `withSession`, use only the fresh callback context. Previously captured `pi`, command contexts, session managers, and session-bound state are stale.
- Treat `await ctx.reload()` as terminal for that handler.

## Trust and security

Extensions execute with the user's full permissions. Security design must distinguish:

- accidental misuse controls (confirmation, path checks, read-only tools, file modes);
- prompt-injection resistance (untrusted data separated from instructions);
- process capability limits (tool allowlists, no session persistence, no resource discovery);
- actual sandboxing (which ordinary Pi extension code does not provide).

For project-local configuration, check project trust when the data should only be honored for trusted projects. Canonicalize and contain filesystem paths, account for symlinks and race-time revalidation, and never claim shell-command parsing is a complete security boundary.

Subagents should receive only the tools and resources they need. Disable extensions, skills, prompts, or context files when repository-controlled content could become instructions. Pass large or sensitive payloads through protected files/stdin rather than command-line arguments. Bound wall-clock runtime, capture bounded diagnostics, terminate children, and clean up temporary artifacts.

## Data, errors, and limits

- Validate once on initial input and again immediately before irreversible mutation when state may have changed.
- Make destructive or multi-system operations idempotent and recoverable.
- No filesystem/database/process sequence is magically atomic; model intermediate states explicitly when correctness depends on them.
- One partial failure should not discard independent successful work unless the contract requires all-or-nothing behavior.
- Preserve actionable diagnostics without leaking secrets or flooding model context.
- Define byte, line, item, concurrency, and time limits near the feature contract and test their edges.
- Truncation messages must describe what was omitted and how to continue. Never imply completeness when names or content were dropped.
- Keep credentials out of config examples and logs. Resolve provider authentication through Pi APIs rather than guessing environment variables.

## Documentation standard

An extension README should answer:

1. What does it do, and what does it deliberately not do?
2. How is it invoked?
3. What commands, tools, events, and persistent entries does it add?
4. Where does configuration or data live, including environment overrides?
5. What are the security/trust boundaries?
6. What are the output, concurrency, and timeout limits?
7. What happens on cancellation and partial failure?
8. How is it tested safely?
9. What work is deferred?

## Completion checklist

### Design

- [ ] Extension versus skill/asset decision is justified.
- [ ] Current installed docs, relevant linked docs, examples, repository patterns, and session history were inspected.
- [ ] Public contract, non-goals, limits, threat model, lifecycle, and failure policy are explicit.

### Implementation

- [ ] `index.ts` is a thin adapter; deterministic logic is independently testable.
- [ ] Imports and APIs match the installed Pi distribution.
- [ ] Inputs, config, paths, persisted data, and external output are validated and bounded.
- [ ] Cancellation, timeouts, cleanup, and shutdown are handled.
- [ ] Replacement/reload code does not use stale contexts.
- [ ] No unnecessary dependency, generic mutation API, or premature shared framework was added.

### Verification

- [ ] Happy path and important failure paths have tests.
- [ ] Lifecycle ordering, cancellation, timeout, partial failure, truncation, and cleanup are covered where relevant.
- [ ] Extension tests and the full repository test suite pass.
- [ ] An isolated load/smoke test was run, or the reason it was not run is reported.
- [ ] No destructive test touched real Pi state.

### Delivery

- [ ] Extension README and root README are updated.
- [ ] Configuration examples contain no secrets.
- [ ] `git diff` contains no generated, private, or temporary artifacts.
- [ ] Final report lists changed paths, tests run, and remaining risks or unverified behavior.
