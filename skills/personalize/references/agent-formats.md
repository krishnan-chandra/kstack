# Agent session-history formats

Reference for debugging or extending `scripts/extract_sessions.py`. Read this
when extraction returns nothing for a source the user says they use, or when a
source's records look wrong. All locations are read-only for this skill's
purposes.

## Pi

- Active sessions: `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`,
  where `<path>` is the session cwd with `/` replaced by `-`.
- Archived sessions (kstack session-archive extension):
  `~/.pi/agent/archive/sessions/<year>/<month>/<uuid>/session.jsonl`, same
  JSONL format. The archive SQLite database duplicates that content for search;
  the JSONL files are the canonical source.
- Format: first line is `{"type":"session","id":...,"cwd":...}`. Conversation
  lines are `{"type":"message","timestamp":...,"message":{...}}` where
  `message.role` is `user`, `assistant`, `toolResult`, or `bashExecution`.
  Text lives in `message.content` blocks with `type:"text"`; `thinking` blocks,
  tool calls, and tool results are skipped — they are noise for personalization.
- Full spec: Pi's `docs/session-format.md` under the installed package.

## Claude Code

- `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, plus
  `<session-uuid>/subagents/*.jsonl`. Subagent transcripts are **excluded by
  default**: their "user" turns are agent-written delegation prompts, not human
  preferences. `--include-subagents` opts back in.
- Entries have `type: "user" | "assistant"`, a top-level `timestamp`, and
  `message.role` / `message.content`. Content is a string or blocks; only
  `type:"text"` blocks carry prose. `tool_use`/`tool_result` blocks are skipped.
- Control lines (`type:"mode"`, `permission-mode`, summaries, file-history)
  carry no conversation text.

## Codex

- `~/.codex/sessions/<year>/<month>/<day>/rollout-<timestamp>-<uuid>.jsonl`.
- Known payload variants:
  - `{"type":"response_item","payload":{"type":"message","role":...,"content":[{"type":"input_text"|"output_text","text":...}]}}`
  - `{"type":"event_msg","payload":{"type":"user_message"|"agent_message","message":"..."}}`
- `payload.type: "turn_context"` carries the cwd and session metadata.
- If extraction is empty, dump the distinct payload types first:
  `head -50 <file> | python3 -c 'import sys,json; [print(json.loads(l).get("payload",{}).get("type")) for l in sys.stdin]' | sort | uniq -c`

## The `--cwd` filter

For Pi and Codex it matches the cwd recorded inside the session (Pi's header,
Codex's `turn_context`), not the file path — archived Pi sessions live under a
path that contains no cwd. For Claude it matches the decoded project directory
name, which is lossy (hyphens are ambiguous) but fine for substring filtering.
Cursor records carry no cwd.

## Cursor

Two storage families exist, and schemas vary by Cursor version:

- `~/.cursor/*.sqlite` (Cursor CLI / agent storage: goals, memories, queue,
  state). JSON blobs in table values.
- Classic IDE chat history:
  `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb`
  (macOS) or `~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb`
  (Linux). Chat data historically lives in the `cursorDiskKV` table under keys
  like `aiService.prompts` and `composerData:<id>`; versions differ.

The extractor treats Cursor as best effort: it copies each database to a temp
file, opens it with SQLite `query_only`, scans value columns for JSON, and
yields strings under text-like keys (`text`, `message`, `content`, `prompt`,
`richText`). Rows whose storage key mentions prompts (e.g. `aiService.prompts`)
hold the human's prompts, so their text is `role: "user"`; everything else is
`role: "unknown"` with no timestamp, emitted only when `unknown` is explicitly
requested via `--roles` — otherwise assistant-authored prose would leak into a
user-preferences run. Table and column identifiers discovered in the schema
are always double-quoted before use in a query; a maliciously named table must
never become SQL. If a user's Cursor version stores chat elsewhere, inspect the table
list and a few rows manually before extending the extractor:

```bash
sqlite3 "file:/path/to/state.vscdb?mode=ro" ".tables"
```
