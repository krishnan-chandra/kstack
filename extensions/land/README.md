# Land

`/land` is the confirmation-gated final mile after `pr-autopilot`. It pins a PR head, requires a fresh structured autopilot readiness result, confirms the exact operation, invokes `gh pr merge --match-head-commit`, and polls GitHub until the matching PR is remotely verified as merged.

```text
/land --pr 42 --method squash
/land --pr 42 --readiness watch
```

The merge method is selected from the repository's enabled methods when omitted. The extension never uses `--admin`, `--auto`, `--delete-branch`, a shell, or a force push. Each GitHub query is limited to 15 seconds, merge invocation to 60 seconds, and verification to 30 minutes. Ctrl+Shift+L aborts active polling or subprocesses; it cannot undo a merge or dequeue a request already accepted by GitHub.

A successful `gh pr merge` exit is not success: the result remains partially landed/queued until GitHub reports `MERGED` for the pinned head ref and SHA. Failures retain bounded diagnostics.

The in-process `kstack:land:request` API accepts a typed `LandOptions` request and returns a structured `LandResult`.

## Current limitation

The command currently requires an explicit `--pr` and uses the current Git branch as the expected PR head. jj stack advancement and automatic branch-to-PR target discovery are not yet implemented; `--top` fails closed without mutation.

## Development

```bash
node --test extensions/land/*.test.ts
npm run typecheck
```
