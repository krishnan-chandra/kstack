# Plan 016: Read-only transcript inspector overlay for panel-review

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e0a1fb5..HEAD -- extensions/panel-review/ extensions/shared/child-agent-runner.ts`
> Material drift in `live-dashboard.ts`, `run-phases.ts`, or the
> `onProgress` contract in `child-agent-runner.ts` is a STOP.
>
> **Required reading before writing code**:
> - `skills/create-pi-extension/references/ground-rules.md` (whole file)
> - `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
>   — especially "Overlays", "Overlay Focus", "Overlay Lifecycle", and
>   "Keyboard Input"
> - `extensions/panel-review/live-dashboard.ts` — the store/component/mount
>   pattern this plan mirrors
> - `extensions/shared/child-agent-runner.ts` — the JSONL event loop being
>   extended

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — touches the shared child runner used by panel-review,
  plan-implement, and pr-autopilot, and adds a focusable overlay to a
  running pipeline. Mitigation: the new event callback is additive and
  optional; existing `onProgress` behavior must be byte-identical; overlay
  is TUI-only and read-only.
- **Depends on**: plan 015 (DONE — run-phases extraction this builds on)
- **Category**: feature
- **Planned at**: commit `e0a1fb5`, 2026-08-14

## Why this matters

During a panel run the TUI widget shows one line per child: status, turns,
elapsed, the current tool call, and a single rolling preview line. The data
pipeline is far richer: `runChildAgent` parses every JSONL event from each
child (tool calls with args, assistant text deltas, per-turn usage) and
discards nearly all of it. Users watching a 4-reviewer panel for several
minutes cannot answer "what has the deepseek reviewer actually looked at?"
or "what did glm conclude in turn 3?" without waiting for the final verdict.

This plan adds an on-demand, focusable, **strictly read-only** inspector
overlay. There is deliberately no way to message or steer the child
reviewers.

## Contract

### User-visible behavior

- New shortcut `ctrl+shift+v`, registered in
  `extensions/panel-review/index.ts` alongside the existing
  `ctrl+shift+x` abort shortcut:
  - While a panel run is active in TUI mode: opens the inspector overlay.
  - No active run, or non-TUI mode: `ctx.ui.notify("No panel review is
    running.", "info")` (mirror the abort shortcut's no-op path).
- Widget header gains a hint. Current text:
  `— Ctrl+Shift+X to abort` becomes `— ^⇧V inspect · ^⇧X abort`
  (keep it short; the header is already truncated on narrow widths).
- Overlay layout (opened via `ctx.ui.custom(..., { overlay: true })`,
  `overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" }`):
  - Line 1: tab bar — one entry per child in dashboard order (reviewers,
    then lead once revealed), each `⟨icon⟩ label`, selected tab highlighted
    with `theme.fg("accent", ...)`, others `muted`. Icons reuse the
    dashboard's `STATUS_ICON` mapping.
  - Line 2: separator/meta line for the selected child: model, status,
    turns, elapsed, cumulative cost if nonzero.
  - Body: scrollable transcript of the selected child (newest at bottom),
    rendered from the transcript store (below).
  - Last line: key help: `←→/tab child · ↑↓ PgUp PgDn scroll · f follow · esc close`.
- Keys (via `matchesKey` from `@earendil-works/pi-tui`):
  - `left`/`right`/`tab`/`shift+tab`: switch selected child.
  - `up`/`down`/`pageup`/`pagedown`: scroll; `g`/`G` jump top/bottom.
  - `f`: toggle follow-tail. Default ON. Any manual scroll away from the
    bottom turns follow OFF; scrolling back to the bottom or pressing `f`
    turns it back ON.
  - `escape`: close the overlay (resolve `done(undefined)`).
  - All other input is swallowed. **Nothing is ever written to a child.**
- Overlay lifecycle: when the pipeline tears down (`dashboard.dispose()` in
  `run-phases.ts` finally block), the overlay must auto-close if open.
  Re-opening after the run ends is not supported (transcripts are dropped
  with the run — ephemeral by design).
- Opening the overlay must not pause, slow, or reorder the run. The abort
  shortcut `ctrl+shift+x` must still work while the overlay is open (it is
  a registered app shortcut, not overlay input — verify this manually).

### Transcript content per child

Ordered, bounded entries:

- `tool` — `● read foo.ts` plus duration once the matching
  `tool_execution_end` arrives (`· 340ms`, via existing `formatDuration`).
  Reuse `summarizeToolCall` for the summary. **Do not capture tool result
  payloads** (v2 at most; children are read-only and results can be huge).
- `text` — final assistant text per turn (from the `message_end` assistant
  message), rendered wrapped. Streaming deltas update a single mutable
  "current turn" tail entry so the user sees live text; on `message_end`
  the tail is frozen into a `text` entry.
- `turn` — turn boundary marker with per-turn usage
  (`— turn 3 · in 12.4k out 800 · $0.012`).
- `note` — lifecycle notes: started, completed/failed/aborted (+ error).

### Limits (define as named constants next to the store)

- Per-child transcript cap: 128 KiB of entry text (byte-accounted with
  `Buffer.byteLength`); evict oldest whole entries; when eviction occurs
  the first visible entry is a fixed marker
  `… earlier transcript dropped (cap 128 KiB)`.
- Per-entry text cap: 8 KiB via existing `truncateTailUtf8` for the live
  tail and `truncateHeadUtf8` for frozen text entries.
- Max entries per child: 1000 (secondary guard against many tiny entries).
- These are ephemeral in-memory buffers only. **Nothing is written to the
  session or disk.** The durable artifact remains the final `panel-review`
  custom message.

### Security

All transcript text is untrusted child/repository-derived content:

- Strip terminal sequences before theming, per line, using the injected
  `stripTerminalSequences` (same injection pattern as `live-dashboard.ts`,
  with the local fallback for tests).
- Unlike the dashboard's single-line `sanitizeDisplayText`, the transcript
  body preserves newlines: add a `sanitizeMultilineText` that strips
  ANSI/OSC/APC and C0/C1 controls **except** `\n`, then wraps with
  `wrapTextWithAnsi`/`truncateToWidth` so no rendered line exceeds width.
- The overlay grants no new capabilities: no input reaches children, no
  paths are exposed beyond what the widget already shows.

## Implementation steps

### Step 1 — shared runner: structured event callback (additive)

`extensions/shared/child-agent-runner.ts`:

- Add and export:

  ```ts
  export type ChildEvent =
    | { kind: "tool_start"; summary: string; at: number }
    | { kind: "tool_end"; durationMs?: number; at: number }
    | { kind: "text_delta"; delta: string; at: number }
    | { kind: "turn_end"; turn: number; text: string; usage: ChildUsage; at: number };
  ```

  (`usage` in `turn_end` is the per-turn delta, not cumulative; compute it
  from the message's own usage fields, which the loop already reads.)
- Add optional `onEvent?: (event: ChildEvent) => void` to
  `RunChildOptions`. Emit from the existing `JsonLineParser` handler at the
  points that already handle these event types. To compute `tool_end`
  durations, record the `tool_start` timestamp in a local variable
  (children run tools serially; a single slot is sufficient — if a second
  `tool_start` arrives before `tool_end`, emit `tool_end` without duration
  and continue).
- Timestamps come from `Date.now()`; do **not** add a clock dependency to
  the runner (its tests use fake spawn, not fake time).
- `onProgress` behavior and payloads must be unchanged. Existing callers
  (plan-implement, pr-autopilot) pass no `onEvent` and must be unaffected.

Tests (`extensions/shared/child-agent-runner.test.ts`): extend existing
fake-spawn fixtures to assert the event sequence for a scripted JSONL
stream: tool_start → tool_end (with duration) → text_delta(s) → turn_end
with per-turn usage; and that omitting `onEvent` changes nothing.

### Step 2 — reviewer-runner passthrough

`extensions/panel-review/reviewer-runner.ts`:

- Add `onEvent?: (event: ChildEvent) => void` to `RunReviewerOptions`;
  forward it to `runChildAgent`. Re-export `ChildEvent`.

Test: one assertion in `reviewer-runner.test.ts` that the callback is
forwarded (existing fake-deps pattern).

### Step 3 — transcript store

New `extensions/panel-review/transcript-store.ts` + tests. Mirror the
`PanelDashboardStore` shape (synchronous, subscriber `Set`, injected
`now`):

```ts
export type TranscriptEntry =
  | { kind: "note"; text: string; at: number }
  | { kind: "tool"; summary: string; durationMs?: number; at: number }
  | { kind: "text"; text: string; turn: number; at: number }
  | { kind: "turn"; turn: number; usage: ChildUsage; at: number };

export class PanelTranscriptStore {
  addChild(id: string): void;
  push(id: string, event: ChildEvent): void;   // maps ChildEvent → entries
  note(id: string, text: string): void;        // started/finished notes
  getEntries(id: string): readonly TranscriptEntry[];
  getLiveTail(id: string): string | undefined; // current streaming turn text
  wasEvicted(id: string): boolean;
  subscribe(listener: () => void): () => void;
}
```

Mapping rules:

- `text_delta` appends to the live tail (capped, `truncateTailUtf8`); it
  does not create entries.
- `turn_end` freezes the tail into a `text` entry (using the event's full
  `text`, head-truncated to the entry cap) followed by a `turn` entry, then
  clears the tail.
- `tool_end` mutates the most recent `tool` entry's `durationMs` if it is
  the last entry and has no duration yet; otherwise it is dropped.
- Enforce the byte/entry caps from the Contract section on every push.

Tests: cap eviction (oldest-first, marker exposed via `wasEvicted`),
tail freeze on turn_end, tool duration attachment, unknown-id pushes are
ignored, subscriber emission.

### Step 4 — inspector overlay renderer + component

New `extensions/panel-review/inspector-overlay.ts` + tests.

- Pure renderer, testable without Pi (same philosophy as
  `renderDashboard`):

  ```ts
  export interface InspectorState {
    selectedIndex: number;
    scrollOffset: number;  // lines from bottom; 0 = follow tail
    follow: boolean;
  }
  export function renderInspector(
    dashboard: PanelDashboardStore,
    transcripts: PanelTranscriptStore,
    state: InspectorState,
    width: number,
    height: number,
    theme: DashboardTheme,
    text: TerminalText,
  ): string[];
  ```

  It flattens the selected child's entries to sanitized, wrapped lines,
  then windows by `height` minus chrome (tab bar, meta, help). Every line
  goes through `truncateToWidth`.
- `InspectorComponent implements Component`: owns an `InspectorState`,
  subscribes to both stores for re-render, implements `handleInput` per
  the key contract, calls `tui.requestRender()` after state changes, and
  `dispose()` unsubscribes idempotently.
- Export `openInspector(ctx, dashboardStore, transcriptStore, text):
  { close(): void; closed: Promise<void> }` that wraps `ctx.ui.custom` with
  the overlay options from the Contract, wires `escape → done(undefined)`,
  and exposes `close()` for pipeline teardown (calls `done` once,
  idempotent).

Renderer tests: tab bar selection/highlighting, windowing math (follow tail
vs scrolled), eviction marker line, width safety on narrow widths (assert
`visibleWidth`-style length via the fallback `TerminalText`), sanitization
of hostile ANSI/OSC input in entries.

### Step 5 — wiring

`extensions/panel-review/index.ts` and `run-phases.ts`:

- `createDashboard(ctx, reviewers)` also constructs a
  `PanelTranscriptStore`, seeds `addChild` per reviewer, and returns it on
  the `PipelineDashboard` surface. Extend `PipelineDashboard` with:
  - `event(label: string, event: ChildEvent): void`
  - `note(label: string, text: string): void`
  (no-ops when there is no TUI dashboard — non-TUI callers keep working).
- `run-phases.ts`:
  - Pass `onEvent: (event) => { if (fx.isCurrent()) dashboard?.event(spec.label, event); }`
    into both `ops.runReviewer` calls (reviewers and lead). When the lead
    row is added (`dashboard.addLead`), also `addChild("lead")` on the
    transcript store (do this inside the index.ts adapter so run-phases
    stays ignorant of the store).
  - Emit `note` on markRunning/complete transitions (adapter-side is fine).
- `index.ts`:
  - Module-level `let activeInspector: { close(): void } | undefined` and
    `let activeStores: { dashboard: PanelDashboardStore; transcripts: PanelTranscriptStore } | undefined`,
    set/cleared exactly where `activeAbort` is managed today.
  - Register `ctrl+shift+v` per the Contract. Guard: TUI mode + stores
    present + lifecycle running; otherwise notify. Opening twice while one
    is open is a no-op (check `activeInspector`).
  - In the dashboard `dispose` wrapper returned by `createDashboard`, call
    `activeInspector?.close()` and clear both module-level slots (dispose
    is already idempotent — keep it that way).
  - Update the widget header hint in `live-dashboard.ts`
    (`renderDashboard`) and its test expectations.
  - Update `session_shutdown` to also close the inspector.

### Step 6 — docs and verification

- `extensions/panel-review/README.md`: document the shortcut, the
  read-only guarantee, the caps, and the ephemeral (never persisted)
  nature of transcripts.
- Run:

  ```bash
  npm test
  npm run typecheck
  ```

  Both must pass. Focused loop during development:
  `node --test extensions/panel-review/*.test.ts extensions/shared/child-agent-runner.test.ts`.
- Manual TUI smoke (executor with terminal access; otherwise flag for the
  user): start a real `/panel-review` on a small diff, open the inspector,
  switch tabs, scroll, verify `ctrl+shift+x` aborts while the overlay is
  open and the overlay closes on teardown.

## STOP conditions

- `onProgress` payloads or ordering in `child-agent-runner.ts` would need
  to change to support events — STOP; the design requires it be additive.
- The overlay needs to send any data to a child process — STOP; out of
  contract.
- `ctx.ui.custom` overlay APIs in the installed Pi distribution differ
  materially from `docs/tui.md` (missing `overlay`/`overlayOptions`) —
  STOP and report the installed API surface.
- Transcript capture measurably degrades run throughput (e.g. re-render
  storms from `text_delta`) and cannot be fixed by coalescing emissions
  (acceptable fix: throttle store→subscriber emission to ~10/s) — STOP if
  throttling is insufficient.
- plan-implement or pr-autopilot tests break — STOP; the shared runner
  change was supposed to be invisible to them.

## Non-goals (do not implement)

- Messaging, steering, or restarting child reviewers.
- Persisting transcripts to the session or disk.
- Capturing tool result payloads or raw child stdout in the transcript.
- Inspector support in RPC/non-TUI mode.
- Reopening the inspector after the run has ended.

## Acceptance checklist

- [ ] `ctrl+shift+v` opens the inspector during a TUI panel run; notifies
      otherwise.
- [ ] Tab switching, scrolling, follow-tail, and escape work per contract.
- [ ] Live text streams into the selected child's tail; turns freeze with
      usage markers; tool calls show durations.
- [ ] Hostile ANSI/OSC content in child output renders inert.
- [ ] Caps enforced with visible eviction marker; no unbounded memory.
- [ ] Overlay auto-closes on pipeline teardown and on session shutdown.
- [ ] `onProgress` consumers (plan-implement, pr-autopilot) unchanged;
      full `npm test` and `npm run typecheck` green.
- [ ] README updated; `plans/README.md` status row updated.
