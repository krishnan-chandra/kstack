# Session Pickup playbook

Goal: Continue linked or archived work and recover prior decisions without
replacing the current session.

## Constraints

- **Read-only tools only**: read, grep, find, ls, plus the already-active
  read-only handoff/archive tools. No bash, write, edit, or custom mutating
  tools.
- **Use existing handoff/archive tools**: read_handoff_history and
  search_handoff_history from the handoff extension; read_session_archive
  and search_session_archive from the session-archive extension.
- **Do not replace the session**: this is a retrieval and context operation.
  Use /handoff for session replacement.
- **Identify durable context**: find the resume point, key decisions, and
  next steps from linked or archived sessions.

## Done predicate

Done when you have retrieved relevant context and identified:
- What was being worked on
- Key decisions made
- Current state of the work
- The next step to take
- Durable source references (session IDs, file paths, commit SHAs)

Present this as a structured pickup summary. Do not modify any files or
session state.