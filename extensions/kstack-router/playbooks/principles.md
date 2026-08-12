# Kstack Router shared principles

These principles apply to every routed workflow.

## Done predicates

A routed task is done when:

1. **Bounded output**: the work produces a concrete deliverable — findings,
   code changes, a review verdict, a skill draft, or a session pick-up summary.
2. **Evidence**: every claim or result is backed by evidence (tool output,
   source quotes, test results).
3. **No side effects outside scope**: the route does not modify files, session
   state, or external systems beyond its explicit mandate.
4. **Verification**: every change, artifact, or route deliverable is verified
   (tests pass, review completed, or tools confirm the result).

## First-pass stopping

When the first turn is read-only (arena, swarm, skill-authoring), stop after
framing. Present the frame to the user for approval before continuing.

## Isolation

- Read-only routes never write, edit, exec bash, or call custom mutating tools.
- Parallel workers never share state or merge into the working tree.
- Classifier output is advisory; the user always confirms the route.

## Verification

- Tests run and pass (or are reported with a clear reason for skipping).
- Changes are reviewable (panel review or manual inspection).
- Partial failures are reported honestly.

## Publication prohibition

No route pushes, publishes, creates PRs, deploys, or performs destructive
operations. Those steps remain separate, confirmed actions.