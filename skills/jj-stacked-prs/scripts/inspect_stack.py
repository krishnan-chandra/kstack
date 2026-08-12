#!/usr/bin/env python3
"""Read-only, bounded inspection of a Jujutsu bookmark stack.

No GitHub access, no credentials, no mutation. Emits a JSON model of the
commits from ``trunk()`` up to a selected top bookmark (base -> top), with
change/commit ids, bookmarks, parents, and the states that block submission
(conflict, divergence, merge, empty description). The model is what the skill
formats into its stack table; the script never prints advice.

Usage:
    inspect_stack.py [--repo PATH] [--top BOOKMARK] [--trunk REVSET]
                     [--max-stack N] [--timeout SECS]

Exit codes:
    0  inspection succeeded (blockers may still be present in the output)
    2  jj is missing, too old, or not a jj workspace
    3  the requested top bookmark or trunk revset could not be resolved
    1  any other runtime error
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

MIN_JJ_MAJOR = 0
MIN_JJ_MINOR = 44
DEFAULT_MAX_STACK = 50
DEFAULT_TIMEOUT = 20
OUTPUT_CAP_BYTES = 256 * 1024

# One JSON object per commit, built with jj's template language so we never
# parse human log output. Booleans are true/false literals; strings are
# JSON-escaped by jj (escape_json / json()). No trailing newline is needed:
# objects are concatenated and parsed sequentially with raw_decode.
STACK_TEMPLATE = r'''"" ++ "{\"change_id\":\"" ++ change_id.short() ++ "\",\"commit_id\":\"" ++ commit_id.short() ++ "\",\"subject\":" ++ description.first_line().escape_json() ++ ",\"empty\":" ++ if(empty, "true", "false") ++ ",\"conflict\":" ++ if(conflict, "true", "false") ++ ",\"divergent\":" ++ if(divergent, "true", "false") ++ ",\"merge\":" ++ if(parents.len() > 1, "true", "false") ++ ",\"bookmarks\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\"remote_bookmarks\":" ++ json(remote_bookmarks.map(|b| b.name())) ++ ",\"parents\":" ++ json(parents.map(|c| c.commit_id().short())) ++ "}"'''

BOOKMARK_TEMPLATE = r'self.name() ++ "\t" ++ self.normal_target().commit_id().short() ++ "\n"'


class InspectionError(Exception):
    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def run_jj(args: list[str], cwd: str, timeout: int) -> tuple[str, str, int]:
    try:
        proc = subprocess.run(
            ["jj", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
    except FileNotFoundError as exc:
        raise InspectionError("jj executable was not found on PATH.", 2) from exc
    except subprocess.TimeoutExpired as exc:
        raise InspectionError(f"jj timed out after {timeout}s.", 1) from exc
    return proc.stdout, proc.stderr, proc.returncode


def parse_version(text: str) -> tuple[int, int] | None:
    # "jj 0.44.0" -> (0, 44). Tolerate leading tokens.
    for token in text.strip().split():
        parts = token.split(".")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    return None


def require_jj(cwd: str, timeout: int) -> str:
    out, err, code = run_jj(["--version"], cwd, timeout)
    if code != 0:
        raise InspectionError(f"jj --version failed: {err.strip()}", 2)
    version = parse_version(out)
    if version is None:
        raise InspectionError(f"Could not parse jj version from: {out.strip()}", 2)
    if version < (MIN_JJ_MAJOR, MIN_JJ_MINOR):
        raise InspectionError(
            f"jj {version[0]}.{version[1]} is too old; need >= {MIN_JJ_MAJOR}.{MIN_JJ_MINOR}.",
            2,
        )
    return f"{version[0]}.{version[1]}"


def is_workspace(cwd: str, timeout: int) -> bool:
    _, _, code = run_jj(["workspace", "root"], cwd, timeout)
    return code == 0


def resolve_revset(cwd: str, revset: str, timeout: int) -> str | None:
    out, _, code = run_jj(
        ["log", "-r", revset, "--no-graph", "--no-pager", "-T", "commit_id.short()"],
        cwd, timeout,
    )
    if code != 0:
        return None
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1] if lines else None


def working_copy_change_id(cwd: str, timeout: int) -> str | None:
    out, _, code = run_jj(
        ["log", "-r", "@", "--no-graph", "--no-pager", "-T", "change_id.short()"],
        cwd, timeout,
    )
    if code != 0:
        return None
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1] if lines else None


def list_bookmarks(cwd: str, timeout: int) -> list[dict[str, Any]]:
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


def parse_concatenated_json(text: str) -> list[dict[str, Any]]:
    """Pull sequential JSON objects out of jj's concatenated template output."""
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    idx = 0
    length = len(text)
    while idx < length:
        # Skip whitespace and any non-JSON separator jj might emit.
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


def fetch_stack_commits(cwd: str, revset: str, timeout: int) -> list[dict[str, Any]]:
    # --reversed so output is base -> top (oldest first).
    out, err, code = run_jj(
        ["log", "-r", revset, "--reversed", "--no-graph", "--no-pager", "-T", STACK_TEMPLATE],
        cwd, timeout,
    )
    if code != 0:
        raise InspectionError(f"jj log failed: {err.strip() or out.strip()}", 1)
    return parse_concatenated_json(out)


def detect_blockers(
    commits: list[dict[str, Any]],
    trunk_commit: str,
    top_bookmark: str | None,
    wc_change: str | None,
) -> list[str]:
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


def detect_top_bookmark(commits: list[dict[str, Any]]) -> str | None:
    # Heuristic: the bookmark on the topmost (newest) commit that is not a
    # trunk-name bookmark. trunk() itself is excluded from the stack revset, so
    # any bookmark on the last commit is a candidate.
    if not commits:
        return None
    trunk_names = {"main", "master", "trunk"}
    for c in reversed(commits):
        for bm in c["bookmarks"]:
            if bm not in trunk_names:
                return bm
    for c in reversed(commits):
        if c["bookmarks"]:
            return c["bookmarks"][0]
    return None


def build_model(args: argparse.Namespace) -> dict[str, Any]:
    cwd = args.repo or os.getcwd()
    jj_version = require_jj(cwd, args.timeout)
    if not is_workspace(cwd, args.timeout):
        raise InspectionError(f"{cwd} is not a Jujutsu workspace.", 2)

    trunk_commit = resolve_revset(cwd, args.trunk, args.timeout)
    if not trunk_commit:
        raise InspectionError(
            f"Could not resolve trunk revset {args.trunk!r}. Ensure a main/master/trunk branch exists on a remote.",
            3,
        )

    bookmarks = list_bookmarks(cwd, args.timeout)
    top = args.top
    top_resolved: str | None = None
    if top:
        if not any(b["name"] == top for b in bookmarks):
            raise InspectionError(
                f"Bookmark {top!r} does not exist locally. Available: "
                f"{', '.join(sorted(b['name'] for b in bookmarks)) or '(none)'}.",
                3,
            )
        top_resolved = resolve_revset(cwd, top, args.timeout)
        if not top_resolved:
            raise InspectionError(f"Bookmark {top!r} could not be resolved to a commit.", 3)

    # First pass to infer the top bookmark if omitted.
    preliminary_revset = f"{args.trunk}..{top}" if top else f"{args.trunk}..@"
    preliminary = fetch_stack_commits(cwd, preliminary_revset, args.timeout)
    if not top:
        top = detect_top_bookmark(preliminary)
        if top:
            top_resolved = resolve_revset(cwd, top, args.timeout)
            # Refetch with the inferred top so the model covers exactly trunk()..top.
            commits = fetch_stack_commits(cwd, f"{args.trunk}..{top}", args.timeout)
        else:
            commits = preliminary
    else:
        commits = preliminary

    wc_change = working_copy_change_id(cwd, args.timeout)
    truncated = False
    if len(commits) > args.max_stack:
        truncated = True
        commits = commits[: args.max_stack]

    for c in commits:
        c["is_working_copy"] = c["change_id"] == wc_change

    blockers = detect_blockers(commits, trunk_commit, top, wc_change)

    return {
        "schemaVersion": 1,
        "jj_version": jj_version,
        "trunk": {"ref": args.trunk, "commit_id": trunk_commit},
        "top": top,
        "top_commit_id": top_resolved,
        "all_local_bookmarks": sorted(b["name"] for b in bookmarks),
        "stack_size": len(commits),
        "truncated": truncated,
        "max_stack": args.max_stack,
        "stack": commits,
        "blockers": blockers,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Inspect a jj bookmark stack (read-only).")
    parser.add_argument("--repo", default=None, help="Repository path (default: cwd).")
    parser.add_argument("--top", default=None, help="Top bookmark name (default: inferred).")
    parser.add_argument("--trunk", default="trunk()", help="Trunk revset (default: trunk()).")
    parser.add_argument("--max-stack", type=int, default=DEFAULT_MAX_STACK, help="Cap on commits emitted.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-jj-command timeout in seconds.")
    args = parser.parse_args(argv)

    try:
        model = build_model(args)
    except InspectionError as exc:
        print(json.dumps({"error": str(exc), "exit_code": exc.exit_code}))
        return exc.exit_code

    # Enforce the output cap at the model level so we always emit valid JSON.
    # Truncation slices trailing commits from the stack array (never the
    # serialized bytes, which could break mid-string/mid-array) and records
    # itself as a model field.
    text = json.dumps(model, indent=2)
    if len(text.encode("utf-8")) > OUTPUT_CAP_BYTES:
        model["output_truncated"] = True
        while len(json.dumps(model, indent=2).encode("utf-8")) > OUTPUT_CAP_BYTES and len(model["stack"]) > 0:
            model["stack"].pop()
        model["stack_size"] = len(model["stack"])
        if not model["blockers"]:
            model["blockers"].append("Output exceeded the cap; trailing commits were dropped from the model.")
        text = json.dumps(model, indent=2)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
