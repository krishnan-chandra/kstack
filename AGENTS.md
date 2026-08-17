# Repository guidance

## What this repository is

Kstack is a package of Pi extensions in `extensions/` and agent skills in
`skills/`. Extensions execute inside Pi with the user's full permissions, so
treat their inputs, filesystem access, subprocesses, and lifecycle as trusted
application boundaries.

## Verify

Run the full test suite and typecheck from the repository root:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run check:exports
```

The suite runs directly under Node, including the `session-archive` and handoff
tests that use `node:sqlite`. The package requires Node 22.18 or newer so native
TypeScript type stripping and the SQLite API are available without a loader.

Use a colocated test file for a focused iteration, such as
`npm run test:handoff` or `node --test check-exports.test.mjs`.

The `git-worktrees` planner and inspector are Node TypeScript CLIs. Run them
with the rest of the skill suite:

```bash
node --test skills/git-worktrees/
```

## Conventions

- Write TypeScript ESM for the extension runtime (Pi runs Node 22.18+; Node runs
  `.ts` files through type stripping without a build step). Keep runtime syntax
  erasable: do not use enums, parameter properties, or runtime namespaces.
- Colocate tests in `*.test.ts` using `node:test` so production and tests use the
  same runtime.
- Keep extension `index.ts` files as thin Pi adapters. Put domain behavior in
  named modules and inject filesystem, Git, process, time, and model effects.
- Prefer exhaustive `if` / `else if` / `switch` over nested ternaries. A
  one-level `a ? b : c` is fine; a chain of `? :` is not.
- Avoid runtime dependencies unless the platform cannot provide the capability.
- Export a symbol only for a real consumer: another module, a colocated test, or a marked contract (`/* exported: <reason> */`). `npm run check:exports` enforces this.

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
