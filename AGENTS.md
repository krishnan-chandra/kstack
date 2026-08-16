# Repository guidance

## What this repository is

Kstack is a package of Pi extensions in `extensions/` and agent skills in
`skills/`. Extensions execute inside Pi with the user's full permissions, so
treat their inputs, filesystem access, subprocesses, and lifecycle as trusted
application boundaries.

## Verify

Run the full test suite and typecheck from the repository root (Bun for local tooling):

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run check:exports
```

`bun run test` runs the suite under Bun, then chains `test:sqlite`, which runs the
`session-archive` and handoff tests that require Node under Node 22.
`archive-store.ts` uses `node:sqlite` because the extension executes inside
Pi's Node runtime, and Bun has no `node:sqlite`. `bunfig.toml` centralizes the
Bun exclusions. `bun run check:test-split` verifies that the config and the
`test:sqlite*` scripts stay aligned when the SQLite surface changes.

Use a colocated test file for a focused iteration, such as
`bun run test:handoff` or `bun test check-exports.test.mjs`.

The `git-worktrees` planner is Node/TypeScript. Inspection is still Python until
the inspector is replaced. Run both suites and compile the remaining Python
without writing bytecode into the checkout:

```bash
bun test skills/git-worktrees/
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s skills/git-worktrees/tests -p 'test_*.py'
PYTHONPYCACHEPREFIX=/tmp/kstack-pycache python3 -m py_compile skills/git-worktrees/scripts/*.py
```

## Conventions

- Write TypeScript ESM for the extension runtime (Pi runs Node 22+; Node runs
  `.ts` files through type stripping without a build step). Local tooling
  (tests, typecheck, lint, install) runs under Bun.
- Colocate tests in `*.test.ts` using `node:test` — Bun's test runner accepts
  these imports, so the suite runs under `bun test` with no per-file rewrite.
- Keep extension `index.ts` files as thin Pi adapters. Put domain behavior in
  named modules and inject filesystem, Git, process, time, and model effects.
- Prefer exhaustive `if` / `else if` / `switch` over nested ternaries. A
  one-level `a ? b : c` is fine; a chain of `? :` is not.
- Avoid runtime dependencies unless the platform cannot provide the capability.
- Export a symbol only for a real consumer: another module, a colocated test, or a marked contract (`/* exported: <reason> */`). `bun run check:exports` enforces this.

## Extension ground rules

Read [`skills/create-pi-extension/references/ground-rules.md`](skills/create-pi-extension/references/ground-rules.md)
before changing anything under `extensions/`.

## Git

Name branches `kstack/<task-slug>` and use imperative commit subjects. Never
push, publish, or open a pull request unless the user explicitly asks. An
explicit request to publish a jj stack authorizes `jj_stack_publish`; do not ask
the user for a redundant confirmation.

Write commit messages and PR descriptions to temp files (`local/` is
gitignored and suitable) and use `git commit -F` / `gh pr create --body-file`
instead of inline flags. This avoids shell escaping issues with multi-line
text and special characters.

## Hooks

`hk.pkl` at the repository root configures [hk](https://hk.jdx.dev) git hooks.
The pre-commit hook runs `biome check` on staged `.ts` files and blocks the
commit on any diagnostics at the `error` level. Install hooks with:

```bash
hk install
```

## Layout notes

- `local/` is gitignored, session-local working state. jj never snapshots it.
- Keep all advisor and executor plans in `local/plans/`. Plans are temporary
  working state and must never be tracked. Delete a plan after its change ships;
  use pull requests and Git history as the durable record.
- `config/pi-defaults/` is merged into the user's Pi configuration by
  `install.mjs`.
- Runtime configuration belongs at `$PI_CODING_AGENT_DIR/kstack.json`, never
  in this repository. The default agent directory is `~/.pi/agent`.
