---
name: adversarial-planning
description: Draft an implementation plan and debate it with a distinct, read-only adversary in a visible Herdr pane until approval or a three-round limit. Use explicitly with /skill:adversarial-planning when the user asks for adversarial planning, a plan critique loop, or a planner-versus-adversary debate.
license: MIT
compatibility: Pi running inside Herdr with the Herdr Pi integration installed and kstack.json plan-adversary model configuration.
disable-model-invocation: true
---

# Adversarial planning

Draft a repository-grounded implementation plan, then run a bounded debate with one named adversary. Keep the adversary pane open so the user can inspect or steer it.

## Guard and resolve paths

1. Run `test "${HERDR_ENV:-}" = 1`. Stop and explain that this skill requires a Pi session inside Herdr if the check fails.
2. Resolve this skill directory from the absolute path used to load `SKILL.md`. Set `KSTACK` to the directory two levels above it.
3. Set the Pi integration path to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-agent-state.ts`. Stop with `Run herdr integration install pi` if the file is missing.
4. Resolve the adversary model through the shared validator and alias resolver:

   ```sh
   MODEL="$(node "$KSTACK/extensions/shared/herdr/cli.mjs" resolve-model \
     --section plan-adversary --key adversary)"
   ```

   If the user supplied a model or alias, append `--model '<argument>'`. Stop on a nonzero exit and show the resolver's guidance.

## Open or reuse the adversary pane

1. Derive a short lowercase task slug. The Herdr agent name is `adversary-<slug>` and must match `[a-z][a-z0-9_-]{0,31}`.
2. Run `herdr agent list`. Reuse the exact live name when it already exists.
3. Otherwise inspect the caller with `herdr pane layout --pane "$HERDR_PANE_ID"`. Split a wide pane to the right and a narrow or tall pane down. Always preserve the current directory and user focus:

   ```sh
   herdr pane split "$HERDR_PANE_ID" --direction <right-or-down> --cwd "$PWD" --no-focus
   ```

4. Read the new pane ID from `.result.pane.pane_id`. Start the adversary there:

   ```sh
   herdr agent start "adversary-<slug>" --kind pi --pane "<pane-id>" -- \
     --no-extensions \
     -e "$KSTACK/kstack.ts" \
     -e "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-agent-state.ts" \
     --no-skills --no-prompt-templates \
     --tools read,grep,find,ls \
     --model "$MODEL" \
     --append-system-prompt "$KSTACK/skills/adversarial-planning/adversary-prompt.md" \
     --name "adversary/<slug>"
   ```

If startup reports `agent_not_ready`, tell the user which pane contains the prompt. Do not answer a project-trust or approval prompt for the user.

## Draft the plan

Ground every code claim in the repository. Write the plan to `local/plans/<slug>.md`; create `local/plans/` if needed. Use this contract:

```markdown
# <plan title>

Delivery: single-pr

## Ordered implementation steps

1. [STEP-1] <bounded change and its verification>

## Acceptance criteria

- [AC-1] <observable, testable result>
```

Name the change-kind proof-obligation playbook when one applies. Keep the plan within the user's scope.

## Run the debate

Run at most three budgeted rounds. Keep prompts short and pass content by file path; never paste the task, plan, or critique into the terminal.

For round `N`, set the critique path to `local/plans/<slug>-critique-N.md`, then run:

```sh
herdr agent prompt "adversary-<slug>" \
  "Round N. Read the task and plan at <absolute-plan-path>. Write your critique to <absolute-critique-path> and reply with exactly: DONE <absolute-critique-path>" \
  --wait --timeout 900000
```

After each round:

- If Herdr returns `blocked`, inspect `herdr agent read "adversary-<slug>" --source recent-unwrapped --lines 200`. Show the user the pane ID and ask them to answer there before continuing.
- Read the critique file. Reject malformed output that does not use `Verdict: approve` or `Verdict: revise` and the required sections.
- On `approve`, present the final plan and stop the debate.
- On `revise`, address every `[B-n]` in the plan. Add `## Changes since last round`, with one entry per blocking ID. Then run the next round.

After round 3 returns `revise`, stop. Present every open blocking finding and the plan path. Tell the user that they can edit the plan or steer the adversary in its pane. Start another round only when the user asks.

## Hand off

Leave the adversary pane open and report its agent name and pane ID. For a bounded approved plan, offer:

```text
/plan-implement --fast --change-kind <kind> <task>
```

For a full run that should not repeat the debate, offer:

```text
/plan-implement --no-adversary <task>
```
