---
name: create-pi-extension
description: Design, implement, review, or extend TypeScript extensions for Pi in this repository. Use when adding Pi commands, tools, lifecycle hooks, session behavior, subprocess orchestration, custom UI, persistence, or package resources under extensions/.
---

# Create a Pi extension

Build extensions from the installed Pi contract and this repository's proven patterns, not from memory or APIs from another Pi distribution.

## Start with evidence

1. Read Pi's installed `docs/extensions.md` **completely**. Follow its links to every topic the feature uses (for example `tui.md`, `session-format.md`, `sessions.md`, `packages.md`, `rpc.md`, or `compaction.md`).
2. Inspect the closest shipped implementation under Pi's `examples/extensions/`.
3. Read this repository's root `README.md`, the READMEs and entry points of the closest extensions, and [the repository ground rules](references/ground-rules.md).
4. Search archived session history for the relevant extension or design topic. Treat history as design evidence, not as a substitute for current docs and code.
5. Inspect the installed package's exported types when documentation is ambiguous. Do not guess an API.

Resolve installed Pi documentation from the active installation (in this environment, `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`). Do not edit installed docs or examples.

## Decide the right form first

Use an **extension** only when the feature needs deterministic runtime behavior: commands, model-callable tools, event interception, session lifecycle, persistence, subprocesses, or UI. Use a **skill** for progressively disclosed instructions that the agent can execute with existing tools. Use a prompt asset for reusable prose. Record the decision when it is not obvious.

## Design before wiring

For nontrivial work, write or update `local/plans/<extension>.md` before implementation. `local/` is ignored working state; never commit plan files. Define:

- user-visible contract and explicit non-goals;
- commands, tools, events, and persisted custom entries;
- trust/security boundary and mutation policy;
- lifecycle, cancellation, replacement-session, and cleanup behavior;
- bounded inputs, outputs, model context, and subprocess runtime;
- failure policy and recovery/idempotency requirements;
- unit, integration, and isolated smoke-test plan.

Prefer the smallest public surface. Mutation should normally remain an explicit user command with confirmation; agent tools should be narrow and read-only unless model-driven mutation is the feature's stated purpose.

## Implement in layers

Create `extensions/<name>/index.ts` as the Pi adapter. Keep registration and handlers thin. Move parsing, validation, storage, orchestration, formatting, and other deterministic behavior into focused modules with colocated `*.test.ts` files.

Use current imports:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
```

Additional rules:

- Export a default extension factory from `index.ts`.
- Use `CONFIG_DIR_NAME`, `ctx.cwd`, Pi APIs, and environment variables instead of hardcoded config/session paths.
- Validate at every boundary: command arguments, config files, tool parameters, paths, persisted records, provider output, and child-process output.
- Bound all model-facing and user-facing bulk text and provide honest truncation/continuation information.
- Honor `AbortSignal`; make cancellation visible and clean up idempotently.
- Start long-lived resources at `session_start` or on demand, never in the factory; close them in `session_shutdown`.
- Guard TUI-only behavior with `ctx.mode === "tui"`; guard dialogs with `ctx.hasUI` as documented.
- After `newSession`, `switchSession`, `fork`, or `reload`, never use captured session-bound `pi`, `ctx`, or `SessionManager` objects. Capture only plain serializable data and use the fresh callback context.
- Treat extension, skill, context-file, repository, model, and subprocess content as untrusted at the appropriate boundary. State security limitations accurately; do not call convention or file permissions a sandbox.
- Do not add a shared framework merely to remove superficial duplication. Extract shared code only after concrete callers prove a stable contract.

## Verify incrementally

1. Test pure parsing and validation.
2. Test deterministic modules with injected filesystem, Git, spawn, clock, and model dependencies.
3. Test command/tool registration and lifecycle ordering with fakes.
4. Cover cancellation, malformed input, partial failure, timeout, cleanup failure, output truncation, and retries/idempotency.
5. Run the extension tests from the repository root:

```bash
# Run the extension tests under Node:
node --test extensions/<name>/
# Or: npm run test:session-archive
# Or: npm run test:handoff
```

6. Run all repository extension tests before finishing:

```bash
npm run test:extensions
```

7. Load with `pi -e extensions/<name>/index.ts` or use an isolated `PI_CODING_AGENT_DIR` smoke test. Never use real sessions, archives, credentials, or repositories as destructive fixtures.
8. Review `git diff` and verify generated/private artifacts are absent.

If a smoke test makes provider calls, say so before running it and keep the prompt count and cost small.

## Finish the package

Every extension directory needs a README covering purpose, usage, behavior, configuration, limits, security/failure policy, development commands, and deferred work. Update the root extension table and development commands. Keep docs honest about what tests were actually run and what remains unverified.

Use [the completion checklist](references/ground-rules.md#completion-checklist) before reporting done.
