---
name: tdd
description: Use a failing-before / passing-after regression check when fixing a bug with a cheap local test path. Use for TDD, a failing test, a regression test, or when the bug has an obvious unit or component target. Skip when the test path is unclear, expensive, integration-heavy, or not requested.
license: MIT
compatibility: A repository checkout with its normal test commands. Writes tests and production code; never commit, push, or publish unless asked.
---

# TDD Bug Fix

When fixing a bug with a clear, cheap test path, make the broken behavior executable before changing production code. The goal is a focused regression test that fails before the fix and passes after it.

This is the same proof obligation as the plan-implement [bug-fix playbook](../../extensions/shared/playbooks/bug-fix.md). Keep the two in sync: cheap failing-before evidence, the same check after the fix, and an explicit reason when a new test is not worth it. For a risky small change whose harm is outside the test, use [`blast-radius`](../blast-radius/SKILL.md) after the regression is green.

Do not force a test when it would be impractical. If the available test would require broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn, skip adding a new test and use the closest useful verification instead.

## Workflow

1. **Understand the bug.** Identify the intended behavior, current behavior, affected path, and smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest unit, component, integration, or regression test already used for that codepath. If no practical test path is obvious, do not create one from scratch just to satisfy the workflow.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. The test should encode intended behavior, not mirror the current implementation.
4. **Run the new test before fixing.** Confirm it fails for the intended reason. If it passes or fails for an unrelated reason, correct the test or reproduction before editing the implementation.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior while preserving nearby contracts.
6. **Rerun the regression test.** Confirm the test now passes.
7. **Run nearby validation.** Run relevant adjacent tests, type checks, lint, or scenario checks when the change has broader risk.

## If a failing test is impractical

Do not silently skip the regression step. Before fixing, explain why a failing test is impossible or not worth the cost, then choose the closest executable regression check available. Examples include a targeted script, manual reproduction command, browser automation, snapshot comparison, log assertion, or focused integration check.

Prefer no new test over a bad test. A bad test is one that mostly tests mocks, encodes current implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, or would be deleted immediately after proving the fix.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior has genuinely changed and the reason is clear.
- Keep the regression test focused on the bug; avoid broad fixture churn or unrelated coverage expansion.
- Do not add tests when the practical signal is weak; use manual or scripted verification and say why.
- If the bug is flaky, make the test deterministic where possible and document the signal being locked down.
- If the bug exposes a broader class of failures, first land the focused regression path, then consider additional sibling coverage.

## Final response

Report the evidence, not just the outcome:

- Name the failing-before test or executable check and the failure it produced.
- Name the passing-after test run and any nearby validation performed.
- If failing-before evidence could not be demonstrated, state why and describe the closest regression check used instead.
