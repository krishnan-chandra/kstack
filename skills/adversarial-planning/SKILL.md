---
name: adversarial-planning
description: Draft an implementation plan and debate it with a distinct, read-only adversary in a visible Herdr pane until approval or a three-round limit. Use explicitly with /skill:adversarial-planning when the user asks for adversarial planning, a plan critique loop, or a planner-versus-adversary debate.
license: MIT
compatibility: Pi running inside Herdr with the Herdr Pi integration installed and kstack.json plan-adversary model configuration.
disable-model-invocation: true
---

# Adversarial planning

Draft a repository-grounded implementation plan, then run a bounded debate with one named adversary. Keep its pane open for inspection and steering. The parent plans; the adversary has read-only repository tools.

## Guard and resolve paths

1. Run `test "${HERDR_ENV:-}" = 1`. Stop if this is not a Pi session inside Herdr.
2. Resolve this skill directory from the absolute path used to load `SKILL.md`. Set `KSTACK` to the directory two levels above it.
3. Check `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-agent-state.ts`. If missing, stop with `Run herdr integration install pi`.
4. Resolve the adversary model:

   ```sh
   MODEL="$(node "$KSTACK/extensions/shared/herdr/cli.mjs" resolve-model \
     --section plan-adversary --key adversary)"
   ```

   Append `--model '<argument>'` for an explicit model or alias. Stop on resolver failure. Use a model distinct from the parent planner.

## Open or reuse the adversary pane

1. Derive `adversary-<slug>`, matching `[a-z][a-z0-9_-]{0,31}`.
2. Run `herdr agent list`. Reuse the exact live name when it already exists and has the intended cwd and model.
3. Otherwise inspect `herdr pane layout --pane "$HERDR_PANE_ID"`. Split right when wide, down when narrow or tall:

   ```sh
   herdr pane split "$HERDR_PANE_ID" --direction <right-or-down> --cwd "$PWD" --no-focus
   ```

4. Read `.result.pane.pane_id`, then start the adversary:

   ```sh
   herdr agent start "adversary-<slug>" --kind pi --pane "<pane-id>" -- \
     --no-extensions -e "$KSTACK/kstack.ts" \
     -e "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-agent-state.ts" \
     --no-skills --no-prompt-templates --tools read,grep,find,ls \
     --model "$MODEL" \
     --append-system-prompt "$KSTACK/skills/adversarial-planning/adversary-prompt.md" \
     --name "adversary/<slug>"
   ```

If startup reports `agent_not_ready`, tell the user which pane contains the prompt. The user answers project-trust and approval prompts.

## Draft the plan

Create `local/plans/`, then write `local/plans/<slug>.md`. Ground code claims in the repository and keep scope within the request:

```markdown
# <plan title>

Delivery: single-pr

## Ordered implementation steps
1. [STEP-1] <bounded change and verification>

## Acceptance criteria
- [AC-1] <observable result>
```

Name the change-kind proof-obligation playbook when one applies.

## Run the debate

Run at most three budgeted rounds. For round N, write `local/plans/<slug>-round-N.md` with the task, absolute plan path, prior critique path if any, and the instruction to return a structured critique in the final reply. The adversary does not write a report file.

Use the shared host request protocol against the existing agent:

```sh
node "$KSTACK/extensions/shared/herdr/cli.mjs" ask \
  --agent "adversary-<slug>" \
  --prompt "<absolute-round-instructions-path>" \
  --out "<absolute-critique-path>"
```

`ask` validates a request-specific successful final response in Pi's session, then saves it at `--out`. It has a 15-minute timeout and drains work on SIGINT/SIGTERM. SIGKILL cannot trigger cleanup. Never paste the task, plan, or critique into the terminal.

After each round:

- On a nonzero exit, inspect the reported status and pane. A blocked CLI request is cancelled before return; ask the user to resolve input in the pane before explicitly retrying the round. An output file alone does not prove completion.
- On success, read the critique file. Require one `Verdict: approve` or `Verdict: revise`, `## Blocking`, and `## Suggestions`. Reject unparseable nonempty blocking content; only `None.` represents an empty section. Any `[B-n]` blocker makes the verdict `revise`, even if the declared verdict says `approve`.
- On `approve`, present the exact final plan and stop.
- On `revise`, address every blocker by ID. Add `## Changes since last round` and run the next round.

After round 3 returns `revise`, stop and present open blockers and the plan path. The user can edit the plan or steer the adversary. Start another round only when the user asks.

## Hand off

Leave the adversary pane open and report its name and pane ID. After the user approves a bounded plan, offer:

```text
/plan-implement --fast --plan-file <absolute-plan-path> --change-kind <kind> <task>
```

The path must contain no whitespace; copy the selected plan to a suitable path if necessary. Fast mode snapshots the file before workstream creation and passes it to the fresh implementer. It does not inherit this conversation.

For a full run with implementation review and publication gates, offer:

```text
/plan-implement --no-adversary Implement the plan at <absolute-plan-path>
```

This performs another planning pass but skips another adversarial debate. Neither handoff authorizes publication or landing.
