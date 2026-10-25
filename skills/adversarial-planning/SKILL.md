---
name: adversarial-planning
description: Draft an implementation plan and stress-test it with a council of distinct reviewer models in visible Herdr panes until the council approves or the round budget runs out. Use explicitly with /skill:adversarial-planning when the user asks for adversarial planning, a plan council, a plan critique loop, or a planner-versus-adversary debate.
license: MIT
compatibility: Pi running inside Herdr with the Herdr Pi integration installed and a kstack.json council section or --seats.
disable-model-invocation: true
---

# Adversarial planning

Draft a repository-grounded implementation plan, then run it past a **council** of read-only seats. Each seat is a different model in its own Herdr pane. Seats review independently, then vote on each other's findings through a ledger the CLI publishes. The CLI counts the votes and decides; you plan, revise, and answer findings. The user is the final arbiter.

## Guard and resolve paths

1. Run `test "${HERDR_ENV:-}" = 1`. Stop if this is not a Pi session inside Herdr.
2. Resolve symlinks before walking up, because `~/.agents/skills/adversarial-planning` is usually a symlink into the kstack checkout:

   ```sh
   SKILL_DIR="$(cd "<directory containing this SKILL.md>" && pwd -P)"
   KSTACK="$(dirname "$(dirname "$SKILL_DIR")")"
   CLI="$KSTACK/extensions/shared/herdr/cli.mjs"
   ```

   Stop if `$CLI` does not exist.
3. Check `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-agent-state.ts`. If it is missing, stop with `Run herdr integration install pi`.

## Open the council

Derive a slug matching `[a-z0-9-]{1,21}` and set `COUNCIL="$PWD/plans/<slug>-council"`. Then run:

```sh
node "$CLI" council open --dir "$COUNCIL" --slug <slug> \
  --planner-model "$PI_PROVIDER/$PI_MODEL"
```

Append `--seats '<ref>,<ref>'` when the user names seat models or aliases. Otherwise the seats come from `council.seats` in `kstack.json`. A seat that uses your model sits out, so you never review your own plan.

The command prints JSON. Seats open in one column to the right of your pane, named `council-<slug>-<letter>`.

- `ready` (exit 0): continue.
- `waiting` (exit 1): a seat is at a prompt, usually project trust. Tell the user the pane from `seats[].paneId`, wait for them to answer, then rerun the same `council open`. Rerunning adopts the waiting seat instead of starting another.
- `failed` (exit 1): report `error` and stop. For a missing roster, ask the user for `--seats` or a `council` section.

Run every council command from this tab. The council is bound to it.

## Draft the plan

Write the user's request to `plans/<slug>-task.md`. Then write `plans/<slug>.md`, grounding code claims in the repository and keeping scope within the request:

```markdown
# <plan title>

Delivery: single-pr

## Ordered implementation steps
1. [STEP-1] <bounded change and verification>

## Acceptance criteria
- [AC-1] <observable result>
```

Name the change-kind proof-obligation playbook when one applies.

## Run rounds

Run a round with absolute paths. Pass `--task` on the first round:

```sh
node "$CLI" council round --dir "$COUNCIL" \
  --plan "$PWD/plans/<slug>.md" --task "$PWD/plans/<slug>-task.md"
```

The CLI snapshots the plan, asks every seat in parallel, publishes `round-N/ledger.md`, runs a cross-examination vote when findings are up for one, and writes `round-N/decision.md`. Never paste the task, plan, or findings into a seat's terminal.

Act on the JSON `status` and `decision`:

- **approve**: Present `approvedPlan`, the exact snapshot the council reviewed. If `planChangedSinceSnapshot` is true, tell the user the live plan has unreviewed edits; run another round if they want those edits reviewed.
- **revise**: Read `decisionFile`. Revise the live plan for every binding finding. Write `plans/<slug>-response-<N+1>.md` that answers every binding ID exactly once, then rerun with `--response "<absolute path>"`.
- **escalated**: The response declared a conflict, or rebutted a finding a second time. Present `escalations` to the user. Either revise the plan as the user directs and answer the findings again, or override a finding when the user decides to:

  ```sh
  node "$CLI" council override --dir "$COUNCIL" --finding <ID> \
    --reason "<the user's reason>" --plan "$PWD/plans/<slug>.md"
  ```

  Override only on the user's instruction. An override that clears the last binding finding approves the last reviewed snapshot.
- **exhausted**: The budgeted rounds are used and findings still bind. Present them and the plan path. The user can edit the plan, steer a seat in its pane, have you override findings, or ask for a `--verify` round. A `--verify` round runs only after the budget is used, and it does not consume budget.
- **incomplete** (exit 1): Name each seat and pane in `failures`. After the user resolves the cause, rerun the same command. The rerun asks only seats without a valid reply, against the same snapshot.
- **failed** (exit 1): Fix the reported input, such as a response that misses a binding ID, and rerun.

### Planner response

Keep the response out of the plan file. Use one line per binding finding:

```markdown
## Responses
- A/B-1: addressed — <the change, naming STEP or AC IDs>
- C/B-2: rebutted — <repository evidence that the finding is wrong>
- A/B-3: conflicts-with C/B-1 — <why both cannot hold>
```

A rebuttal sends the finding back to a vote. Rebut a finding at most once; a second rebuttal escalates to the user, as does `conflicts-with`.

## Hand off

Leave the seat panes open and report their panes. After the user approves, offer handoffs that target the approved snapshot, `$COUNCIL/approved-plan.md`, never the live plan:

```text
/plan-implement --fast --plan-file <absolute approved-plan.md path> --change-kind <kind> <task>
```

The path must contain no whitespace; copy the approved snapshot to a suitable path if necessary. Fast mode snapshots the file before workstream creation and passes it to a fresh implementer. It does not inherit this conversation.

For a full run that keeps the adversarial implementation review and publication gates without re-planning, offer:

```text
/plan-implement --plan-file <absolute approved-plan.md path> --change-kind <kind> <task>
```

The full handoff validates the plan's ordered `[STEP-n]` and `[AC-n]` contract and snapshots it read-only. It skips the planner and planning debate, then runs the implementer, the adversarial implementation review, fixing, and publication. Implementation and review models come from the `plan-implement` and `council` configuration. Neither handoff authorizes publication or landing.

When the user is done with the seats, close their panes:

```sh
node "$CLI" council close --dir "$COUNCIL"
```
