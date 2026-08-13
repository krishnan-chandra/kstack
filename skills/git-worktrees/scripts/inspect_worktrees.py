#!/usr/bin/env python3
"""Read-only, bounded inspection of kstack-managed Git worktrees."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_ROOT = Path.home() / ".pi" / "kstack" / "worktrees"
DEFAULT_TIMEOUT = 10
DEFAULT_MAX = 200
OUTPUT_CAP = 256 * 1024


def run_git(path: Path, args: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        timeout=timeout,
        shell=False,
    )


def text(proc: subprocess.CompletedProcess[bytes]) -> str:
    return proc.stdout.decode("utf-8", errors="replace").strip()


def parse_worktree_porcelain_z(data: bytes) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    for raw in data.split(b"\0"):
        if not raw:
            if current:
                records.append(current)
                current = {}
            continue
        line = raw.decode("utf-8", errors="surrogateescape")
        key, _, value = line.partition(" ")
        if key == "worktree" and current:
            records.append(current)
            current = {}
        if key in {"bare", "detached"}:
            current[key] = True
        elif key in {"locked", "prunable"}:
            current[key] = value or True
        else:
            current[key] = value
    if current:
        records.append(current)
    return records


def infer_base(path: Path, timeout: int) -> tuple[str | None, str | None]:
    remote_result = run_git(path, ["remote"], timeout)
    remotes = sorted(text(remote_result).splitlines()) if remote_result.returncode == 0 else []
    if "origin" in remotes:
        remotes.remove("origin")
        remotes.insert(0, "origin")
    candidates = []
    for remote in remotes or ["origin"]:
        symbolic = run_git(path, ["symbolic-ref", "--quiet", f"refs/remotes/{remote}/HEAD"], timeout)
        if symbolic.returncode == 0 and text(symbolic):
            candidates.append(text(symbolic))
    for remote in remotes or ["origin"]:
        candidates.extend([f"refs/remotes/{remote}/main", f"refs/remotes/{remote}/master"])
    candidates.extend(["refs/heads/main", "refs/heads/master"])
    for ref in dict.fromkeys(candidates):
        resolved = run_git(path, ["rev-parse", "--verify", f"{ref}^{{commit}}"], timeout)
        sha = text(resolved)
        if resolved.returncode == 0 and len(sha) == 40:
            return ref, sha
    return None, None


def inspect(path: Path, timeout: int) -> dict[str, Any] | None:
    top = run_git(path, ["rev-parse", "--show-toplevel"], timeout)
    if top.returncode != 0:
        return None
    common = run_git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeout)
    branch = run_git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeout)
    head = run_git(path, ["rev-parse", "--verify", "HEAD"], timeout)
    status = run_git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout)
    listing = run_git(path, ["worktree", "list", "--porcelain", "-z"], timeout)
    canonical = str(path.resolve())
    authoritative = next(
        (r for r in parse_worktree_porcelain_z(listing.stdout) if os.path.realpath(str(r.get("worktree", ""))) == canonical),
        {},
    )
    entries = [entry for entry in status.stdout.split(b"\0") if entry]
    untracked = sum(1 for entry in entries if entry.startswith(b"??"))
    base_ref, base_sha = infer_base(path, timeout)
    reachable: bool | None = None
    if base_ref:
        merged = run_git(path, ["merge-base", "--is-ancestor", "HEAD", base_ref], timeout)
        reachable = merged.returncode == 0
    return {
        "repository_id": path.parent.name,
        "path": canonical,
        "common_git_dir": os.path.realpath(text(common)) if common.returncode == 0 else None,
        "branch": text(branch) if branch.returncode == 0 else None,
        "detached": branch.returncode != 0,
        "head": text(head) if head.returncode == 0 else None,
        "dirty": bool(entries),
        "status_entries": len(entries),
        "untracked_entries": untracked,
        "locked": authoritative.get("locked", False),
        "prunable": authoritative.get("prunable", False),
        "base_ref": base_ref,
        "base_sha": base_sha,
        "head_reachable_from_base": reachable,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--max", type=int, default=DEFAULT_MAX, dest="maximum")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args()
    if args.maximum < 1 or args.maximum > 1000:
        parser.error("--max must be between 1 and 1000")
    if args.timeout < 1 or args.timeout > 60:
        parser.error("--timeout must be between 1 and 60")

    root = Path(args.root).expanduser().resolve()
    candidates: list[Path] = []
    if root.is_dir():
        for repo_dir in sorted(root.iterdir()):
            if not repo_dir.is_dir():
                continue
            for child in sorted(repo_dir.iterdir()):
                if child.is_dir() or child.is_symlink():
                    candidates.append(child)

    truncated = len(candidates) > args.maximum
    worktrees: list[dict[str, Any]] = []
    orphans: list[dict[str, str]] = []
    for candidate in candidates[: args.maximum]:
        if candidate.is_symlink():
            orphans.append({"path": str(candidate), "reason": "symlink entries are not treated as managed worktrees"})
            continue
        try:
            candidate.resolve().relative_to(root)
        except (OSError, ValueError):
            orphans.append({"path": str(candidate), "reason": "path escapes the managed root"})
            continue
        try:
            item = inspect(candidate, args.timeout)
        except (subprocess.TimeoutExpired, OSError) as exc:
            orphans.append({"path": str(candidate), "reason": str(exc)})
            continue
        if item is None:
            orphans.append({"path": str(candidate), "reason": "not a resolvable Git working tree"})
        else:
            worktrees.append(item)

    payload = {
        "managed_root": str(root),
        "worktrees": worktrees,
        "orphans": orphans,
        "truncated": truncated,
        "candidate_count": len(candidates),
    }
    encoded = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
    if len(encoded) > OUTPUT_CAP:
        print(json.dumps({
            "error": f"inspection output exceeded {OUTPUT_CAP} bytes",
            "managed_root": str(root),
            "candidate_count": len(candidates),
            "truncated": True,
        }))
        return 1
    sys.stdout.buffer.write(encoded + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
