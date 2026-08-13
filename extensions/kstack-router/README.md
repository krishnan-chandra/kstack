# Kstack Router

The package's front door. Routes tasks through a lightweight classifier or
explicit `--route` selection, then dispatches to the appropriate workflow. It
names an unnamed session from the task before classification or dispatch and
never overwrites an explicit session name.

```
/kstack [--route <id>] [--single|--stack] [--worktree] [--change-kind <kind>] [--] <task>
```

## Route table

| Route | Description | Dispatch target |
|---|---|---|
| `investigate` | Read-only research, explain, diagnose | Active session, read-only tools |
| `change` | Feature, fix, refactor, prototype | plan-implement → panel-review |
| `arena` | Competing parallel candidates | Arena skill, frame-first |
| `swarm` | Parallel independent slices | Swarm skill, frame-first |
| `skill-authoring` | Create, improve, test skills | create-skill skill, frame-first |
| `session-pickup` | Continue archived work, read-only | Active session, read-only tools |
| `review` | Review working tree changes | panel-review |
| `unsupported` | No safe dispatch available | Nothing |

## Examples

```bash
/kstack Explain the archive indexing strategy
/kstack --route investigate What does the handoff extension do?
/kstack --route change --change-kind refactor Refactor the config loader
/kstack --route change --worktree --change-kind feature Add isolated search
/kstack --route change --stack --change-kind feature Split feature into three PRs
/kstack --route review Review the latest changes
/kstack --route arena -- "Generate three alternative designs"
/kstack --route skill-authoring -- "Create a linter skill"
/kstack --route session-pickup -- "What was I working on?"
```

## Change-kind playbooks

For the `change` route, the classifier recommends one of `bug-fix`, `feature`,
`refactor`, `performance`, `prototype`, or `generic`. The selected kind appears
in the route card and plan-implement confirmation. Override it explicitly when
the classifier has insufficient context:

```text
/kstack --route change --change-kind performance Reduce archive-index latency
```

`--worktree` is valid only for the change route and dispatches single-PR work
to a managed Git linked worktree beneath `~/.pi/kstack/worktrees`. It cannot be
combined with `--stack` in v1.

Non-generic kinds attach a concise proof-obligation playbook to both child
roles. Bug fixes reproduce and rerun the same regression check; refactors pin
and preserve behavior; performance work records matching baseline and
post-change measurements; features exercise observable user behavior; and
prototypes remain isolated and answer a decision question. `generic` retains
the existing general workflow without an added specialized playbook.

## Configuration

Add a `kstack-router` section to `$PI_CODING_AGENT_DIR/kstack.json`:

```json
{
  "kstack-router": {
    "classifier": {
      "model": "openrouter/google/gemini-3.5-flash-lite",
      "thinking": "low"
    },
    "timeoutSeconds": 90
  }
}
```

All fields are optional. Without configuration:

- Classifier uses the built-in default small model.
- If that model is unavailable, the active session model is used with a
  warning.
- Timeout defaults to 90 seconds.
- If no model is available at all, the router falls back to manual route
  selection.

## Model fallback

1. Configured model (from `kstack.json`).
2. Built-in default: `openrouter/google/gemini-3.5-flash-lite`.
3. Active session model (with a warning about latency/cost).
4. Manual route picker (no model call).

## Costs and limits

- Classifier: one small-model call. Cost is typically < $0.01.
- Task limit: 32 KiB.
- Classifier timeout: 90 seconds (configurable).
- Rationale limit: 500 characters.
- The classifier child uses `--no-tools --no-extensions --no-skills
  --no-prompt-templates --no-context-files` — it cannot touch the repository
  or any resources.

## Cancellation

- `Ctrl+Shift+K`: abort the classifier during classification.
- After dispatch, use the downstream cancellation mechanism:
  - `Ctrl+Shift+I`: abort plan/implement.
  - `Ctrl+Shift+X`: abort panel review.
  - `Esc` (normal agent cancellation) for active-session routes.
- The active-session read-only gate is lifted automatically when the routed
  turn settles — including after cancellation — and on session shutdown, so
  restricted tools never leak into ordinary prompts.

## Security

The classifier runs in an isolated child process with no tools, no extensions,
no skills, no prompt templates, and no context files. Its output is a
strictly validated JSON envelope. Invalid, malformed, or injection-shaped
classifier output fails safe to manual route selection.

Downstream routes have their own trust boundaries:
- `change` restricts the planner to read-only tools and requires explicit
  approval.
- `review` runs reviewers in isolated read-only subprocesses.
- `investigate` and `session-pickup` use read-only tools only.
- `arena`, `swarm`, `skill-authoring` require read-only framing + approval
  before any write tool or paid fan-out.

## RPC behavior

- The router requires interactive TUI or RPC mode.
- It persists the derived session name before classifier or downstream workflow model calls.
- Classification output is displayed via notifications; the user confirms or
  overrides the route.
- The `kstack-route` message card records the selected route, delivery mode,
  classifier source, and dispatch status.

## Troubleshooting

**"plan-implement extension is not loaded"**: Run `pi list` to verify
plan-implement is installed. Run `/reload` after installing it.

**"panel-review extension is not loaded"**: Same — verify installation and
reload.

**"Classifier timed out"**: The classifier model may be slow. Increase
`timeoutSeconds` in config, or use `--route` to bypass the classifier.

**"Skill not found"**: The required skill (e.g. `arena`, `swarm`) is not
discovered. Ensure this repository is installed as a Pi package: `pi install
/path/to/kstack`.

## Development

```bash
# Unit tests (pure modules: args, catalog, classification, config, runner, lifecycle, dispatch)
node --test extensions/kstack-router/*.test.ts

# Headless adapter smoke test: registers the real extension against a mock Pi
# and drives tool gating, playbook injection, restoration, and delegation.
node extensions/kstack-router/scripts/smoke-mock-pi.mjs
```