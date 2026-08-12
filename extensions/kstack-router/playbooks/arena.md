# Arena playbook

Goal: Spawn N parallel candidates at the same task, cross-judge them, pick the
strongest as a base, graft the best parts from the losers, and verify.

## First turn (read-only framing)

Stop after:
1. Defining the artifact to produce (code, document, design).
2. Defining the evaluation rubric (correctness, performance, style, etc.).
3. Defining the runners (models, N, concurrency).
4. Estimating cost (model calls, tokens).
5. Describing isolation (temp directory, independent checkouts).

Present this frame to the user for approval before proceeding.

## Subsequent turns

Follow the arena skill workflow:
- Generate N independent candidates.
- Cross-judge against the rubric.
- Pick the winner as base.
- Graft strongest parts from losers.
- Verify the synthesized result.

## Done predicate

Done when the synthesized artifact is produced and verified. The working tree
contains only the final result, not intermediate candidates.