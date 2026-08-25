# parallel-agents

`parallel_agents` runs the child processes required by the Simplify and Arena skills. In TUI mode it mounts Kstack's shared live agent pane, the same interface used by panel-review and plan-implement.

## Use

The tool is model-callable; it does not add a slash command.

- `kind: "simplify"` accepts read-only tasks only.
- `kind: "arena"` accepts read-only proposal tasks or writable candidate tasks. Writable tasks must use distinct pre-created `cwd` directories.
- `tasks` contains 1–8 labeled prompts and explicit `provider/model[:thinking]` model ids.
- `maxConcurrency` defaults to 4.

Each row shows queued/running/completed state, model, elapsed time, current tool, and a bounded output preview. Press **Ctrl+Shift+V** while the tool is running to open the full-screen read-only console. Use `Left`/`Right` or `Tab`/`Shift+Tab` to switch children, the arrow and paging keys to scroll, and `f` to toggle follow-tail. **Esc** closes the console without cancelling. **Ctrl+Shift+X** aborts the active run.

Transcript text and labels are sanitized and width-bounded. Each child keeps at most 128 KiB or 1,000 entries; older entries are evicted with a notice. Pane state is ephemeral, never enters the parent session, and is available only while that tool call remains active. Arena fan-out and cross-judge calls therefore receive separate fresh panes.

## Isolation and limits

Children run with extensions, skills, prompt templates, and context files disabled. Read-only tasks receive `read`, `grep`, `find`, and `ls`. Arena workspace tasks additionally receive `write`, `edit`, and `bash`; callers must pre-create a separate candidate worktree or directory for each writer.

A writable task runs with the user's full permissions. Its `cwd` is a working directory, not a sandbox boundary. The tool rejects assigned directories whose canonical root paths overlap, but it does not inspect their contents for symlinks or prevent a child from creating symlinks.

Prompts are passed over stdin. Each child has a 10-minute idle timeout, a 30-minute absolute runtime limit, a 48 KiB final-output cap, and an 8 KiB stderr cap. Tool cancellation and session shutdown terminate active child process groups. Independent child failures remain in the ordered result instead of discarding sibling output.

The tool does not synthesize results or apply changes. The invoking skill owns comparison, selection, grafting, edits, and verification.

## Development

```bash
node --test 'extensions/parallel-agents/*.test.ts'
node extensions/parallel-agents/scripts/parallel-agents-dashboard-e2e.ts
npm run typecheck
npm run lint
```
