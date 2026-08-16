# Steering swap

Pi's stock behavior while the agent is working is **Enter = steer** and **Alt+Enter = queue a follow-up**. This extension swaps those two keys inside the main editor, and only there. Pi's keybinding config stays at stock values (`tui.input.submit: enter`, `app.message.followUp: alt+enter`), so Enter keeps its standard behavior in every other input surface.

| State | Enter | Alt+Enter |
| --- | --- | --- |
| Pi idle | Submit normally | Submit normally (stock fallback) |
| Pi working | Queue a follow-up | Queue a steering message |
| Autocomplete popup open | Accept the completion (stock) | Stock behavior |
| Inline prompt or selector | Confirm normally | Stock behavior |

Pi delivers a steering message after the current assistant turn finishes its active tool calls and before the next model call. Follow-ups are delivered after the agent finishes all work.

## Why an editor wrapper instead of keybindings or `registerShortcut`

- Rebinding `tui.input.submit` away from Enter breaks Enter in temporary TUI inputs and inline prompts.
- Binding `app.message.followUp` to Enter intercepts Enter *before* the editor sees it, which breaks Enter-to-accept on the autocomplete popup (partial slash commands or file paths get submitted literally).
- `registerShortcut` handlers always consume the key and can only reach the limited `sendUserMessage` API, which skips prompt history, template expansion, and compaction queueing.

Instead, this extension replaces the main editor via `ctx.ui.setEditorComponent` with a `CustomEditor` subclass. When Pi is busy and no autocomplete popup is open, it routes the submit key to Pi's native follow-up handler and the follow-up key to Pi's native submit path (which steers while streaming). Everything else passes through unchanged. Because both routes reuse Pi's built-in code paths, steered and queued messages keep prompt history, template and skill expansion, compaction handling, and the queued-messages display.

## Limits

- If the submit and follow-up actions are bound to the same key, the swap disengages and Pi's stock dispatch applies.
- Pressing Enter on an open autocomplete popup while Pi is busy applies the completion and then follows Pi's stock busy-Enter behavior (steer) rather than queuing a follow-up.
- The backslash-at-end-of-line newline workaround applies to Enter (follow-up) only through Pi's native handler; use Shift+Enter for newlines while steering with Alt+Enter.

## Development

Run the focused test:

```bash
bun test extensions/steering-swap/
```
