#!/usr/bin/env python3
"""Plan and apply stacked PR publication using local jj bookmarks and the GitHub CLI.

Usage:
    publish_stack.py plan  --repo <path> --top <bookmark> --remote <name>
                      [--trunk <revset>] [--max-stack <n>] [--timeout <secs>]
    publish_stack.py apply --repo <path> --top <bookmark> --remote <name>
                      --plan-id <id>
                      [--trunk <revset>] [--timeout <secs>]

``plan`` is strictly read-only: it inspects local and selected-remote bookmark
state plus GitHub state using read-only ``jj``, ``git``, and ``gh`` queries, then
returns a structured JSON plan with a deterministic ``plan_id``.

``apply`` re-computes the same state, verifies the ``plan_id`` matches, then
executes pushes, PR creation, base updates, and navigation comments in
base-to-top order. It refuses all mutation if the plan ID is stale.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from stack_model import (
    DEFAULT_MAX_STACK,
    DEFAULT_TIMEOUT,
    StackError,
    build_inspect_model,
    derive_slices,
    list_bookmarks,
    list_remote_bookmarks,
)
from github_stack import (
    build_navigation_comment,
    build_plan,
    build_apply_result_json,
    build_plan_json,
    create_or_update_comment,
    create_pr,
    find_kstack_comment,
    get_default_branch,
    get_gh_user,
    get_pr_comments,
    get_remote_info,
    list_open_prs,
    push_bookmark,
    redact_url,
    update_pr_base,
)


def cmd_plan(args: argparse.Namespace) -> dict[str, Any]:
    """Execute the read-only ``plan`` subcommand.

    Returns a JSON-serializable dict with the plan (never mutates state).
    """
    cwd = args.repo or os.getcwd()

    # Build the local stack model
    model = build_inspect_model(
        cwd=cwd,
        trunk_revset=args.trunk,
        top=args.top,
        max_stack=args.max_stack,
        timeout=args.timeout,
    )

    # Validate the stack is ready for publication
    blockers = list(model.get("blockers", []))
    if model.get("truncated", False):
        blockers.append("The stack is truncated; publish refused on incomplete data.")
    if model.get("top") is None:
        blockers.append("No top bookmark could be inferred. Specify --top explicitly.")

    if blockers:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": blockers,
            "model": model,
        }

    top_bookmark = model["top"]
    assert top_bookmark is not None

    # Derive PR slices from the bookmark stack. Publication must prove that
    # the selected top is the final boundary; partial parser output or a
    # mismatched stack must not silently publish only a prefix.
    slices = derive_slices(model["stack"], top_bookmark)
    if not slices or slices[-1].bookmark != top_bookmark:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [f"Selected top bookmark {top_bookmark!r} is not the final PR boundary."],
            "model": model,
        }

    # Get remote info
    remote_info = get_remote_info(cwd, args.remote, args.timeout)
    if remote_info.github_repo is None:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [f"Remote {args.remote!r} is not a GitHub repository: {redact_url(remote_info.url)}"],
            "model": model,
        }

    gh_repo = remote_info.github_repo

    # Get default branch
    try:
        default_branch = get_default_branch(gh_repo, cwd, args.timeout)
    except StackError as exc:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [str(exc)],
            "model": model,
        }

    # Get open PRs (read-only)
    try:
        open_prs = list_open_prs(gh_repo, cwd, args.timeout)
    except StackError as exc:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [str(exc)],
            "model": model,
        }

    # Get local and selected-remote bookmark targets for exact push planning.
    bookmarks_list = list_bookmarks(cwd, args.timeout)
    remote_bookmarks = list_remote_bookmarks(cwd, args.remote, args.timeout)

    # Build plan (no mutations)
    plan = build_plan(
        cwd=cwd,
        remote_name=args.remote,
        gh_repo=gh_repo,
        default_branch=default_branch,
        slices=slices,
        local_bookmarks=bookmarks_list,
        remote_bookmarks=remote_bookmarks,
        open_prs=open_prs,
    )

    if plan.blockers:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": plan.blockers,
            "model": model,
        }

    return {
        "status": "ok",
        "plan_id": plan.plan_id,
        "plan": build_plan_json(plan),
        "model": model,
    }


def cmd_apply(args: argparse.Namespace) -> dict[str, Any]:
    """Execute the ``apply`` subcommand with guarded mutation.

    Re-computes the plan state and verifies the plan ID before any mutation.
    """
    cwd = args.repo or os.getcwd()

    # Rebuild the local state (same as plan)
    model = build_inspect_model(
        cwd=cwd,
        trunk_revset=args.trunk,
        top=args.top,
        max_stack=args.max_stack,
        timeout=args.timeout,
    )

    blockers = list(model.get("blockers", []))
    if model.get("truncated", False):
        blockers.append("The stack is truncated; publish refused on incomplete data.")
    if model.get("top") is None:
        blockers.append("No top bookmark could be inferred. Specify --top explicitly.")

    if blockers:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": blockers,
            "recomputed_model": model,
        }

    top_bookmark = model["top"]
    assert top_bookmark is not None

    slices = derive_slices(model["stack"], top_bookmark)
    if not slices or slices[-1].bookmark != top_bookmark:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [f"Selected top bookmark {top_bookmark!r} is not the final PR boundary."],
            "recomputed_model": model,
        }
    remote_info = get_remote_info(cwd, args.remote, args.timeout)
    if remote_info.github_repo is None:
        return {
            "status": "blocked",
            "plan_id": None,
            "blockers": [f"Remote {args.remote!r} is not a GitHub repository."],
            "recomputed_model": model,
        }

    gh_repo = remote_info.github_repo
    default_branch = get_default_branch(gh_repo, cwd, args.timeout)
    open_prs = list_open_prs(gh_repo, cwd, args.timeout)
    bookmarks_list = list_bookmarks(cwd, args.timeout)
    remote_bookmarks = list_remote_bookmarks(cwd, args.remote, args.timeout)

    plan = build_plan(
        cwd=cwd,
        remote_name=args.remote,
        gh_repo=gh_repo,
        default_branch=default_branch,
        slices=slices,
        local_bookmarks=bookmarks_list,
        remote_bookmarks=remote_bookmarks,
        open_prs=open_prs,
    )

    # Stale-plan detection
    if plan.plan_id != args.plan_id:
        recomputed = build_plan_json(plan)
        return {
            "status": "stale_plan",
            "provided_plan_id": args.plan_id,
            "recomputed_plan_id": plan.plan_id,
            "recomputed_plan": recomputed,
            "error": (
                f"Plan ID mismatch: provided {args.plan_id!r} != recomputed {plan.plan_id!r}."
            ),
        }

    if plan.blockers:
        return {
            "status": "blocked",
            "plan_id": plan.plan_id,
            "blockers": plan.blockers,
        }

    # --- Execute mutations base-to-top ---
    completed_actions: list[dict[str, Any]] = []
    failed_action: dict[str, Any] | None = None
    # Keep mutable publication state for comments: newly created PR numbers are
    # not present in the read-only plan's immutable SliceAction values.
    comment_actions = [dict(action) for action in plan.comment_actions]
    published_slices = list(plan.slices)

    for i, (slc, action) in enumerate(zip(slices, plan.slices)):
        current_action = "push_bookmark"
        try:
            # 1. Push bookmark
            if action.push_required:
                push_bookmark(cwd, args.remote, action.bookmark, args.timeout)
                completed_actions.append({
                    "action": "push_bookmark",
                    "bookmark": action.bookmark,
                    "status": "ok",
                })

            # 2. Create PR if needed
            pr_number = action.pr_number
            if action.create_pr:
                current_action = "create_pr"
                # Use the slice subject as provisional title
                title = slc.subject or action.bookmark
                # Target base: use the short form (without refs/heads/)
                target_base = action.target_base.replace("refs/heads/", "")
                new_pr = create_pr(gh_repo, action.bookmark, target_base, title, cwd, args.timeout)
                pr_number = new_pr.number
                published_slices[i] = action._replace(pr_number=pr_number)
                # Update the matching comment action entry so it is not skipped
                for ca in comment_actions:
                    if ca.get("bookmark") == action.bookmark:
                        ca["pr_number"] = pr_number
                        break
                completed_actions.append({
                    "action": "create_pr",
                    "bookmark": action.bookmark,
                    "pr_number": pr_number,
                    "url": new_pr.url,
                    "status": "ok",
                })

            # 3. Update base if changed
            if action.update_base and pr_number is not None:
                current_action = "update_pr_base"
                target_base = action.target_base.replace("refs/heads/", "")
                # Map bookmark names to PR numbers for base resolution
                # (the target_base could be a bookmark name that now has a PR)
                update_pr_base(gh_repo, pr_number, target_base, cwd, args.timeout)
                completed_actions.append({
                    "action": "update_pr_base",
                    "bookmark": action.bookmark,
                    "pr_number": pr_number,
                    "new_base": target_base,
                    "status": "ok",
                })
        except StackError as exc:
            failed_action = {
                "action": current_action,
                "bookmark": action.bookmark,
                "error": str(exc),
            }
            break

    # --- Comment reconciliation ---
    # This happens even if some core actions failed (best-effort)
    comment_errors: list[str] = []
    gh_user = get_gh_user(cwd, args.timeout)
    for slc_action in comment_actions:
        pr_num = slc_action.get("pr_number")
        if pr_num is None:
            continue
        try:
            # Build the navigation comment body
            comment_body = build_navigation_comment(
                published_slices,
                gh_repo,
                default_branch,
            )

            # Check for existing kstack comment (only owned by gh_user)
            existing_comments = get_pr_comments(gh_repo, pr_num, cwd, args.timeout)
            existing = find_kstack_comment(existing_comments, gh_user=gh_user)
            existing_id = existing.get("id") if existing else None

            create_or_update_comment(
                gh_repo, pr_num, comment_body, cwd,
                existing_comment_id=existing_id,
                timeout=args.timeout,
            )
            completed_actions.append({
                "action": "update_nav_comment" if existing_id else "create_nav_comment",
                "pr_number": pr_num,
                "status": "ok",
            })
        except StackError as exc:
            comment_errors.append(f"PR #{pr_num}: {exc}")

    result = build_apply_result_json(completed_actions, failed_action)
    if comment_errors:
        result["comment_errors"] = comment_errors
    result["plan_id"] = plan.plan_id
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Plan and apply stacked PR publication.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan", help="Read-only publication plan.")
    plan_parser.add_argument("--repo", default=None, help="Repository path (default: cwd).")
    plan_parser.add_argument("--top", required=True, help="Top bookmark name.")
    plan_parser.add_argument("--remote", required=True, help="Git remote name (e.g. origin).")
    plan_parser.add_argument("--trunk", default="trunk()", help="Trunk revset (default: trunk()).")
    plan_parser.add_argument("--max-stack", type=int, default=DEFAULT_MAX_STACK)
    plan_parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)

    apply_parser = subparsers.add_parser("apply", help="Apply a publication plan.")
    apply_parser.add_argument("--repo", default=None, help="Repository path (default: cwd).")
    apply_parser.add_argument("--top", required=True, help="Top bookmark name.")
    apply_parser.add_argument("--remote", required=True, help="Git remote name (e.g. origin).")
    apply_parser.add_argument("--plan-id", required=True, help="Plan ID from `plan` output.")
    apply_parser.add_argument("--trunk", default="trunk()", help="Trunk revset (default: trunk()).")
    apply_parser.add_argument("--max-stack", type=int, default=DEFAULT_MAX_STACK)
    apply_parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)

    args = parser.parse_args(argv)

    try:
        if args.command == "plan":
            result = cmd_plan(args)
        elif args.command == "apply":
            result = cmd_apply(args)
        else:
            result = {"status": "error", "error": f"Unknown command: {args.command}"}

        print(json.dumps(result, indent=2, default=str))
        status = result.get("status", "error")
        if status in ("blocked", "stale_plan", "error", "partial"):
            return 1
        return 0

    except StackError as exc:
        print(json.dumps({"status": "error", "error": str(exc), "exit_code": exc.exit_code}))
        return exc.exit_code
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc), "exit_code": 1}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))