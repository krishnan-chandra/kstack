# parallel-agents

`parallel_agents` runs the parallel child processes required by the Simplify skill. In TUI mode it mounts Kstack's shared live agent pane, the same interface used by plan-implement.

## Use

The tool is model-callable; it does not add a slash command. It accepts 1–8 labeled prompts with explicit `provider/model[:thinking]` model IDs and an optional `cwd`. `maxConcurrency` defaults to 4.

Children use normal Pi extension discovery and tool defaults without a Kstack tool allowlist. The runner appends a shared read-only system prompt; tool capabilities do not enforce it. The tool does not serve Arena, which continues to use Herdr.

Each row shows queued/running/completed state, model, elapsed time, current tool, and a bounded output preview. Press **Ctrl+Shift+V** while the tool is running to open the full-screen read-only console. Use `Left`/`Right` or `Tab`/`Shift+Tab` to switch children, the arrow and paging keys to scroll, and `f` to toggle follow-tail. **Esc** closes the console without cancelling. **Ctrl+Shift+X** aborts the active run.

Transcript text and labels are sanitized and width-bounded. The shared transcript store retains at most 2 MiB or 5,000 entries per child; older entries are evicted with a notice. Pane state is ephemeral, never enters the parent session, and is available only while that tool call remains active.

## Isolation and limits

Children run with skills, prompt templates, and context files disabled. Extension discovery is enabled, but parent-only `-e` extensions, runtime registrations, and active tool selections are not transferred. Project discovery uses the child's cwd and trust state. See the [shared launch limitations](../shared/herdr/README.md#host-contract).

Prompts are passed over stdin. Each child has a 10-minute idle timeout, a 30-minute absolute runtime limit, a 48 KiB final-output cap, and an 8 KiB stderr cap. Tool cancellation and session shutdown terminate active child process groups. Queued children are not started after cancellation. Independent child failures remain in the ordered result instead of discarding sibling output.

The tool does not synthesize results or apply changes. The Simplify skill owns the edits and verification.

## Development

```bash
node --test 'extensions/parallel-agents/*.test.ts'
npm run typecheck
npm run lint
```
