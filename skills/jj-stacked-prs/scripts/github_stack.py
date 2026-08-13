"""GitHub remote parsing, read-only planning, PR/comment models, and mutation execution.

GitHub operations use the authenticated ``gh`` CLI — never raw HTTP or SDK
dependencies. Credentials are owned by ``gh`` and are never extracted, logged,
or embedded in arguments. The ``plan`` mode is strictly read-only (GET only).
Mutation only happens in ``apply`` mode under explicit confirmation.

Important contracts:
- ``gh api`` calls are bounded by timeout and output caps.
- Plan actions are deterministic: same local + remote state => same plan ID.
- Existing PR metadata / draft state is preserved during base repair.
- Navigation comments use a versioned kstack-owned marker.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, NamedTuple

from stack_model import StackError, run_gh

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KSTACK_COMMENT_MARKER = "<!-- kstack-stack-nav -->"
KSTACK_COMMENT_SCHEMA_VERSION = 1
GH_API_TIMEOUT = 30


class GitHubRepo(NamedTuple):
    """Parsed GitHub repository identifier."""

    owner: str
    repo: str


class RemoteInfo(NamedTuple):
    """Resolved information about a Git remote."""

    name: str
    url: str
    github_repo: GitHubRepo | None  # None if not a GitHub URL


class PRInfo(NamedTuple):
    """Existing open PR from ``gh pr list``."""

    number: int
    head_ref: str  # The bookmark/branch name, without remote prefix
    base_ref: str
    title: str
    is_draft: bool
    url: str
    head_owner: str  # Repository owner of the head branch


class SliceAction(NamedTuple):
    """One actionable mutation for a PR slice."""

    bookmark: str
    pr_number: int | None  # None when no PR exists yet
    push_required: bool
    create_pr: bool
    update_base: bool
    current_base: str | None
    target_base: str


class StackPlan(NamedTuple):
    """Complete publication plan."""

    plan_id: str
    repo_info: dict[str, Any]
    remote: str
    default_branch: str
    slices: list[SliceAction]
    comment_actions: list[dict[str, Any]]
    blockers: list[str]


# ---------------------------------------------------------------------------
# Remote / repo identification
# ---------------------------------------------------------------------------

GITHUB_URL_PATTERN = re.compile(
    r"(?:https://(?:[^@]+@)?github\.com/|git@github\.com:|ssh://(?:[^@]+@)?github\.com/)([^/]+)/([^/]+?)(?:\.git)?$"
)


def parse_github_url(url: str) -> GitHubRepo | None:
    """Extract owner/repo from an HTTPS or SSH GitHub URL.

    >>> parse_github_url("https://github.com/owner/repo.git")
    GitHubRepo(owner='owner', repo='repo')
    >>> parse_github_url("git@github.com:owner/repo")
    GitHubRepo(owner='owner', repo='repo')
    >>> parse_github_url("https://x-access-token:SECRET@github.com/owner/repo")
    GitHubRepo(owner='owner', repo='repo')
    >>> parse_github_url("ssh://git@github.com/owner/repo.js.git")
    GitHubRepo(owner='owner', repo='repo.js')
    >>> parse_github_url("https://gitlab.com/owner/repo") is None
    True
    """
    m = GITHUB_URL_PATTERN.match(url.strip())
    if m:
        return GitHubRepo(owner=m.group(1), repo=m.group(2))
    return None


def redact_url(url: str) -> str:
    """Redact credentials from a URL for safe display.

    >>> redact_url("https://x-access-token:SECRET@github.com/owner/repo")
    'https://***@github.com/owner/repo'
    >>> redact_url("https://github.com/owner/repo")
    'https://github.com/owner/repo'
    """
    return re.sub(r"(https?://)[^@]+@", r"\1***@", url)


def get_remote_info(cwd: str, remote_name: str, timeout: int = GH_API_TIMEOUT) -> RemoteInfo:
    """Resolve *remote_name* to its URL and GitHub repo (if applicable).

    Raises ``StackError`` if the remote does not exist or cannot be read.
    """
    from stack_model import run_cmd

    result = run_cmd(
        ["git", "remote", "get-url", remote_name],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Remote {remote_name!r} does not exist. "
            f"Available: {', '.join(_list_remotes(cwd, timeout)) or '(none)'}.",
            1,
        )
    url = result.stdout.strip()
    gh_repo = parse_github_url(url)
    return RemoteInfo(name=remote_name, url=url, github_repo=gh_repo)


def _list_remotes(cwd: str, timeout: int = GH_API_TIMEOUT) -> list[str]:
    from stack_model import run_cmd

    result = run_cmd(["git", "remote"], cwd=cwd, timeout=timeout)
    if result.returncode != 0:
        return []
    return [r.strip() for r in result.stdout.splitlines() if r.strip()]


def get_default_branch(
    gh_repo: GitHubRepo,
    cwd: str,
    timeout: int = GH_API_TIMEOUT,
) -> str:
    """Read the repository's default branch via ``gh api``."""
    result = run_gh(
        ["api", f"/repos/{gh_repo.owner}/{gh_repo.repo}", "--jq", ".default_branch"],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Could not read default branch for {gh_repo.owner}/{gh_repo.repo}: "
            f"{result.stderr.strip() or result.stdout.strip()}",
            1,
        )
    return result.stdout.strip()


# ---------------------------------------------------------------------------
# Open PR queries
# ---------------------------------------------------------------------------

def list_open_prs(
    gh_repo: GitHubRepo,
    cwd: str,
    timeout: int = GH_API_TIMEOUT,
) -> list[PRInfo]:
    """List every open PR for the repo through paginated ``gh api`` GETs."""
    result = run_gh(
        [
            "api",
            "--method", "GET",
            f"/repos/{gh_repo.owner}/{gh_repo.repo}/pulls",
            "--field", "state=open",
            "--field", "per_page=100",
            "--paginate",
            "--jq",
            ".[] | {number, headRefName: .head.ref, baseRefName: .base.ref, "
            "title, isDraft: .draft, url: .html_url, "
            "headRepository: {nameWithOwner: .head.repo.full_name}, "
            "headRepositoryOwner: {login: .head.repo.owner.login}}",
        ],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Could not list open PRs: {result.stderr.strip() or result.stdout.strip()}",
            1,
        )

    items: list[dict[str, Any]] = []
    text = result.stdout.strip()
    if text:
        decoder = json.JSONDecoder()
        offset = 0
        try:
            while offset < len(text):
                while offset < len(text) and text[offset].isspace():
                    offset += 1
                if offset >= len(text):
                    break
                parsed, offset = decoder.raw_decode(text, offset)
                values = parsed if isinstance(parsed, list) else [parsed]
                if not all(isinstance(value, dict) for value in values):
                    raise StackError("Could not parse open-PR response: expected JSON objects.", 1)
                items.extend(values)
        except json.JSONDecodeError as exc:
            raise StackError(f"Could not parse open-PR response: {exc}", 1) from exc

    prs: list[PRInfo] = []
    expected_repo = f"{gh_repo.owner}/{gh_repo.repo}".casefold()
    for item in items:
        # Deleted forks have null head repository and owner values. Ignore those
        # unrelated PRs rather than aborting publication for the whole repository.
        head_repository = item.get("headRepository") or {}
        head_repository_owner = item.get("headRepositoryOwner") or {}
        if not isinstance(head_repository, dict):
            continue
        if not isinstance(head_repository_owner, dict):
            head_repository_owner = {}
        name_with_owner = head_repository.get("nameWithOwner") or ""
        if not isinstance(name_with_owner, str) or name_with_owner.casefold() != expected_repo:
            continue
        owner_login = head_repository_owner.get("login") or ""
        prs.append(PRInfo(
            number=item["number"],
            head_ref=item["headRefName"],
            base_ref=item["baseRefName"],
            title=item.get("title", "") or "",
            is_draft=bool(item.get("isDraft", False)),
            url=item.get("url", "") or "",
            head_owner=owner_login if isinstance(owner_login, str) else "",
        ))
    return prs


def find_pr_for_bookmark(
    prs: list[PRInfo],
    bookmark: str,
) -> PRInfo | None:
    """Find an open PR whose head ref matches the bookmark name."""
    matches = [pr for pr in prs if pr.head_ref == bookmark]
    return matches[0] if len(matches) == 1 else None


# ---------------------------------------------------------------------------
# Navigation comments
# ---------------------------------------------------------------------------

def build_navigation_comment(
    stack_slices: list[SliceAction],
    repo_info: GitHubRepo,
    default_branch: str,
) -> str:
    """Build a stack-navigation comment body.

    Uses a versioned kstack-owned hidden marker for identification. The body
    is intentionally simple Markdown with PR-number references.
    """
    lines = [
        KSTACK_COMMENT_MARKER,
        f"<!-- kstack-stack-schema-v{KSTACK_COMMENT_SCHEMA_VERSION} -->",
        "",
        "## Stack navigation (kstack)",
        "",
        "| PR | Bookmark | Base |",
        "|---|---|---|",
    ]
    for slc in stack_slices:
        pr_ref = f"#{slc.pr_number}" if slc.pr_number else "—"
        base_ref = slc.target_base if slc.target_base != default_branch else default_branch
        lines.append(f"| {pr_ref} | `{slc.bookmark}` | `{base_ref}` |")

    lines.extend([
        "",
        "_Navigated by kstack. Update with `publish_stack.py apply`._",
    ])
    return "\n".join(lines)


def get_gh_user(cwd: str, timeout: int = GH_API_TIMEOUT) -> str:
    """Get the authenticated GitHub user's login."""
    result = run_gh(["api", "user", "--jq", ".login"], cwd=cwd, timeout=timeout)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def find_kstack_comment(comments: list[dict[str, Any]], gh_user: str | None = None) -> dict[str, Any] | None:
    """Find an existing kstack navigation comment in a list of issue comments.

    *comments* should be the parsed JSON body from ``gh api /repos/.../issues/{n}/comments``.
    When *gh_user* is provided, only comments authored by that user are considered.
    Returns the first matching comment, or ``None``.
    """
    for comment in comments:
        body = comment.get("body", "") or ""
        if KSTACK_COMMENT_MARKER not in body:
            continue
        if gh_user is not None and comment.get("user") != gh_user:
            continue
        metadata = parse_comment_metadata(body)
        if metadata is None or metadata.get("schema_version") not in (0, KSTACK_COMMENT_SCHEMA_VERSION):
            continue
        return comment
    return None


def parse_comment_metadata(body: str) -> dict[str, Any] | None:
    """Extract metadata from a kstack comment body.

    Returns a dict with ``schema_version`` etc., or ``None`` if the comment
    is not a valid kstack comment.
    """
    if KSTACK_COMMENT_MARKER not in body:
        return None
    m = re.search(r"kstack-stack-schema-v(\d+)", body)
    return {"schema_version": int(m.group(1))} if m else {"schema_version": 0}


# ---------------------------------------------------------------------------
# Plan computation
# ---------------------------------------------------------------------------

def compute_plan_id(
    repo_key: str,
    default_branch: str,
    slices_state: list[dict[str, Any]],
) -> str:
    """Deterministic plan ID from the actionable state.

    The ID is a SHA-256 hex digest of the canonical JSON representation of
    the state inputs. Same inputs = same plan ID.
    """
    canonical = json.dumps(
        {"repo": repo_key, "default_branch": default_branch, "slices_state": slices_state},
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def compute_slice_state(
    bookmark: str,
    local_commit_id: str | None,
    remote_commit_id: str | None,
    existing_pr: PRInfo | None,
    target_base: str,
) -> dict[str, Any]:
    """One entry in the slices_state list for plan ID computation."""
    return {
        "bookmark": bookmark,
        "local_commit_id": local_commit_id,
        "remote_commit_id": remote_commit_id,
        "existing_pr_number": existing_pr.number if existing_pr else None,
        "existing_pr_base": existing_pr.base_ref if existing_pr else None,
        "target_base": target_base,
    }


def build_plan(
    cwd: str,
    remote_name: str,
    gh_repo: GitHubRepo,
    default_branch: str,
    slices: list[Any],  # List of Slice from stack_model
    local_bookmarks: list[dict[str, Any]],
    remote_bookmarks: list[dict[str, Any]],
    open_prs: list[PRInfo],
    existing_comments: list[dict[str, Any]] | None = None,
) -> StackPlan:
    """Build a full publication plan from local state and GitHub state.

    This is strictly read-only: no POST/PATCH/DELETE calls are made.
    """
    repo_key = f"{gh_repo.owner}/{gh_repo.repo}"

    slice_actions: list[SliceAction] = []
    slices_state: list[dict[str, Any]] = []
    blockers: list[str] = []
    last_bookmark: str | None = None

    for i, slc in enumerate(slices):
        target_base = last_bookmark if last_bookmark else default_branch

        local_matches = [b["commit_id"] for b in local_bookmarks if b["name"] == slc.bookmark]
        remote_matches = [b["commit_id"] for b in remote_bookmarks if b["name"] == slc.bookmark]
        if len(local_matches) != 1:
            blockers.append(
                f"Bookmark {slc.bookmark!r} did not resolve to exactly one local target."
            )
        if len(remote_matches) > 1:
            blockers.append(
                f"Bookmark {slc.bookmark!r} is conflicted on remote {remote_name!r}."
            )
        local_commit = local_matches[0] if len(local_matches) == 1 else None
        remote_commit = remote_matches[0] if len(remote_matches) == 1 else None

        # Find one unambiguous matching PR.
        matching_prs = [pr for pr in open_prs if pr.head_ref == slc.bookmark]
        if len(matching_prs) > 1:
            blockers.append(
                f"Multiple open PRs use bookmark {slc.bookmark!r}; refusing an ambiguous update."
            )
        existing_pr = matching_prs[0] if len(matching_prs) == 1 else None

        # Determine what's needed
        push_required = local_commit != remote_commit
        create_pr = existing_pr is None
        update_base = False
        current_base = existing_pr.base_ref if existing_pr else None

        if existing_pr:
            # PR exists: update base if it changed
            if existing_pr.base_ref and existing_pr.base_ref != target_base:
                update_base = True

        slice_actions.append(SliceAction(
            bookmark=slc.bookmark,
            pr_number=existing_pr.number if existing_pr else None,
            push_required=push_required,
            create_pr=create_pr,
            update_base=update_base,
            current_base=current_base,
            target_base=target_base,
        ))
        # Reuse the exact resolution that produced the action. Re-resolving with
        # first-match semantics could make a blocked divergent bookmark hash a
        # different target than the action itself.
        slices_state.append(compute_slice_state(
            bookmark=slc.bookmark,
            local_commit_id=local_commit,
            remote_commit_id=remote_commit,
            existing_pr=existing_pr,
            target_base=target_base,
        ))
        last_bookmark = slc.bookmark

    plan_id = compute_plan_id(repo_key, default_branch, slices_state)

    # Comment actions: include ALL slices so the publisher can populate
    # newly created PR numbers before posting comments.
    comment_actions: list[dict[str, Any]] = []
    for i, (slc, action) in enumerate(zip(slices, slice_actions)):
        comment_actions.append({
            "pr_number": action.pr_number,  # None for slices without an existing PR
            "action": "create_or_update",
            "body_template": "navigation",
            "bookmark": action.bookmark,
        })

    if not gh_repo:
        blockers.append(f"Remote {remote_name!r} is not a GitHub repository.")

    return StackPlan(
        plan_id=plan_id,
        repo_info={"owner": gh_repo.owner, "repo": gh_repo.repo, "default_branch": default_branch},
        remote=remote_name,
        default_branch=default_branch,
        slices=slice_actions,
        comment_actions=comment_actions,
        blockers=blockers,
    )


# ---------------------------------------------------------------------------
# Mutation execution
# ---------------------------------------------------------------------------

def push_bookmark(
    cwd: str,
    remote: str,
    bookmark: str,
    timeout: int = GH_API_TIMEOUT,
) -> None:
    """Push a single bookmark to the remote via ``jj git push``.

    Raises ``StackError`` on failure.
    """
    from stack_model import run_jj

    # On the supported jj >= 0.44, --bookmark automatically tracks a new
    # remote bookmark and rewrites use jj's force-with-lease safety checks.
    # There is no raw force push and --allow-new is not a 0.44 option.
    result = run_jj(
        ["git", "push", "--remote", remote, "--bookmark", bookmark],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Failed to push bookmark {bookmark!r} to remote {remote!r}: "
            f"{result.stderr.strip() or result.stdout.strip()}",
            1,
        )


def create_pr(
    gh_repo: GitHubRepo,
    bookmark: str,
    base: str,
    title: str,
    cwd: str,
    timeout: int = GH_API_TIMEOUT,
) -> PRInfo:
    """Create a draft PR for *bookmark* via ``gh pr create``.

    Returns the created PR's info.
    """
    result = run_gh(
        [
            "pr", "create",
            "--repo", f"{gh_repo.owner}/{gh_repo.repo}",
            "--head", bookmark,
            "--base", base,
            "--title", title,
            "--body", f"Stacked PR for bookmark `{bookmark}`.",
            "--draft",
        ],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Failed to create PR for bookmark {bookmark!r}: "
            f"{result.stderr.strip() or result.stdout.strip()}",
            1,
        )
    # gh pr create outputs the PR URL on stdout
    pr_url = result.stdout.strip()
    # Re-fetch the PR info to get the number
    pr_num_result = run_gh(
        ["pr", "view", pr_url, "--json", "number,headRefName,baseRefName,title,isDraft,url"],
        cwd=cwd,
        timeout=timeout,
    )
    if pr_num_result.returncode == 0:
        try:
            info = json.loads(pr_num_result.stdout)
            return PRInfo(
                number=info["number"],
                head_ref=info["headRefName"],
                base_ref=info["baseRefName"],
                title=info.get("title", ""),
                is_draft=info.get("isDraft", False),
                url=info.get("url", pr_url),
                head_owner=gh_repo.owner,
            )
        except (json.JSONDecodeError, KeyError):
            pass
    # The PR was created, but continuing without its number would send later
    # reconciliation requests to PR #0. Stop and let a fresh plan discover it.
    raise StackError(
        f"Created PR for bookmark {bookmark!r} at {pr_url!r}, but could not read its metadata. "
        "Run plan again to continue safely.",
        1,
    )


def update_pr_base(
    gh_repo: GitHubRepo,
    pr_number: int,
    new_base: str,
    cwd: str,
    timeout: int = GH_API_TIMEOUT,
) -> None:
    """Update an existing PR's base branch via ``gh api`` PATCH."""
    result = run_gh(
        [
            "api",
            f"/repos/{gh_repo.owner}/{gh_repo.repo}/pulls/{pr_number}",
            "--method", "PATCH",
            "--field", f"base={new_base}",
        ],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise StackError(
            f"Failed to update base for PR #{pr_number}: "
            f"{result.stderr.strip() or result.stdout.strip()}",
            1,
        )


def create_or_update_comment(
    gh_repo: GitHubRepo,
    pr_number: int,
    body: str,
    cwd: str,
    existing_comment_id: int | None = None,
    timeout: int = GH_API_TIMEOUT,
) -> dict[str, Any]:
    """Create or update a comment on a PR. Returns the comment info."""
    if existing_comment_id is not None:
        # Update existing comment
        result = run_gh(
            [
                "api",
                f"/repos/{gh_repo.owner}/{gh_repo.repo}/issues/comments/{existing_comment_id}",
                "--method", "PATCH",
                "--field", f"body={body}",
            ],
            cwd=cwd,
            timeout=timeout,
        )
    else:
        # Create new comment
        result = run_gh(
            [
                "api",
                f"/repos/{gh_repo.owner}/{gh_repo.repo}/issues/{pr_number}/comments",
                "--method", "POST",
                "--field", f"body={body}",
            ],
            cwd=cwd,
            timeout=timeout,
        )
    if result.returncode != 0:
        raise StackError(
            f"Failed to {'update' if existing_comment_id else 'create'} comment on PR #{pr_number}: "
            f"{result.stderr.strip() or result.stdout.strip()}",
            1,
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"id": existing_comment_id or 0, "body_preview": body[:100]}


def get_pr_comments(
    gh_repo: GitHubRepo,
    pr_number: int,
    cwd: str,
    timeout: int = GH_API_TIMEOUT,
) -> list[dict[str, Any]]:
    """Fetch all comments on a PR via ``gh api``."""
    result = run_gh(
        [
            "api",
            f"/repos/{gh_repo.owner}/{gh_repo.repo}/issues/{pr_number}/comments",
            "--jq", ".[] | {id, body, user: .user.login}",
            "--paginate",
        ],
        cwd=cwd,
        timeout=timeout,
    )
    if result.returncode != 0:
        return []
    comments: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            comments.append(json.loads(line))
        except json.JSONDecodeError:
            # Some lines may not be individual JSON objects with --paginate
            pass
    if not comments and result.stdout.strip().startswith("["):
        try:
            comments = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    return comments


# ---------------------------------------------------------------------------
# Structured result helpers
# ---------------------------------------------------------------------------

def build_plan_json(plan: StackPlan) -> dict[str, Any]:
    """Convert a StackPlan to a JSON-serializable dict."""
    return {
        "plan_id": plan.plan_id,
        "repo": plan.repo_info,
        "remote": plan.remote,
        "default_branch": plan.default_branch,
        "slices": [
            {
                "bookmark": s.bookmark,
                "pr_number": s.pr_number,
                "push_required": s.push_required,
                "create_pr": s.create_pr,
                "update_base": s.update_base,
                "current_base": s.current_base,
                "target_base": s.target_base,
            }
            for s in plan.slices
        ],
        "comment_actions": plan.comment_actions,
        "blockers": plan.blockers,
    }


def build_apply_result_json(
    completed_actions: list[dict[str, Any]],
    failed_action: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the JSON result for a completed ``apply`` run."""
    result: dict[str, Any] = {
        "status": "completed" if failed_action is None else "partial",
        "completed_actions": completed_actions,
    }
    if failed_action:
        result["failed_action"] = failed_action
        result["error"] = f"Failed at action: {failed_action.get('action', 'unknown')} on {failed_action.get('bookmark', '?')}"
    return result