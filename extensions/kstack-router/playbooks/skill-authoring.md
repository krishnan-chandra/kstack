# Skill Authoring playbook

Goal: Create, improve, debug, trigger-test, or evaluate a skill.

## First turn (read-only framing)

Stop after:
1. Defining the skill's intent, triggers, and description.
2. Defining test prompts and evaluation criteria.
3. Estimating cost (eval runs, models).
4. Describing the workflow (draft → headless eval → grade → benchmark).

Present this frame to the user for approval before proceeding.

## Subsequent turns

Follow the create-skill skill workflow:
- Draft SKILL.md.
- Run headless with-skill vs baseline eval.
- Grade results.
- Aggregate benchmark.
- Generate static review page.
- Optimize description and triggers if needed.

## Done predicate

Done when the skill is drafted, tested, evaluated, and the results are
presented for review. The skill is not automatically activated; the user must
review and install.