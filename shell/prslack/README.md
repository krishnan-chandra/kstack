# prslack and prstack

`prslack` formats one GitHub pull request for chat or Markdown. `prstack`
formats a selected prefix of a published PR stack from base to selected layer.
Both commands print one line per PR:

```text
[Title](https://github.com/owner/repo/pull/123) (repo +10/-2)
```

The implementation is a sourceable POSIX shell file. It depends on an
authenticated [GitHub CLI](https://cli.github.com). `jj` is optional and is used
only when a detached jj workspace needs to infer the top bookmark.

## Install the commands

Run the standalone installer from this directory. It does not install Kstack or
change a shell startup file.

```sh
./install.sh
```

The default prefix is `~/.local`. Pass another prefix when needed:

```sh
./install.sh --prefix /usr/local
```

Ensure that the prefix's `bin` directory is on `PATH`. You can then use either
command from any shell:

```sh
prslack 123
prslack https://github.com/owner/repo/pull/123
prslack feature-branch --repo owner/repo

prstack 126
prstack feature-branch --repo owner/repo
```

With no selector, `prslack` resolves the current branch's PR. It captures the
formatted GitHub CLI output before writing the completed Markdown line to
stdout, so the final line does not pass through GitHub CLI's pager.

`prstack` accepts a PR number or branch for the selected stack layer. It follows
each open PR's base branch down to the repository's default branch, then prints
the prefix in base-to-selected order. It never includes layers above the
selection. If you omit the selector, `prstack` first asks `gh` for the current
branch's PR. In a detached jj workspace, it falls back to the nearest unique
bookmark between `trunk()` and `@`.

The installer also supports the subcommand form:

```sh
prslack stack 126
```

## Source the functions

Bash, zsh, and other POSIX-compatible shells can load the functions without
installing the command wrappers:

```sh
. /path/to/kstack/shell/prslack/prslack.sh
```

After a standalone install, source the installed copy instead:

```sh
. "$HOME/.local/lib/prslack/prslack.sh"
```

The file defines `prslack` and `prstack`. Each function runs in a subshell, so
its variables, traps, and temporary files do not alter the interactive shell.

## Options

Both functions accept the same repository and label options:

```text
-R, --repo OWNER/REPO
    --label repo|dirs
```

A PR selector can be a number, URL, branch, or jj bookmark. With no selector,
`prslack` resolves the current PR and uses the same jj fallback as `prstack`.

`prstack` follows at most 50 PRs. A missing or ambiguous ancestor is an error,
and the command does not emit a truncated prefix. The function buffers all
formatted lines and writes to stdout only after the selected prefix reaches the
default branch, so failed stacks do not leave partial output ready to paste.

## Labels

The parenthesized token defaults to the repository name:

```text
[Title](https://github.com/owner/repo/pull/123) (repo +10/-2)
```

Monorepos can switch to directory labels with a checked-in `.prslack` file:

```text
label=dirs
```

In dirs mode the token lists up to three top-level directories from the PR's
changed files, ranked by touched file count with an alphabetical tie-break:

```text
[Share retry config](https://github.com/aaru/aaru/pull/124) (backend,frontend +18/-3)
```

Root-level files use the directory name `root`. A fourth directory becomes
`+1 other`; more than that becomes `+N others`. If GitHub returns no files, the
label falls back to the repository name. `gh pr view` and `gh pr list` expose at
most 100 files, so the directory list is an approximation for very large diffs.

Mode selection, highest wins:

1. `--label repo` or `--label dirs`
2. `PRSLACK_LABEL`
3. `label=` in a `.prslack` file found by walking up from the current directory
4. `repo`

When you pass `-R owner/repo` from another checkout, `.prslack` still comes from
the current directory. Use `--label` or `PRSLACK_LABEL` in that case.
