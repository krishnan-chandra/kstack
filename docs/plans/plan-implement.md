# Plan/implement extension design

## Decision

Build this workflow as a Pi extension, not as a standalone skill.

A skill can describe planner/implementer behavior, but it cannot reliably enforce different models, read-only planning, subprocess cancellation, output bounds, or automatic handoff to another extension command. The extension supplies deterministic orchestration while leaving normal skill discovery enabled in both child agents. This lets the planner and implementer consult any task-specific user, project, or package skills that Pi would normally expose.

## User-visible contract

The extension registers:

```text
/plan-implement <task>
/plan-implement
```

When task text is omitted, an editor collects it. The command is available in TUI and RPC modes because the workflow requires confirmations.

The sequence is:

1. Resolve one high-reason planner model and one distinct small/fast implementer model.
2. Confirm the task, role assignments, mutation boundary, skill policy, and automatic review handoff before making model calls.
3. Run the planner in an isolated, read-only Pi child process.
4. Display the planner output with its model identity.
5. Ask the user to approve the plan before any implementation begins.
6. Run the implementer in a second isolated Pi child process with normal mutation tools.
7. Display the implementation result with its model identity and reported verification.
8. On successful completion, invoke the loaded panel-review extension through its in-process event-bus request API, preserving panel-review's own confirmation and result rendering.

The existing panel-review extension remains responsible for Git scope collection, its spending confirmation, reviewer execution, and verdict display.

## Explicit non-goals

- The workflow does not run planner and implementer in the parent model context.
- It does not silently skip plan approval.
- It does not apply panel findings automatically.
- It does not sandbox the implementer. The child has the same operating-system permissions as Pi and can mutate the working tree through its tools.
- It does not force a fixed task-specific skill. Each child selects relevant skills through Pi's normal skill mechanism.
- It does not isolate implementer changes from pre-existing working-tree changes. Panel review evaluates the scope its existing extension resolves and may therefore include earlier changes.

## Model policy

Configuration lives in the `"plan-implement"` section of `$PI_CODING_AGENT_DIR/kstack.json`:

```json
{
  "plan-implement": {
    "planner": { "model": "openai/gpt-5.6-sol", "thinking": "max" },
    "implementer": { "model": "openrouter/deepseek/deepseek-v4-flash", "thinking": "low" },
    "timeoutMinutes": 30
  }
}
```

Configured role models must be distinct, available, and authenticated. Providers registered by parent extensions are rejected because children run with `--no-extensions` and cannot reproduce those model definitions, routing, or credentials. Planner thinking must be `high`, `xhigh`, or `max`; omission defaults to `high`. Implementer thinking is optional.

Without configuration, choose the first available authenticated candidate in each list.

Planner candidates, in order:

1. `openai/gpt-5.6-sol:max`
2. `openrouter/anthropic/claude-opus-4.6:high`
3. `anthropic/claude-fable-5:high`

Implementer candidates, in order:

1. `openrouter/deepseek/deepseek-v4-flash:low`
2. `openrouter/qwen/qwen3.6-flash:low`
3. `openrouter/google/gemini-3.5-flash-lite:low`
4. `openrouter/z-ai/glm-5.2:low`
5. `openai/gpt-5.6-terra:low`
6. `openai/gpt-5.6-luna:low`

If either role has no available candidate, fail before launching anything. Never fall back to the active parent model because that would weaken role separation and make cost/quality behavior surprising.

## Child process boundaries

Both children run as ephemeral processes with:

```text
pi --mode json -p --no-session --no-extensions --no-prompt-templates ...
```

They intentionally do **not** receive `--no-skills`: normal global, project, package, settings, and explicit skill discovery remains active. Context files also remain enabled so repository instructions still apply.

Planner adds:

```text
--tools read,grep,find,ls
```

Implementer uses Pi's normal built-in tool set. Extensions are disabled in both children to prevent recursive orchestration and unrelated extension side effects.

The original task and generated plan are written to mode-`0600` files in a private temporary directory. Child command lines contain only paths and a short fixed instruction, not the potentially large task or plan. Prompt assets are extension-owned Markdown files passed with `--append-system-prompt`.

Repository files, context files, skills, task text, and planner output are instructions/data visible to agents, not a security sandbox. The planner's tool allowlist prevents Pi-native writes, but filesystem permissions are unchanged. The implementer is intentionally capable of mutation after explicit approval.

## Limits

- Task text: 32 KiB UTF-8.
- Planner final output retained: 64 KiB UTF-8.
- Implementer final output retained: 32 KiB UTF-8.
- Child stderr retained: 8 KiB UTF-8.
- Maximum JSONL stdout line buffered: 2 MiB; an oversized line terminates the child with a protocol error.
- Child timeout: configurable from 1–60 minutes; default 30 minutes per role.
- Abort grace: SIGTERM, then SIGKILL after 5 seconds.
- Panel intent: normalized to one line and bounded to 1,000 characters.

All truncation is disclosed in displayed output. Temporary task, plan, and prompt files are removed in `finally`; cleanup failure is surfaced with the path and permission mode.

## Lifecycle and cancellation

Only one plan/implement run may be active per extension instance. A dedicated shortcut aborts only an actively running planner or implementer child; during the approval boundary it reports that no child is running, so approval cannot accidentally pre-abort the implementer. `session_shutdown` invalidates the workflow generation and aborts any active child.

A child runs in a detached process group on POSIX so cancellation and timeout target the process tree. Each process gets SIGTERM first and SIGKILL after the grace period.

The workflow captures a session-generation token and checks it after every user/child await. Post-shutdown callbacks do not use stale `pi`/`ctx` references. Temporary files are removed in an unconditional nested `finally`; cleanup failures use the current UI only when the original session is still active and otherwise fall back to stderr.

## Failure policy

- Missing UI, missing panel-review command, non-Git working directory, invalid config, unavailable models, empty/oversized task: fail before model calls.
- Planner spawn/provider/error/timeout/abort: show bounded diagnostics; do not ask for implementation and do not trigger panel review.
- User rejects the plan: stop cleanly before mutation.
- Implementer spawn/provider/error/timeout/abort: preserve and display the approved plan plus bounded diagnostics; warn that partial working-tree changes may exist; do not claim success or automatically trigger panel review.
- Successful implementer: display its final report, then call panel-review's claimed in-process request and await its workflow. A missing listener is reported rather than sent to the LLM as literal slash-command text.
- Panel command failure is owned and reported by panel-review.

## Modules

```text
extensions/plan-implement/
├── index.ts                 # Pi command, UI, lifecycle, review handoff
├── config.ts                # unified config validation/loading/model resolution
├── agent-runner.ts          # child argv, JSON parsing, bounds, timeout, kill tree
├── command.ts               # task validation and safe panel argument formatting
├── lifecycle.ts             # phase-aware cancellation and stale-session invalidation
├── model-availability.ts    # reject parent extension-only providers
├── workflow.ts              # sequential planner/approval/implementer state machine
├── types.ts
├── prompts/
│   ├── planner.md
│   └── implementer.md
├── *.test.ts
└── README.md
```

No shared subagent framework is introduced. The panel-review runner has materially different discovery, read-only, and report semantics; premature sharing would make both contracts less clear.

## Test plan

Unit tests use injected model registries, filesystem/config paths, spawn implementations, clocks/timers where needed, and workflow callbacks. They make no provider calls.

Cover:

- malformed config, invalid thinking, same-model rejection, default ordering, unavailable roles;
- planner argv is read-only, implementer argv permits normal tools, both disable extensions/templates but preserve skills/context files;
- chunk-safe JSON parsing, output/stderr bounds, nonzero exit, provider error, abort, timeout, and process cleanup;
- planner failure stops the workflow, rejection prevents implementation, implementer receives the exact plan, and successful ordering reaches review handoff;
- panel argument quoting prevents task text from becoming flags, while the event-bus API proves the real panel handler is claimed and awaited rather than sent as an LLM prompt;
- task byte limits and temporary-file cleanup;
- extension load without a provider call.

Run:

```bash
node --test extensions/plan-implement/*.test.ts
node --test install.test.mjs \
  extensions/session-archive/*.test.ts \
  extensions/handoff/*.test.ts \
  extensions/panel-review/*.test.ts \
  extensions/plan-implement/*.test.ts
```

---

# Stacked-PR delivery mode (addition)

The extension grows an explicit delivery mode while preserving the single-PR
behavior above. A companion skill, `skills/jj-stacked-prs/`, carries the local
jj workflow and a read-only inspection helper; the extension wires stack mode
into the planner/implementer pipeline and deterministically excludes Arena.

## User-visible contract (addition)

```text
/plan-implement <task>                 # single PR (backward-compatible default)
/plan-implement --single <task>        # explicit single PR
/plan-implement --stack <task>         # local jj stack of PRs
/plan-implement                       # ask for delivery mode, then task editor
```

The argument-less form asks for the delivery mode **before** opening the task
editor, because stack mode must exclude Arena before any child starts. The
planner never auto-promotes a single-PR run into a stack.

## Single-PR mode

Unchanged from the design above: normal skill discovery (including `arena`)
stays enabled; the planner produces one plan; the implementer creates a
working-tree change; panel review reviews the resulting changeset; no commit or
publication is performed.

## Stacked-PR mode

Requirements:

- A colocated `jj`/Git workspace with a remote `main`/`master`/trunk` branch
  so the `trunk()` revset resolves.
- The approved plan defines one or more ordered PR slices.
- The implementer creates local `jj` changes and bookmarks.
- The implementer does **not** push bookmarks or create GitHub PRs. Publishing
  remains a later, separately confirmed `jst submit --dry-run` workflow owned by
  the `jj-stacked-prs` skill.

Arena is disabled for **both** planner and implementer because parallel
candidates manipulating the same Jujutsu operation log and working copy can
create divergent operations or incoherent PR boundaries.

### Planner output

A machine-recognizable header selects the implementer policy:

- single-PR plan begins with `Delivery: single-pr`;
- stacked-PR plan begins with:
  ```
  Delivery: stacked-prs
  Stack base: trunk()
  ```
  followed by ordered `## PR N — <title>` sections, each with `Bookmark`,
  `Purpose`, `Changes`, `Verification`, `Done when`, and (for non-bottom PRs)
  `Depends on`. Dependencies flow only from lower to higher PRs; bookmark names
  are unique; migrations/tests live in the slice that needs them; the final
  section is whole-stack verification; no push/publication step.

### Implementer behavior

In stack mode the implementer consults `jj-stacked-prs`, inspects the current
operation, preserves pre-existing work, starts the stack from `trunk()`,
implements each approved slice in order, describes each change and places its
bookmark, verifies each slice before moving upstack, leaves an empty
working-copy change above the top when practical, reinspect the full stack for
conflicts/divergence/merges/empty descriptions/missing bookmarks, reports the
base-to-top stack table and the recovery operation, and never runs
`jst submit`, `jj git push`, or `gh pr create`. Partial failure leaves the local
stack intact and reports the exact completed and incomplete slices.

## Deterministically disabling Arena

For stack mode the parent command context's discovered skills are captured via
`ctx.getSystemPromptOptions().skills` and both children launch with:

```text
--no-skills --skill <every discovered skill except arena>
```

The filtered set explicitly includes `jj-stacked-prs`. This preserves
task-specific package, project, and user skills while removing Arena by
resource control, not by asking the model not to use it. A stack-mode system
instruction also prohibits candidate fan-out or nested workers; resource
filtering is the primary control and the prompt explains why. Single-PR mode
keeps current implicit discovery without `--no-skills`.

## Panel-review behavior (addition)

After a successful stack implementation the extension:

- uses the immutable `trunk()` Git SHA captured by the preflight as the panel
  review `--base`, so the whole stack is reviewed once against a stable
  baseline;
- tags the review intent as a stacked implementation
  (`Plan/implement (stacked): <task>`). The implementer's stack table is part
  of the panel bundle (the diff against `trunk()`), not parsed back into the
  intent; the task text and the stacked tag are enough for reviewers to
  frame the changeset.

Single-PR mode keeps the existing panel handoff (no explicit `--base`).

## Preflight policies

Stack mode stops before model calls when:

- `jj` is unavailable;
- the directory is not a Jujutsu workspace;
- the workspace is not colocated with a Git worktree;
- `trunk()` does not resolve to exactly one 40-hex Git-backed commit;
- the discovered skill set does not contain `jj-stacked-prs`;
- filtering cannot prove `arena` was excluded.

`jst` is not required to create a local stack; its absence only blocks later
publication (handled by the skill, not the extension).

## Modules (addition)

```text
extensions/plan-implement/
├── command.ts              # --single/--stack parsing + stack panel args
├── delivery-mode.ts        # jj/Git preflight + immutable trunk() resolution
├── skill-policy.ts         # filter arena, preserve others, require jj-stacked-prs
├── agent-runner.ts          # buildChildArgs gains mode + explicit --skill argv
├── types.ts                 # DeliveryMode, SkillRef
├── index.ts                 # mode picker UI, preflight, confirmation, stack review base
├── prompts/planner.md       # delivery header + stacked slice format
├── prompts/implementer.md   # stacked-PR policy
└── *.test.ts
```

## Test plan (addition)

Cover (no provider calls):

- `--stack`, `--single`, unknown flags, both flags, and backward-compatible
  default; argument-less mode selection;
- single mode retains normal skill discovery (no `--no-skills`);
- stack mode emits `--no-skills` and repeated explicit `--skill`;
- exact-name Arena exclusion without excluding similarly-named skills;
- forced availability of `jj-stacked-prs` and failure when it is missing;
- mode passed to both child prompts (planner/implementer target text);
- stack panel args carry the immutable `--base` SHA and a stacked intent;
- preflight failures (no jj, not a workspace, no colocated git, no trunk,
  multiple trunks, non-hex id) stop before model calls;
- existing plan/approval/cancellation behavior remains unchanged.
