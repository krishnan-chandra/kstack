# Repository guidance

## What this repository is

Kstack is a package of Pi extensions in `extensions/` and agent skills in
`skills/`. Extensions execute inside Pi with the user's full permissions, so
treat their inputs, filesystem access, subprocesses, and lifecycle as trusted
application boundaries.

## Verify

Run the full test suite and typecheck from the repository root:

```bash
npm test
npm run typecheck
npm run lint
```

Use a colocated test glob for a focused iteration, such as
`node --test extensions/handoff/*.test.ts`.

## Conventions

- Write TypeScript ESM for Node.js 22 or newer; Node runs `.ts` files through
  type stripping without a build step.
- Colocate `node:test` coverage in `*.test.ts` files.
- Keep extension `index.ts` files as thin Pi adapters. Put domain behavior in
  named modules and inject filesystem, Git, process, time, and model effects.
- Avoid runtime dependencies unless the platform cannot provide the capability.
- Export a symbol only for a real consumer: another module, a colocated test, or a marked contract (`/* exported: <reason> */`). `npm run check:exports` enforces this.

## Extension ground rules

Read [`skills/create-pi-extension/references/ground-rules.md`](skills/create-pi-extension/references/ground-rules.md)
before changing anything under `extensions/`.

## Git

Name branches `kstack/<task-slug>` and use imperative commit subjects. Never
push, publish, or open a pull request without explicit confirmation.

## Layout notes

- `local/` is gitignored, session-local working state. jj never snapshots it.
- Keep all advisor and executor plans in `local/plans/`. Plans are temporary
  working state and must never be tracked. Delete a plan after its change ships;
  use pull requests and Git history as the durable record.
- `config/pi-defaults/` is merged into the user's Pi configuration by
  `install.mjs`.
- Runtime configuration belongs at `$PI_CODING_AGENT_DIR/kstack.json`, never
  in this repository. The default agent directory is `~/.pi/agent`.
