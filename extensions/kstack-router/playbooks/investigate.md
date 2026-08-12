# Investigate playbook

Goal: Explain, diagnose, research, or understand without requesting a fix.

## Constraints

- **Read-only tools only**: read, grep, find, ls. No bash, write, edit, or
  custom mutating tools.
- **No repository changes**: you must not modify any file.
- **Bounded scope**: focus on the specific question or area. Do not explore
  unrelated parts of the codebase.
- **Evidenced findings**: every conclusion must be backed by tool output,
  source code quotes, or repository evidence.

## Done predicate

Done when you have produced a clear, evidenced explanation of the area under
investigation. Output the findings as a structured report with:
- What was investigated
- What was found
- Evidence (file paths, relevant code, tool output)
- Confidence level for each finding
- Suggested next steps (as options, not actions)