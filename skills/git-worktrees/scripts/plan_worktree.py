#!/usr/bin/env python3
"""Read-only plan for one kstack-managed Git worktree."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

DEFAULT_ROOT = Path.home() / ".pi" / "kstack" / "worktrees"
MAX_SLUG = 48
MAX_ATTEMPTS = 100
TIMEOUT = 10


def git(cwd: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        shell=False,
    )


def output(cwd: Path, args: list[str]) -> str | None:
    result = git(cwd, args)
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


def slugify(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")[:MAX_SLUG].rstrip("-")
    return slug or "change"


def resolve_base(repo: Path) -> tuple[str, str] | None:
    remote_text = output(repo, ["remote"]) or ""
    remotes = sorted(filter(None, remote_text.splitlines()))
    if "origin" in remotes:
        remotes.remove("origin")
        remotes.insert(0, "origin")
    probes = remotes or ["origin"]
    candidates: list[str] = []
    for remote in probes:
        head = output(repo, ["symbolic-ref", "--quiet", f"refs/remotes/{remote}/HEAD"])
        if head:
            candidates.append(head)
    for remote in probes:
        candidates.extend([f"refs/remotes/{remote}/main", f"refs/remotes/{remote}/master"])
    candidates.extend(["refs/heads/main", "refs/heads/master", "HEAD"])
    for ref in dict.fromkeys(candidates):
        sha = output(repo, ["rev-parse", "--verify", f"{ref}^{{commit}}"])
        if sha and re.fullmatch(r"[0-9a-f]{40}", sha):
            return ref, sha
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--task", required=True)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    args = parser.parse_args()

    start = Path(args.repo).expanduser().resolve()
    repo_text = output(start, ["rev-parse", "--show-toplevel"])
    if not repo_text:
        print(json.dumps({"error": "not a Git working tree"}))
        return 2
    repo = Path(repo_text).resolve()
    common_text = output(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if not common_text:
        print(json.dumps({"error": "could not resolve the common Git directory"}))
        return 2
    common = Path(common_text).resolve()
    base = resolve_base(repo)
    if not base:
        print(json.dumps({"error": "could not resolve a default base commit"}))
        return 3

    root = Path(args.root).expanduser().resolve()
    repo_name = slugify(repo.name)
    repo_hash = hashlib.sha256(str(common).encode()).hexdigest()[:8]
    repository_id = f"{repo_name}-{repo_hash}"
    base_slug = slugify(args.task)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        suffix = "" if attempt == 1 else f"-{attempt}"
        slug = f"{base_slug[: MAX_SLUG - len(suffix)]}{suffix}"
        branch = f"kstack/{slug}"
        destination = root / repository_id / slug
        branch_exists = git(repo, ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]).returncode == 0
        if not branch_exists and not destination.exists() and not destination.is_symlink():
            ref, sha = base
            print(json.dumps({
                "source_repo_root": str(repo),
                "common_git_dir": str(common),
                "managed_root": str(root),
                "repository_id": repository_id,
                "slug": slug,
                "branch": branch,
                "path": str(destination),
                "base_ref": ref,
                "base_sha": sha,
            }, indent=2, sort_keys=True))
            return 0
    print(json.dumps({"error": f"no unique path after {MAX_ATTEMPTS} attempts"}))
    return 4


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)
