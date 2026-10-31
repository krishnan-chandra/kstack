---
name: adversarial-planning
description: Draft an implementation plan, stress-test it with a council of distinct reviewer models in visible Herdr panes until the council approves or the round budget runs out, implement the approved plan on a dedicated workstream, run every remaining council seat as an implementation adversary, fix blocking findings, and — after explicit approval — publish a draft PR with reviewer recommendations. Use explicitly with /skill:adversarial-planning when the user asks for adversarial planning, a plan council, a plan critique loop, a planner-versus-adversary debate, or implementing an approved plan with adversarial review.
license: MIT
compatibility: Pi running inside Herdr with the Herdr Pi integration installed and a kstack.json council section or --seats.
disable-model-invocation: true
---

# Adversarial planning

Draft a repository-grounded implementation plan, then run it past a **council** of read-only seats. Each seat is a different model in its own Herdr pane. Seats review independently, then vote on each other's findings through a ledger the CLI publishes. The CLI counts the votes and decides; you plan, revise, and answer findings. Once the council approves, you implement the exact approved snapshot on a dedicated workstream, run the same seats as implementation adversaries against the diff, fix findings, and — only after the user approves publishing — publish a draft PR with reviewer recommendations. The user is the final arbiter.

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
- `waiting` (exit 1): a seat is at a prompt, usually project trust, including on its first start. Tell the user each waiting seat's `paneId`, wait for them to answer, then rerun the same `council open`. Rerunning adopts the waiting seat instead of starting another.
- `failed` (exit 1): report `error` and each failed seat's `error` and `paneId`, then stop. For a missing roster, ask the user for `--seats` or a `council` section.

Run every council command from this tab. The council is bound to it. Record the seat model references from the `seats` array of the open output; the implementation review reuses exactly these seats and models.

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

If the user already supplies an approved plan file (for example `plans/<slug>.md` with the `[STEP-n]`/`[AC-n]` contract), copy it to `plans/<slug>.md`, skip the planning debate, and go to [Implement](#implement). You still open the council: the implementation review needs its seats.

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

## Implement

After approval, `$COUNCIL/approved-plan.md` holds the exact reviewed snapshot. Implement it in this session, in the working repository, on a dedicated workstream.

1. Prepare the implementation bundle in `plans/<slug>-implement/`:
   - copy `$COUNCIL/approved-plan.md` → `plans/<slug>-implement/approved-plan.md`;
   - write `plans/<slug>-implement/task.md` (the user's request);
   - write `plans/<slug>-implement/execution-ledger.md` copying every `[STEP-n]` and `[AC-n]` line verbatim from the approved plan.
2. Create the workstream for the configured backend (`vcs.backend` in `kstack.json`, or inferred: jj workspace → jj; Graphite branch → graphite; else git):
   - Git: require a clean tree. Create branch `kstack/<slug>` from the remote trunk (origin-first `main`/`master`, else local `main`/`master`, else `HEAD`). If the branch exists, append `-2`, `-3`, … until it does not.
   - jj: create a change off `trunk()` and a bookmark `kstack/<slug>`. Leave the working copy above the bookmark empty.
   - Graphite: `gt branch create kstack/<slug>` (with `gt` recording), or a managed worktree via the `git-worktrees` skill when the user asks.
   - Record the base ref (the trunk ref or the bookmark's parent) — the review diff is computed against it.
3. Read `references/implementer.md` and follow its contract exactly: implement steps in order, update each ledger entry exactly once (`done` / `blocked: <reason>` / `skip: <reason>`), verify with focused tests before each commit, commit one coherent milestone at a time, and never push, publish, or create PRs.
4. Regenerate the diff of the workstream against the base into `plans/<slug>-implement/diff.patch` plus a `diff--stat.txt`:
   - Git: `git diff <baseRef>...<branch>` and `git diff --stat <baseRef>...<branch>`.
   - jj: `jj diff --from <base> --to <bookmark>` (base = trunk or the bookmark's parent) and the matching `--stat`.
   - Graphite: `git diff <baseRef>...<ref>` after `gt`.

## Implementation review

Run every remaining council seat (from the open output's `seats`) as a read-only implementation adversary in parallel:

1. Create one prompt file per seat: copy `references/implementation-adversary.md` and append an `## Inputs` section listing absolute paths for that seat's `task.md`, `approved-plan.md`, `execution-ledger.md`, and `diff.patch`.
2. Write a fanout spec JSON (one task per seat) with:
   - `owner`: `adversarial-planning`
   - `label`: `<slug>-impl-review`
   - `cwd`: the repository root (absolute)
   - `maxConcurrency`: the number of seats (≤ 8)
   - per task: `label` (`seat-a`, …), `model` (the seat's model ref from the open output), `cwd` (repository root), `promptFile` (the per-seat prompt), `outputFile` (`plans/<slug>-implement/review-<letter>.md`), `access`: `"read-only"`, `noContextFiles`: true, `timeoutMinutes`: `council.reviewTimeoutMinutes` or 10.
   Save it as `local/<slug>-review-spec.json` (absolute paths).
3. Run:

   ```sh
   node "$CLI" fanout --spec "<abs>/local/<slug>-review-spec.json" \
     --out "<abs>/plans/<slug>-implement/review-summary.json"
   ```

4. Interpret each seat's output file: `Verdict: approve` or `Verdict: revise`, with `## Blocking` (`[B-n]`), `## Suggestions` (`[S-n]`), and `## Resolved from previous round`. All seats must approve for the implementation to pass.

## Fix

If any seat reports blocking findings, address them in this session:

1. Read `references/review-fixer.md` and follow its contract: verify each finding in the live repository, fix every `[B-n]`, skip or dispute only with evidence, record verified commits on the same workstream, and never push or publish.
2. Regenerate the diff, rebuild the per-seat prompt files (appending the previous verdicts as `## Resolved from previous round` context), and rerun the same fanout.
3. Loop until all seats approve or the council's `maxRounds` budget (from the open/roster output) is exhausted. If exhausted, present the open findings to the user and let them decide: steer a seat, override with their direction, or stop.

## Publish

Publishing requires explicit user approval — never publish, push, or create a PR unprompted.

1. Read `references/publisher.md` and follow its contract: consult `write-pr` and `my-voice` for the title and body from the actual diff, create or update a **draft** PR (with the jj empty-checkpoint push for jj backends), and consult `find-reviewers` for 2–5 prioritized reviewers.
2. Return the PR URL (or base-to-top table for stacks) and the full reviewer recommendation; never mark the PR ready and never merge.

## Close

When the user is done with the seats, close their panes:

```sh
node "$CLI" council close --dir "$COUNCIL"
```

Leave the workstream, plan, and review artifacts in place for the user's review.
