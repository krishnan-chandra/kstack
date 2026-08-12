# session-naming

Give every persisted Pi session a human-readable name before work begins. Named sessions are easier to distinguish in `/resume` and are the only sessions shown by kstack's `/session-archive-other` picker.

## Behavior

On the first user prompt in an unnamed persisted session, the extension derives a compact suggestion from the first meaningful line. Handoff prompts prefer the text under `## Goal`.

- In TUI and RPC sessions, Pi asks for a name. Enter a name, or submit an empty value to accept the suggestion.
- Cancelling leaves the session unnamed and does not send the pending prompt. Submit it again to reopen the naming dialog.
- Extension-injected and non-UI prompts use the suggestion automatically because no naming dialog is available.
- Existing names are never replaced. Ephemeral `--no-session` sessions are ignored because they cannot appear in `/resume` or the archive.
- Names are whitespace-normalized and limited to 80 Unicode characters. The extension does not call a model.

Use Pi's built-in `/name <name>` command to rename a session later.

## Limits and failure policy

This is a workflow guard, not a uniqueness system. Different sessions can have the same name; the archive picker adds a modified timestamp only when duplicate names need disambiguation.

If Pi cannot persist a name, the pending interactive prompt is not sent and the error is shown. Inputs that arrive without a UI use a deterministic fallback such as `Session 019ff703` when they contain no text.

## Development

```bash
node --test extensions/session-naming/*.test.ts
```

The tests use fake session contexts and do not read or modify real Pi sessions.
