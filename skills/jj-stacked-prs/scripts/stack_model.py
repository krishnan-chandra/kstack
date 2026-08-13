"""Shared bounded command execution, structured jj parsing, validation, and PR-slice derivation.

This module provides the core model for both the read-only inspector and
the publisher. It uses only Python's standard library plus the `jj` and
`gh` (for publisher) executables — never raw Git commands for mutation.

Important contracts:
- ``jj`` subprocesses are bounded by timeout and output caps.
- Revsets resolve to exactly one commit for publication contexts.
- Blocker detection is shared between inspection and publication.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, NamedTuple

MIN_JJ_MAJOR = 0
MIN_JJ_MINOR = 44
DEFAULT_MAX_STACK = 50
DEFAULT_TIMEOUT = 20
OUTPUT_CAP_BYTES = 256 * 1024


class CommandResult(NamedTuple):
    stdout: str
    stderr: str
    returncode: int


class StackError(Exception):
    """Base for structured errors with an exit-code hint."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# ---------------------------------------------------------------------------
# Command execution
# ---------------------------------------------------------------------------

def run_cmd(
    cmd: list[str],
    cwd: str,
    timeout: int = DEFAULT_TIMEOUT,
    env: dict[str, str] | None = None,
) -> CommandResult:
    """Run an external command with timeout and cap stderr.

    Returns (stdout, stderr, returncode). Never raises on nonzero exit.
    Raises ``StackError`` only if the binary is missing or the call times out.
    """
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            env=env,
        )
    except FileNotFoundError as exc:
        raise StackError(f"Executable was not found on PATH: {cmd[0]}", 2) from exc
    except subprocess.TimeoutExpired as exc:
        raise StackError(f"Command timed out after {timeout}s: {' '.join(cmd)}", 1) from exc
    return CommandResult(proc.stdout, proc.stderr, proc.returncode)


def run_jj(
    args: list[str],
    cwd: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> CommandResult:
    """Run ``jj`` with the given arguments."""
    return run_cmd(["jj", *args], cwd, timeout)


def run_gh(
    args: list[str],
    cwd: str,
    timeout: int = DEFAULT_TIMEOUT,
    env: dict[str, str] | None = None,
) -> CommandResult:
    """Run ``gh`` with the given arguments."""
    return run_cmd(["gh", *args], cwd, timeout, env=env)


# ---------------------------------------------------------------------------
# Version / workspace checks
# ---------------------------------------------------------------------------

def parse_jj_version(text: str) -> tuple[int, int] | None:
    """Parse ``"jj 0.44.0"`` -> ``(0, 44)``."""
    for token in text.strip().split():
        parts = token.split(".")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    return None


def require_jj(cwd: str, timeout: int = DEFAULT_TIMEOUT) -> str:
    """Ensure ``jj`` is available and meets the minimum version. Returns version string."""
    out, err, code = run_jj(["--version"], cwd, timeout)
    if code != 0:
        raise StackError(f"jj --version failed: {err.strip()}", 2)
    version = parse_jj_version(out)
    if version is None:
        raise StackError(f"Could not parse jj version from {out.strip()!r}", 2)
    if version < (MIN_JJ_MAJOR, MIN_JJ_MINOR):
        raise StackError(
            f"jj {version[0]}.{version[1]} is too old; need >= {MIN_JJ_MAJOR}.{MIN_JJ_MINOR}.",
            2,
        )
    return f"{version[0]}.{version[1]}"


def is_workspace(cwd: str, timeout: int = DEFAULT_TIMEOUT) -> bool:
    """True when *cwd* is inside a Jujutsu workspace."""
    _, _, code = run_jj(["workspace", "root"], cwd, timeout)
    return code == 0


# ---------------------------------------------------------------------------
# Revset resolution (single commit)
# ---------------------------------------------------------------------------

def resolve_revset(
    cwd: str,
    revset: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> str | None:
    """Resolve *revset* to one short commit id, or ``None`` on failure."""
    out, _, code = run_jj(
        ["log", "-r", revset, "--no-graph", "--no-pager", "-T", "commit_id.short()"],
        cwd, timeout,
    )
    if code != 0:
        return None
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1] if lines else None


def resolve_revset_strict(
    cwd: str,
    revset: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Like ``resolve_revset`` but raises ``StackError`` if resolution fails.

    This is used by publication code where an unresolvable revset must stop.
    """
    result = resolve_revset(cwd, revset, timeout)
    if result is None:
        raise StackError(f"Could not resolve revset {revset!r}.", 3)
    return result


def working_copy_change_id(cwd: str, timeout: int = DEFAULT_TIMEOUT) -> str | None:
    """Return the change id of the working copy, or ``None``."""
    out, _, code = run_jj(
        ["log", "-r", "@", "--no-graph", "--no-pager", "-T", "change_id.short()"],
        cwd, timeout,
    )
    if code != 0:
        return None
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1] if lines else None


# ---------------------------------------------------------------------------
# Bookmark queries
# ---------------------------------------------------------------------------

BOOKMARK_TEMPLATE = r'self.name() ++ "\t" ++ self.normal_target().commit_id().short() ++ "\n"'

STACK_TEMPLATE = r'''"" ++ "{\"change_id\":\"" ++ change_id.short() ++ "\",\"commit_id\":\"" ++ commit_id.short() ++ "\",\"subject\":" ++ description.first_line().escape_json() ++ ",\"empty\":" ++ if(empty, "true", "false") ++ ",\"conflict\":" ++ if(conflict, "true", "false") ++ ",\"divergent\":" ++ if(divergent, "true", "false") ++ ",\"merge\":" ++ if(parents.len() > 1, "true", "false") ++ ",\"bookmarks\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\"remote_bookmarks\":" ++ json(remote_bookmarks.map(|b| b.name())) ++ ",\"parents\":" ++ json(parents.map(|c| c.commit_id().short())) ++ "}"'''


def list_bookmarks(cwd: str, timeout: int = DEFAULT_TIMEOUT) -> list[dict[str, Any]]:
    """Return all local bookmarks as ``[{"name": ..., "commit_id": ...}]``."""
    out, _, code = run_jj(["bookmark", "list", "--no-pager", "-T", BOOKMARK_TEMPLATE], cwd, timeout)
    bookmarks: list[dict[str, Any]] = []
    if code != 0:
        return bookmarks
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 1)
        if len(parts) == 2:
            bookmarks.append({"name": parts[0], "commit_id": parts[1]})
    return bookmarks


# ---------------------------------------------------------------------------
# JSON parsing helpers
# ---------------------------------------------------------------------------

def parse_concatenated_json(text: str) -> list[dict[str, Any]]:
    """Pull sequential JSON objects out of jj's concatenated template output."""
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    idx = 0
    length = len(text)
    while idx < length:
        while idx < length and text[idx] not in "{[":
            idx += 1
        if idx >= length:
            break
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            break
        if isinstance(obj, dict):
            objects.append(obj)
        idx = end
    return objects


# ---------------------------------------------------------------------------
# Stack fetching
# ---------------------------------------------------------------------------

def fetch_stack_commits(
    cwd: str,
    revset: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict[str, Any]]:
    """Fetch commits in *revset* as a list of dicts (base -> top)."""
    out, err, code = run_jj(
        ["log", "-r", revset, "--reversed", "--no-graph", "--no-pager", "-T", STACK_TEMPLATE],
        cwd, timeout,
    )
    if code != 0:
        raise StackError(f"jj log failed: {err.strip() or out.strip()}", 1)
    return parse_concatenated_json(out)


# ---------------------------------------------------------------------------
# Blocker detection
# ---------------------------------------------------------------------------

def detect_blockers(
    commits: list[dict[str, Any]],
    trunk_commit: str,
    top_bookmark: str | None,
    wc_change: str | None,
) -> list[str]:
    """Return human-readable blocker messages for the given stack.

    This is the canonical blocker set shared by the inspector and publisher.
    """
    blockers: list[str] = []
    if not commits:
        blockers.append("No commits between trunk() and the selected top bookmark.")
    if top_bookmark is None:
        blockers.append("No top bookmark was specified and none could be inferred.")
    seen_bookmark_targets: dict[str, str] = {}
    duplicate_bookmark_commits: list[str] = []
    for c in commits:
        idx_label = f"{c['change_id']} ({c['subject'] or 'no description'})"
        if c["conflict"]:
            blockers.append(f"{idx_label} contains a merge conflict.")
        if c["divergent"]:
            blockers.append(f"{idx_label} is divergent (multiple commits share its change id).")
        if c["merge"]:
            blockers.append(f"{idx_label} is a merge commit; only linear stacks are supported.")
        if c["empty"] and c["bookmarks"] and c["change_id"] != wc_change:
            blockers.append(f"{idx_label} is empty but carries a bookmark; the PR would have no diff.")
        if not c["subject"] and c["bookmarks"]:
            blockers.append(f"{idx_label} has a bookmark but an empty description.")
        for bm in c["bookmarks"]:
            if bm in seen_bookmark_targets and seen_bookmark_targets[bm] != c["commit_id"]:
                duplicate_bookmark_commits.append(bm)
            seen_bookmark_targets[bm] = c["commit_id"]
        if len(c["bookmarks"]) > 1:
            blockers.append(
                f"{idx_label} carries multiple bookmarks ({', '.join(c['bookmarks'])}); "
                "one PR boundary per change is expected."
            )
    if duplicate_bookmark_commits:
        blockers.append(
            f"Bookmarks point to more than one commit: {', '.join(sorted(set(duplicate_bookmark_commits)))}."
        )
    if commits:
        first_parent = commits[0]["parents"][0] if commits[0]["parents"] else None
        if first_parent != trunk_commit:
            blockers.append(
                "The bottom of the inspected stack is not rooted at trunk(); "
                f"its parent is {first_parent} but trunk() is {trunk_commit}."
            )
    return blockers


# ---------------------------------------------------------------------------
# Top bookmark inference
# ---------------------------------------------------------------------------

TRUNK_NAMES = {"main", "master", "trunk"}


def detect_top_bookmark(commits: list[dict[str, Any]]) -> str | None:
    """Heuristically infer the top bookmark from the stack commits.

    Returns the first non-trunk-name bookmark on the topmost commit, or
    the first bookmark overall, or ``None``.
    """
    if not commits:
        return None
    for c in reversed(commits):
        for bm in c["bookmarks"]:
            if bm not in TRUNK_NAMES:
                return bm
    for c in reversed(commits):
        if c["bookmarks"]:
            return c["bookmarks"][0]
    return None


# ---------------------------------------------------------------------------
# PR-slice derivation
# ---------------------------------------------------------------------------

class Slice(NamedTuple):
    """One PR slice in a stack, derived from local bookmarks."""

    bookmark: str
    """The bookmark that defines this PR boundary."""

    base_bookmark: str | None
    """The bookmark below (``None`` for the bottom PR targeting trunk())."""

    change_ids: list[str]
    """Change IDs belonging to this slice (base-to-top)."""

    subject: str
    """First line of the top change's description."""


def derive_slices(
    stack: list[dict[str, Any]],
    top_bookmark: str,
) -> list[Slice]:
    """Derive PR slices from a base-to-top stack and the top bookmark.

    Each bookmark in the stack becomes a slice boundary. The change that
    carries the bookmark is the **last** change in its slice. Changes
    between the previous bookmark (exclusive) and the current bookmark
    (inclusive) belong to the current slice. Multiple changes may share
    one bookmark (one bookmark = one PR, not one commit = one PR).
    """
    # Find bookmark positions in the stack (base-to-top)
    bookmark_indices: list[tuple[int, str]] = []
    for i, entry in enumerate(stack):
        for bm in entry["bookmarks"]:
            bookmark_indices.append((i, bm))

    slices: list[Slice] = []
    prev_index = 0
    prev_bookmark: str | None = None

    for idx, bm in bookmark_indices:
        slice_changes = [stack[j]["change_id"] for j in range(prev_index, idx + 1)]
        slices.append(Slice(
            bookmark=bm,
            base_bookmark=prev_bookmark,
            change_ids=slice_changes,
            subject="",
        ))
        prev_index = idx + 1
        prev_bookmark = bm

    # Fill in subjects from the topmost change in each slice
    for i, slc in enumerate(slices):
        subject = ""
        for entry in reversed(stack):
            if entry["change_id"] in slc.change_ids and entry.get("subject"):
                subject = entry["subject"]
                break
        slices[i] = Slice(
            bookmark=slc.bookmark,
            base_bookmark=slc.base_bookmark,
            change_ids=slc.change_ids,
            subject=subject,
        )

    return slices


# ---------------------------------------------------------------------------
# Stack model builder
# ---------------------------------------------------------------------------

def build_inspect_model(
    cwd: str,
    trunk_revset: str = "trunk()",
    top: str | None = None,
    max_stack: int = DEFAULT_MAX_STACK,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Build the inspect model (same schema as inspect_stack.py).

    This is the shared model builder that both the inspector and publisher use.
    """
    jj_version = require_jj(cwd, timeout)
    if not is_workspace(cwd, timeout):
        raise StackError(f"{cwd} is not a Jujutsu workspace.", 2)

    trunk_commit = resolve_revset_strict(cwd, trunk_revset, timeout)

    bookmarks = list_bookmarks(cwd, timeout)
    top_resolved: str | None = None

    if top:
        if not any(b["name"] == top for b in bookmarks):
            raise StackError(
                f"Bookmark {top!r} does not exist locally. Available: "
                f"{', '.join(sorted(b['name'] for b in bookmarks)) or '(none)'}.",
                3,
            )
        top_resolved = resolve_revset_strict(cwd, top, timeout)

    # First pass to infer the top bookmark if omitted
    preliminary_revset = f"{trunk_revset}..{top}" if top else f"{trunk_revset}..@"
    preliminary = fetch_stack_commits(cwd, preliminary_revset, timeout)

    if not top:
        top = detect_top_bookmark(preliminary)
        if top:
            top_resolved = resolve_revset(cwd, top, timeout)
            if top_resolved:
                commits = fetch_stack_commits(cwd, f"{trunk_revset}..{top}", timeout)
            else:
                commits = preliminary
        else:
            commits = preliminary
    else:
        commits = preliminary

    wc_change = working_copy_change_id(cwd, timeout)
    truncated = False
    if len(commits) > max_stack:
        truncated = True
        commits = commits[:max_stack]

    for c in commits:
        c["is_working_copy"] = c["change_id"] == wc_change

    blockers = detect_blockers(commits, trunk_commit, top, wc_change)

    return {
        "schemaVersion": 1,
        "jj_version": jj_version,
        "trunk": {"ref": trunk_revset, "commit_id": trunk_commit},
        "top": top,
        "top_commit_id": top_resolved,
        "all_local_bookmarks": sorted(b["name"] for b in bookmarks),
        "stack_size": len(commits),
        "truncated": truncated,
        "max_stack": max_stack,
        "stack": commits,
        "blockers": blockers,
    }


def enforce_output_cap(model: dict[str, Any], cap_bytes: int = OUTPUT_CAP_BYTES) -> dict[str, Any]:
    """Enforce the output byte cap by trimming the stack array if needed.

    Mutates and returns *model* with ``output_truncated`` set when trimming occurs.
    """
    text = json.dumps(model, indent=2)
    if len(text.encode("utf-8")) > cap_bytes:
        model["output_truncated"] = True
        while len(json.dumps(model, indent=2).encode("utf-8")) > cap_bytes and len(model["stack"]) > 0:
            model["stack"].pop()
        model["stack_size"] = len(model["stack"])
        if not model["blockers"]:
            model["blockers"].append("Output exceeded the cap; trailing commits were dropped from the model.")
    return model