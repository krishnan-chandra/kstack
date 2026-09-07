# plan-implement

`/plan-implement` plans a code change, optionally debates the plan with a distinct adversary, asks for approval, implements on a backend-owned workstream, runs panel review, addresses findings, and publishes a draft PR. Long-lived roles run as named Pi agents in a dedicated Herdr tab.

The extension owns deterministic gates: model and repository preflight, plan and ledger validation, immutable-plan checks, recorded-work verification, stack publication, and cleanup. Hosted agents own planning and repository work.

## Commands

```text
/plan-implement --change-kind bug-fix Fix the archive race
/plan-implement --single --change-kind feature Add archive search
/plan-implement --worktree --change-kind feature Add archive search
/plan-implement --stack --change-kind refactor Split the rollout into three PRs
/plan-implement --plan-only --change-kind feature Draft the migration plan
/plan-implement --no-adversary --change-kind feature Use an existing approved plan flow
/plan-implement --fast --change-kind feature Make one bounded change
```

The command accepts these leading flags:

| Flag | Effect |
| --- | --- |
| `--single` | Deliver one PR. This is the default. |
| `--stack` | Build and publish a local PR stack through the configured stack provider. |
| `--worktree` | Run a single Git or Graphite delivery in a retained managed worktree. |
| `--change-kind <kind>` | Select `bug-fix`, `feature`, `refactor`, `performance`, `prototype`, or `generic`. |
| `--no-adversary` | Skip the configured adversary for this run. |
| `--plan-only` | Stop after the final plan and write it under `local/plans/`. This conflicts with `--fast`. |
| `--fast` | Run one hosted implementer. Skip planning, panel review, and publication. |
| `--plan-file <path>` | With `--fast`, snapshot this selected plan before workstream creation. The path must contain no whitespace; the file must be nonempty and at most 64 KiB. |

Use `--` before a task that starts with a dash. The argument-less command prompts for delivery, change kind, and task.

## Requirements

`plan-implement` requires:

- interactive TUI mode inside Herdr (`HERDR_ENV=1`);
- the Pi integration installed by `herdr integration install pi`;
- an accepted workspace for the configured VCS backend;
- authenticated role models;
- `panel-review` for full implementation runs; and
- the `write-pr` and `find-reviewers` skills for runs that can publish.

`--plan-only` does not require panel review or publication skills. Single mode checks the configured VCS workspace without creating a workstream. Stack mode also resolves the local trunk through its provider, but skips clean-tree checks, fetching, and publication manifests. Fetch the desired trunk yourself before planning when local refs are stale. RPC, JSON, and print modes are not supported.

## Workflow

A full run follows these phases:

1. Preflight Herdr, configuration, models, VCS, panel review, and publication skills before a model call.
2. Create one `plan-implement: <slug>` Herdr tab with `--no-focus`.
3. Start a read-only planner in the tab's root pane.
4. If `plan-adversary` is configured, start a read-only adversary and run the debate.
5. Validate the final plan's ordered `[STEP-n]` items and `[AC-n]` criteria.
6. Display the exact final validated plan, including verified human edits, then ask for approval. That same snapshot is persisted and supplied to the implementer.
7. Create the backend workstream only after approval, then start the implementer.
8. Verify the immutable plan, execution-ledger parity, and locally recorded work.
9. Run panel review against the exact workstream or stack base.
10. Offer a hosted review fixer, structural publication, a hosted metadata publisher, PR autopilot, and landing.

Planner, adversary, implementer, fixer, and publisher agents stay visible in the run tab. A full run uses at most five panes. Each role starts once; planner revisions reuse the same planner session. The extension retains the tab after completion and reports its ID.

The Planner, Adversary, Implementer, Review fixer, and Publisher cards show the model, status, turns, and cost. Expand a card with Ctrl+O. Press Ctrl+Shift+I to abort the active hosted agent. If an agent blocks on a question or approval, the extension shows its pane ID; answer there, then confirm that the run should resume.

## Adversarial debate

The adversary uses [`../../skills/adversarial-planning/adversary-prompt.md`](../../skills/adversarial-planning/adversary-prompt.md), the same contract as the interactive skill. Each critique contains an `approve` or `revise` verdict, `[B-n]` blocking findings, and optional `[S-n]` suggestions.

The planner and adversary run for at most `maxRounds` budgeted rounds. A `revise` verdict sends the critique back to the same planner session. An `approve` verdict ends the debate.

Exhaustion blocks approval. The extension lists the open findings, plan path, and planner and adversary panes. Edit the plan file or steer the planner, then choose **Verify**. Verification does not consume the round budget. A further `revise` verdict returns to the same gate; declining rejects the plan.

The adversary model must differ from the planner model. An unavailable adversary, malformed critique, failed planner revision, or aborted role stops before implementation.

## Plan-only mode

`--plan-only` runs the planner and configured debate, validates the final plan, and writes:

```text
local/plans/<task-slug>.md
```

It does not create a branch, bookmark, Graphite workstream, worktree, panel review, or PR. Use the resulting plan with `--fast --plan-file <absolute-plan-path>` when the bounded implementation no longer needs another debate.

## Fast mode

`--fast` opens one Herdr tab and runs one hosted implementer in the current workstream or a newly created managed worktree. It preserves change-kind and backend guidance, verifies a new recorded revision, retains the pane and workstream, and never publishes. It no longer takes over the parent Pi session. Supply `--plan-file` to carry a selected plan into that fresh session; the implementer receives a bounded immutable snapshot, not implicit access to the parent conversation.

## Delivery modes

### Single PR

The configured VCS backend owns workstream creation and verification:

- Git requires a clean working tree and creates a collision-safe `kstack/<slug>` branch.
- jj creates a `trunk()`-based change and bookmark, then requires an empty working-copy change above the recorded implementation.
- Graphite creates and records a tracked `kstack/<slug>` branch through `gt`.

### Managed worktree

`--worktree` supports Git and Graphite single-PR delivery. The backend creates a linked worktree beneath `~/.pi/kstack/worktrees/` after plan approval. Implementation, panel review, fixing, and publication use that path. The extension retains the worktree on every outcome; use the `git-worktrees` skill for cleanup.

### Stacked PRs

`--stack` preflights the configured GitHub, jj, or Graphite stack provider and pins its trunk. Hosted mutation roles receive only the selected skills, with Arena excluded. The implementer builds a local stack and never publishes it directly. The parent validates and publishes the exact stack, then the publisher may edit metadata only for PRs in the trusted publication map.

## Configuration

Kstack reads `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`).

```json
{
  "plan-implement": {
    "planner": { "model": "openai/gpt-6-astra", "thinking": "high" },
    "implementer": { "model": "openrouter/google/gemini-3.8-flash", "thinking": "high" },
    "timeoutMinutes": 30
  },
  "plan-adversary": {
    "adversary": { "model": "anthropic/claude-fable-5-1", "thinking": "medium" },
    "maxRounds": 3,
    "timeoutMinutes": 15
  }
}
```

The adversary may be an object or a kstack model alias string. `maxRounds` is an integer from 1 through 5 and defaults to 3. Adversary `timeoutMinutes` is an integer from 1 through 60 and defaults to 15. If `plan-adversary` is absent, the normal command uses the single-planner flow.

Planner thinking must be `high`, `xhigh`, or `max`. Planner and implementer models must differ. Every configured model must be available and authenticated in the parent registry.

## Hosted-agent protocol and limits

The shared module under [`../shared/herdr/`](../shared/herdr/) creates the tab, panes, agents, and protected exchange files. Terminal prompts contain only short file pointers. Task, plan, critique, and verdict inputs cross through mode-`0600` files in a mode-`0700` temporary directory. Agents return request-tagged final replies through Pi's session. The host validates successful terminal completion and writes the response artifacts, so read-only roles need no file-writing tool.

| Item | Limit |
| --- | --- |
| Task | 32 KiB UTF-8 |
| Planner output | 64 KiB UTF-8 |
| Critique output | 32 KiB UTF-8 |
| Implementer, fixer, or publisher output | 32 KiB UTF-8 |
| Debate rounds | 1–5; default 3 |
| Role timeout | 1–60 min |
| Hosted agents in one full run | 5 |
| Pointer prompt | 512 bytes |

This is a capability restriction, not a sandbox. Hosted agents use the user's OS permissions. Planner and adversary tools are limited to `read,grep,find,ls`; mutation roles have Pi's normal tools after approval. Repository files, skills, context files, tasks, plans, and verdicts may contain hostile instructions.

## Failure and cleanup

Failures before approval do not create a workstream. An implementation failure may leave recorded checkpoints or partial edits on the retained workstream. A fixer failure prevents publication when backend postconditions fail. Publication failures can leave a pushed ref or draft PR that needs inspection.

Abort sends Escape, then Ctrl+C twice, then closes only the hosted pane if the agent does not settle. Session replacement and shutdown abort the active role. Cancellation remains connected while a blocked-input confirmation is open. Resume retains the original request and sends it only if Herdr rejected it before delivery. Host disposal cancels pending work and removes exchange files when no request is outstanding, but leaves idle panes open.

## In-process request interface

`kstack:plan-implement:request` uses schema version 2. Its payload contains `task`, `mode`, `workLocation`, `changeKind`, `fast`, `adversary`, `planOnly`, and the fresh command context. `kstack-router` uses this channel instead of constructing slash-command text.

## Development

The test suite uses fake Herdr and VCS adapters and makes no provider calls:

```bash
node --test extensions/plan-implement/ extensions/kstack-router/
```
