# plan-implement

Run a high-reason planner and a distinct small/fast implementer in isolated Pi
processes, with explicit plan approval between them, then invoke kstack's
existing panel review through an in-process extension API.

```text
/plan-implement Add optimistic locking to the session archive writer
/plan-implement --change-kind bug-fix Fix the archive race
/plan-implement --single --change-kind feature Add archive search
/plan-implement --stack --change-kind refactor Split the auth rollout into a three-PR jj stack
/plan-implement
```

Use `--change-kind` with `bug-fix`, `feature`, `refactor`, `performance`,
`prototype`, or `generic`. If you omit the flag, the command asks you to select
a change kind. Use `generic` as the explicit escape hatch when no specialized
proof obligations apply.

The argument-less form also asks for the delivery mode before opening the task
editor. `--single` remains the default when the command includes a task or
another option. Put `--` before a task that starts with dashes.

## Behavior

1. Requires TUI or RPC mode, a Git working tree, and the `panel-review`
   extension.
2. Resolves authenticated planner and implementer models and confirms the
   assignments before spending.
3. Runs the planner with only `read,grep,find,ls`.
4. Displays the plan and asks for approval before mutation.
5. Runs the implementer with Pi's normal built-in tools.
6. Displays the implementer's final report and, on success, asks the loaded
   panel-review extension to run through Pi's in-process event bus. The panel
   keeps its own confirmation and verdict rendering.

Both `kstack-router` and direct `/plan-implement` calls supply a selected
change kind. The confirmation displays it, and the extension appends the
matching non-generic playbook to both roles. Bug fixes require a before-and-after
reproduction, refactors pin behavior, performance work compares matching
measurements, features prove observable behavior, and prototypes stay isolated
and produce a decision.

Both children use `--no-session --no-extensions --no-prompt-templates`.

### Single-PR mode (default)

Skills and context files intentionally remain enabled. A task can therefore
compose with `create-pi-extension`, `create-skill`, `find-reviewers`, or any
other matching installed/project skill without running recursive extensions.

### Stacked-PR mode (`--stack`)

Stacked-PR mode builds a **local** Jujutsu stack of changes and bookmarks, one
bookmark per PR, and reviews it once. It does not publish anything.

Stack mode adds a preflight before any model call:

- `jj >= 0.44` is available and the directory is a Jujutsu workspace;
- the workspace is colocated with a Git worktree;
- the `trunk()` revset resolves to exactly one 40-hex Git-backed commit (used as
  the immutable panel-review base);
- the session's discovered skills include `jj-stacked-prs`.

Arena is **deterministically disabled** for both children: skill discovery is
turned off with `--no-skills` and every other discovered skill is re-added with
repeated `--skill` (including `jj-stacked-prs`). This prevents parallel
candidates from corrupting a shared jj operation log while preserving
task-specific skills. The planner produces a `Delivery: stacked-prs` plan with
ordered PR slices; the implementer consults `jj-stacked-prs`, creates the local
stack, and never runs `jst submit`, `jj git push`, or `gh pr create`. After a
successful implementation, panel review runs once against the immutable
`trunk()` base. Publishing the stack to GitHub is a separate, later,
confirmed `jst submit --dry-run` workflow owned by the `jj-stacked-prs` skill.

The Planner and Implementer cards identify the model used. Expand a card with
Ctrl+O. Press **Ctrl+Shift+I** to abort an actively running child process. At
the plan-approval boundary the shortcut reports that no child is running and
does not pre-abort the future implementer.

## In-process API (composability)

The extension exposes an in-process event-bus API (`kstack:plan-implement:request`)
to allow other extensions (notably `kstack-router`) to invoke the workflow without
synthesizing slash-command strings.

The request carries a structured `{ task, mode, changeKind, ctx }` payload with a
synchronous `claimed` flag and an awaited completion promise. The slash command
and the event listener call the same internal runner. Only the slash command
collects flags and editor input. Both paths retain task validation,
Git/panel/model preflight, confirmations, lifecycle checks, cleanup, and panel
review.

See `api.ts` for the full contract and `api.test.ts` for usage examples.

## Configuration

Configuration is the `"plan-implement"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):

```json
{
  "plan-implement": {
    "planner": { "model": "openai/gpt-5.6-sol", "thinking": "max" },
    "implementer": {
      "model": "openrouter/deepseek/deepseek-v4-flash",
      "thinking": "low"
    },
    "timeoutMinutes": 30
  }
}
```

Planner and implementer models must be distinct and authenticated. Models from
providers registered by parent extensions are rejected because `--no-extensions`
children cannot reproduce those definitions, routes, or credentials. Planner
thinking is restricted to `high`, `xhigh`, or `max`; when omitted it defaults
to `high`. `timeoutMinutes` is an integer from 1 through 60 and applies to each
child.

Without config, the first authenticated candidate is selected from each list:

- Planner: GPT-5.6 Sol (max), Claude Opus 4.6 (high), Claude Fable 5 (high).
- Implementer: DeepSeek V4 Flash, Qwen 3.6 Flash, Gemini 3.5 Flash Lite,
  GLM 5.2, GPT-5.6 Terra, GPT-5.6 Luna (all low).

The extension does not fall back to the active parent model; explicit role and
cost separation is part of its contract.

## Limits and security

| Item | Limit |
| --- | --- |
| Task | 32 KiB UTF-8 |
| Planner final output | 64 KiB UTF-8 |
| Implementer final output | 32 KiB UTF-8 |
| Child stderr retained | 8 KiB UTF-8 |
| One JSONL stdout line | 2 MiB; oversized lines terminate the child |
| Child timeout | 1–60 min, default 30 |
| Panel intent | 1,000 characters |
| Abort grace | 5 s before SIGKILL |

Task and plan content are passed through mode-`0600` files in a private temp
directory, not in child argv. The directory is removed after the run.

This is process isolation, not a sandbox. The implementer runs with the user's
Pi/OS permissions and can modify the repository after approval. Skills,
context files, repository files, task text, and planner output may all contain
instructions; child system prompts tell agents to honor trusted instructions
and the explicit user task. The planner's Pi tool set is read-only, but OS file
permissions are unchanged.

Panel review uses its existing scope resolution, so its verdict may include
changes that were already present before `/plan-implement` began.

## Failure policy

- Invalid config, unavailable models, missing Git/panel-review, and bad task
  input stop before model calls.
- Stack-mode preflight failures (no jj, not a workspace, no colocated git, no
  single `trunk()` commit, missing `jj-stacked-prs` skill, Arena not excludable)
  stop before model calls.
- Planner failure or plan rejection stops before the implementer.
- Implementer failure is displayed and warns that partial edits may exist; it
  does not start panel review.
- Successful implementation invokes panel-review directly through its claimed
  event-bus request. Missing listeners and request failures are reported.
  Panel confirmation, partial reviewer failures, and synthesis behavior remain
  owned by panel-review.
- Abort sends SIGTERM to the child process group and SIGKILL after five seconds.
  Session shutdown invalidates stale callbacks and uses the same cleanup path.

## Development

Unit tests make no provider calls:

```bash
node --test extensions/plan-implement/*.test.ts
```

The full design and deferred boundaries are recorded in
[`../../plans/plan-implement.md`](../../plans/plan-implement.md).
