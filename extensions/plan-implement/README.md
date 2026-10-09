# plan-implement

`/plan-implement` plans a code change, optionally debates the plan with a distinct adversary, asks for approval, implements on a backend-owned workstream, runs an adversarial implementation review, addresses findings, and publishes a draft PR. Every role runs as a named Pi agent in a pane split off the caller's own pane, so the run shares the caller's Herdr tab instead of opening a new one.

The extension owns deterministic gates: model and repository preflight, plan and ledger validation, immutable-plan checks, recorded-work verification, stack publication, and cleanup. Hosted agents own planning and repository work.

## Commands

```text
/plan-implement --change-kind bug-fix Fix the archive race
/plan-implement --single --change-kind feature Add archive search
/plan-implement --worktree --change-kind feature Add archive search
/plan-implement --stack --change-kind refactor Split the rollout into three PRs
/plan-implement --plan-only --change-kind feature Draft the migration plan
/plan-implement --no-adversary --change-kind feature Use an existing approved plan flow
/plan-implement --plan-file plans/migration.md --change-kind feature Implement the approved plan
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
| `--plan-only` | Stop after the final plan and write it under `plans/`. This conflicts with `--fast` and `--plan-file`. |
| `--fast` | Run one hosted implementer. Skip planning, adversarial review, and publication. |
| `--plan-file <path>` | Implement a plan supplied from this path instead of planning. The path must contain no whitespace; the file must be nonempty and at most 64 KiB. Without `--fast`, the plan must also use the ordered `[STEP-n]`/`[AC-n]` contract, and the full implement → review → fix → publish loop runs. With `--fast`, the loop is skipped. |

Use `--` before a task that starts with a dash. The argument-less command prompts for delivery, change kind, and task.

## Requirements

`plan-implement` requires:

- interactive TUI mode inside Herdr (`HERDR_ENV=1`);
- the Pi integration installed by `herdr integration install pi`;
- an accepted workspace for the configured VCS backend;
- authenticated role models;
- the `write-pr` and `find-reviewers` skills for runs that can publish.

`--plan-only` does not require publication skills or a configured adversary. Single mode checks the configured VCS workspace without creating a workstream. Stack mode also resolves the local trunk through its provider, but skips clean-tree checks, fetching, and publication manifests. Fetch the desired trunk yourself before planning when local refs are stale. RPC, JSON, and print modes are not supported.

## Workflow

A full run follows these phases:

1. Preflight Herdr, configuration, models, VCS, and publication skills before a model call.
2. Split the caller's pane with `--no-focus` and host the run in the caller's tab.
3. Start the planner in the run pane. With `--plan-file`, skip planning and load the supplied plan instead.
4. If `adversary` is configured, start the adversary and run the debate. A supplied plan skips the planning debate.
5. Validate the final plan's ordered `[STEP-n]` items and `[AC-n]` criteria.
6. Display the exact final validated plan, including verified human edits, then ask for approval. That same snapshot is persisted and supplied to the implementer.
7. Create the backend workstream only after approval, then start the implementer.
8. Verify the immutable plan, execution-ledger parity, and locally recorded work.
9. Run every configured implementation adversary against the exact workstream or stack base, then offer a fixer round while any adversary withholds approval.
10. Offer a hosted review fixer, structural publication, a hosted metadata publisher, PR autopilot, and landing.

Planner, adversary, implementer, fixer, and publisher agents stay visible in the caller's tab. A full run uses at most five panes. Each role starts once; planner revisions reuse the same planner session. Review adversaries run in their own pane split off the caller's pane, or as headless children when Herdr is unavailable. The extension retains its panes after completion and reports the tab ID.

With `--plan-file`, phases 3–4 are replaced by a bounded read of the supplied plan. The run starts from an immutable snapshot of that file, so a later edit cannot change what the implementer and reviewers see.

The Planner, Adversary, Implementer, Review fixer, and Publisher cards show the model, status, turns, and cost. Expand a card with Ctrl+O. Press Ctrl+Shift+I to abort the active hosted agent. If an agent blocks on a question or approval, the extension shows its pane ID; answer there, then confirm that the run should resume.

## Adversarial debate

The adversary uses [`../../skills/adversarial-planning/adversary-prompt.md`](../../skills/adversarial-planning/adversary-prompt.md), the same contract as the interactive skill. Each critique contains an `approve` or `revise` verdict, `[B-n]` blocking findings, and optional `[S-n]` suggestions.

The planner and adversary run for at most `maxRounds` budgeted rounds. A `revise` verdict sends the critique back to the same planner session. An `approve` verdict ends the debate.

Exhaustion blocks approval. The extension lists the open findings, plan path, and planner and adversary panes. Edit the plan file or steer the planner, then choose **Verify**. Verification does not consume the round budget. A further `revise` verdict returns to the same gate; declining rejects the plan.

The adversary model must differ from the planner model. An unavailable adversary, malformed critique, failed planner revision, or aborted role stops before implementation.

## Adversarial implementation review

After the implementer records its work, every configured adversary reviews the exact change. Each adversary reads the user task, the approved plan, the implementer execution ledger, and a unified diff of the recorded workstream against its immutable base. The diff comes from `VcsBackend.reviewDiff`, so the review works for Git, jj, and Graphite workstreams without a separate snapshot tool.

When the planner reported a session file, the implementer, the review fixer, and every review adversary also receive a planning-session reference: a handoff-style file naming the planner session transcript, session id, and cwd, with read-only instructions for inspecting the plan and the debate. The reference is appended to their system prompt; the approved plan file stays authoritative. `--fast` and `--plan-only` runs plan no implementation review and add no reference; a `--plan-file` handoff has no planner session, so it passes no reference.

Adversaries run in parallel and share `adversary.reviewTimeoutMinutes` as a wall-clock deadline. Each returns the same `Verdict`/`Blocking`/`Suggestions` critique as the planning debate. The run combines every critique into one verdict; the implementer fixer reads all reports verbatim and addresses every blocking finding. The loop re-reviews until every adversary approves or `maxRounds` is reached. An `approve` verdict requires every adversary to approve.

When the run is started inside Herdr, the adversaries share a pane split off the caller's pane, keeping them visible for inspection. When Herdr is not available, each adversary is a headless Pi child that reports its output and cleanup diagnostic. A full run still requires Herdr for its core roles today, so this headless path is the transport contract for the reviewer when the reviewers are launched without a Herdr host.

## Plan-only mode

`--plan-only` runs the planner and configured debate, validates the final plan, and writes:

```text
plans/<task-slug>.md
```

It does not create a branch, bookmark, Graphite workstream, worktree, adversarial review, or PR. Use the resulting plan with `--plan-file plans/<task-slug>.md` to run the full implement → review → fix → publish loop without re-planning, or with `--fast --plan-file <absolute-plan-path>` when the bounded implementation no longer needs another debate.

## Plan handoff mode

`--plan-file <path>` supplies an already approved plan, so the run skips the planner and the planning debate and goes straight to the approval gate, implementer, adversarial implementation review, fixing, and publication. The run still resolves and authenticates the configured planner, because the planner model is the reference for the `adversary` distinctness check, even though no planner agent is launched. It also requires an available `plan-implement` implementer, a configured adversary for the review loop, and the publication skills.

The extension resolves the path against the current workspace, reads at most 64 KiB, rejects empty files, and requires the ordered `[STEP-n]`/`[AC-n]` contract with at least one step and one acceptance criterion. The bounded read is written to a read-only run-local snapshot that the implementer and reviewers all receive; a later edit to the source file cannot change it. This is the handoff target for the [`adversarial-planning`](../../skills/adversarial-planning/SKILL.md) skill when planning and implementation should use different models.

## Fast mode

`--fast` splits the caller's pane and runs one hosted implementer in the current workstream or a newly created managed worktree. It preserves change-kind and backend guidance, verifies a new recorded revision, retains the pane and workstream, and never publishes. Supply `--plan-file` to carry a selected plan into the run; the implementer receives a bounded immutable snapshot, not implicit access to the parent conversation.

## Delivery modes

### Single PR

The configured VCS backend owns workstream creation and verification:

- Git requires a clean working tree and creates a collision-safe `kstack/<slug>` branch.
- jj creates a `trunk()`-based change and bookmark, then requires an empty working-copy change above the recorded implementation.
- Graphite creates and records a tracked `kstack/<slug>` branch through `gt`.

### Managed worktree

`--worktree` supports Git and Graphite single-PR delivery. The backend creates a linked worktree beneath `~/.pi/kstack/worktrees/` after plan approval. Implementation, adversarial review, fixing, and publication use that path. The extension retains the worktree on every outcome; use the `git-worktrees` skill for cleanup.

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
  "adversary": {
    "adversary": [
      { "model": "openai/gpt-6-astra", "thinking": "xhigh" }
    ],
    "maxRounds": 3,
    "timeoutMinutes": 15,
    "reviewTimeoutMinutes": 10
  }
}
```

`adversary.adversary` is one model object or kstack model alias string, or an array of up to five of them. If it is omitted, the built-in adversary is `openai/gpt-6-astra` at `xhigh`. `maxRounds` is an integer from 1 through 5 and defaults to 3. `adversary.timeoutMinutes` is an integer from 1 through 60 and defaults to 15; `adversary.reviewTimeoutMinutes` is an integer from 1 through 60 and defaults to 10. If the `adversary` section is absent, the normal command uses the single-planner flow.

Planner thinking must be `high`, `xhigh`, or `max`. Planner and implementer models must differ. Every configured model must be available and authenticated in the parent registry.

## Hosted-agent protocol and limits

The shared module under [`../shared/herdr/`](../shared/herdr/) creates the panes, agents, and protected exchange files in the caller's tab. Terminal prompts contain only short file pointers. Task, plan, critique, and verdict inputs cross through mode-`0600` files in a mode-`0700` temporary directory. Agents return request-tagged final replies through Pi's session. The host validates successful terminal completion and writes the response artifacts.

| Item | Limit |
| --- | --- |
| Task | 32 KiB UTF-8 |
| Planner output | 64 KiB UTF-8 |
| Critique output | 32 KiB UTF-8 |
| Implementer, fixer, or publisher output | 32 KiB UTF-8 |
| Debate rounds | 1–5; default 3 |
| Role timeout | 1–60 min |
| Hosted agents per run | 5 |
| Review adversaries per round | 1–5 (own pane split) |
| Pointer prompt | 512 bytes |

Hosted agents use the user's OS permissions. Every role enables normal Pi extension discovery and omits a `--tools` allowlist. This does not transfer parent-only `-e` extensions, runtime tools, or active tool selections. Project tools depend on the child's cwd and trust state, so a managed worktree may differ from the parent. Planner and adversary launches append a shared read-only system prompt; that is an instruction, not a capability boundary. Repository files, skills, context files, tasks, plans, and verdicts may contain hostile instructions.

## Failure and cleanup

Failures before approval do not create a workstream. An implementation failure may leave recorded checkpoints or partial edits on the retained workstream. A fixer failure stops the review loop before re-review and prevents publication when backend postconditions fail. Publication failures can leave a pushed ref or draft PR that needs inspection.

Abort sends Escape, then Ctrl+C twice, then closes only the hosted pane if the agent does not settle. Session replacement and shutdown abort the active role. Cancellation remains connected while a blocked-input confirmation is open. Resume retains the original request and sends it only if Herdr rejected it before delivery. Host disposal cancels pending work and removes exchange files when no request is outstanding, but leaves idle panes open.

## In-process request interface

`kstack:plan-implement:request` uses schema version 2. Its payload contains `task`, `mode`, `workLocation`, `changeKind`, `fast`, `adversary`, `planOnly`, and the fresh command context. `kstack-router` uses this channel instead of constructing slash-command text.

## Development

The test suite uses fake Herdr and VCS adapters and makes no provider calls:

```bash
node --test extensions/plan-implement/ extensions/kstack-router/
```
