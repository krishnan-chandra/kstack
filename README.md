# krishnan-pi-extensions

Personal extensions for [Pi](https://pi.dev).

> Pi extensions execute with your full user permissions. Review extension code before installing it.

## Extensions

| Extension | Description |
| --- | --- |
| [`session-archive`](extensions/session-archive/) | Moves completed Pi sessions out of the active session directory, preserves their canonical JSONL, and indexes them locally with SQLite/FTS5. |
| [`handoff`](extensions/handoff/) | Opens a lean replacement session with an editable reference prompt and read-only tools for normalized, on-demand access to the linked session's active or archived history. |
| [`panel-review`](extensions/panel-review/) | Runs 2–4 isolated read-only reviewer subagents in parallel against the current Git changeset and synthesizes a lead-review verdict. |

## Skills

| Skill | Description |
| --- | --- |
| [`create-pi-extension`](skills/create-pi-extension/) | Designs and implements Pi extensions using the installed documentation, repository patterns, lifecycle/security ground rules, and an incremental verification checklist. |

## Requirements

- Pi 0.84.1 or newer
- Node.js 22 or newer
- A local filesystem for Pi's agent directory

The extensions use TypeScript directly through Pi's loader. No build or dependency installation is required.

## Install into local Pi

This repository follows Pi's conventional package layout: each directory under `extensions/` exposes an `index.ts`. Install the checkout as a local Pi package to load all extensions in the repository:

```bash
pi install "$HOME/Code/krishnan-pi-extensions"
```

Pi records a reference to the local checkout in its user settings; it does not copy the repository. Pulling or editing the checkout therefore updates the installed code. Use `/reload` in a running Pi process, or restart Pi, after a change.

Inspect or enable installed resources with:

```bash
pi list
pi config
```

Remove the package registration with:

```bash
pi remove "$HOME/Code/krishnan-pi-extensions"
```

### Manual installation

Pi also auto-discovers global extensions under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/`. To install only the session archive extension, either symlink it:

```bash
cd ~/Code/krishnan-pi-extensions
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$PI_AGENT_DIR/extensions"
ln -s "$PWD/extensions/session-archive" "$PI_AGENT_DIR/extensions/session-archive"
```

or copy it:

```bash
cd ~/Code/krishnan-pi-extensions
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$PI_AGENT_DIR/extensions/session-archive"
cp -R extensions/session-archive/. "$PI_AGENT_DIR/extensions/session-archive/"
```

The symlink destination must not already exist. If it does, move or remove the existing extension only after checking whether it contains changes you need to keep. Repeat a manual copy whenever the repository changes.

For a one-off test without installing anything, run from any directory:

```bash
pi -e "$HOME/Code/krishnan-pi-extensions/extensions/session-archive/index.ts"
```

## Development

Run the extension tests from the repository root:

```bash
node --test extensions/session-archive/*.test.ts
node --test extensions/handoff/*.test.ts
node --test extensions/panel-review/*.test.ts
```

The package also includes the `create-pi-extension` skill. It is discovered when this repository is installed with `pi install`; invoke it explicitly with `/skill:create-pi-extension` or let Pi load it when extension-development work matches its description.

The full smoke test starts isolated Pi RPC processes, makes two small model calls, and does not touch the normal Pi session directory:

```bash
python3 extensions/session-archive/scripts/e2e-smoke.py
```

See the [session archive README](extensions/session-archive/README.md) for commands, storage paths, recovery behavior, and security limitations.
