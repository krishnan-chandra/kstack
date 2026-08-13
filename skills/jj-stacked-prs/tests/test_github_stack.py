"""Deterministic tests for github_stack.py.

Uses fake ``jj`` and ``gh`` executables; no real GitHub credentials or
network access.
"""

import json
import os
import stat
import sys
import tempfile
import unittest
from typing import Any, Callable

# Ensure the scripts directory is on the path for imports
_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from stack_model import StackError


class GitHubStackUnitTest(unittest.TestCase):
    """Unit tests for github_stack helper functions that need no executables."""

    def test_parse_github_url_https(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("https://github.com/owner/repo.git")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_https_no_dot_git(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("https://github.com/owner/repo")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_ssh(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("git@github.com:owner/repo.git")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_non_github(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("https://gitlab.com/owner/repo.git")
        self.assertIsNone(result)

    def test_parse_github_url_invalid(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("not a url")
        self.assertIsNone(result)

    def test_parse_github_url_empty(self) -> None:
        from github_stack import parse_github_url
        result = parse_github_url("")
        self.assertIsNone(result)

    def test_find_pr_for_bookmark(self) -> None:
        from github_stack import PRInfo, find_pr_for_bookmark
        prs = [
            PRInfo(number=1, head_ref="feat1", base_ref="main", title="feat: 1",
                   is_draft=True, url="https://github.com/o/r/pull/1", head_owner="o"),
            PRInfo(number=2, head_ref="feat2", base_ref="main", title="feat: 2",
                   is_draft=False, url="https://github.com/o/r/pull/2", head_owner="o"),
        ]
        result = find_pr_for_bookmark(prs, "feat1")
        self.assertIsNotNone(result)
        self.assertEqual(result.number, 1)
        self.assertIsNone(find_pr_for_bookmark(prs, "nonexistent"))

    def test_find_pr_for_bookmark_empty(self) -> None:
        from github_stack import find_pr_for_bookmark
        self.assertIsNone(find_pr_for_bookmark([], "feat1"))

    def test_build_navigation_comment(self) -> None:
        from github_stack import (
            KSTACK_COMMENT_MARKER,
            SliceAction,
            build_navigation_comment,
        )
        gh_repo = type("GHRepo", (), {"owner": "owner", "repo": "repo"})()
        slices = [
            SliceAction(bookmark="feat1", pr_number=1, push_required=False,
                        create_pr=False, update_base=False,
                        current_base="main", target_base="main"),
            SliceAction(bookmark="feat2", pr_number=None, push_required=True,
                        create_pr=True, update_base=False,
                        current_base=None, target_base="feat1"),
        ]
        comment = build_navigation_comment(slices, gh_repo, "main")
        self.assertIn(KSTACK_COMMENT_MARKER, comment)
        self.assertIn("kstack", comment)
        self.assertIn("feat1", comment)
        self.assertIn("feat2", comment)
        self.assertIn("main", comment)

    def test_find_kstack_comment_found(self) -> None:
        from github_stack import KSTACK_COMMENT_MARKER, find_kstack_comment
        comments = [
            {"id": 1, "body": "regular comment"},
            {"id": 2, "body": f"{KSTACK_COMMENT_MARKER}\nnav content"},
        ]
        result = find_kstack_comment(comments)
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], 2)

    def test_find_kstack_comment_not_found(self) -> None:
        from github_stack import find_kstack_comment
        comments = [
            {"id": 1, "body": "regular comment"},
            {"id": 2, "body": "another comment"},
        ]
        self.assertIsNone(find_kstack_comment(comments))

    def test_find_kstack_comment_empty(self) -> None:
        from github_stack import find_kstack_comment
        self.assertIsNone(find_kstack_comment([]))

    def test_parse_comment_metadata_valid(self) -> None:
        from github_stack import KSTACK_COMMENT_MARKER, parse_comment_metadata
        body = f"{KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->"
        meta = parse_comment_metadata(body)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["schema_version"], 1)

    def test_parse_comment_metadata_no_marker(self) -> None:
        from github_stack import parse_comment_metadata
        self.assertIsNone(parse_comment_metadata("just a comment"))

    def test_build_plan_json(self) -> None:
        from github_stack import (
            StackPlan, SliceAction, build_plan_json,
        )
        plan = StackPlan(
            plan_id="abc123",
            repo_info={"owner": "o", "repo": "r", "default_branch": "main"},
            remote="origin",
            default_branch="main",
            slices=[
                SliceAction(bookmark="feat1", pr_number=None, push_required=True,
                            create_pr=True, update_base=False,
                            current_base=None, target_base="main"),
            ],
            comment_actions=[],
            blockers=[],
        )
        result = build_plan_json(plan)
        self.assertEqual(result["plan_id"], "abc123")
        self.assertEqual(len(result["slices"]), 1)
        self.assertEqual(result["slices"][0]["bookmark"], "feat1")
        self.assertTrue(result["slices"][0]["create_pr"])

    def test_build_apply_result(self) -> None:
        from github_stack import build_apply_result_json
        result = build_apply_result_json(
            completed_actions=[{"action": "push", "bookmark": "feat1", "status": "ok"}],
            failed_action=None,
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["completed_actions"]), 1)

    def test_build_apply_result_partial(self) -> None:
        from github_stack import build_apply_result_json
        result = build_apply_result_json(
            completed_actions=[{"action": "push", "bookmark": "feat1", "status": "ok"}],
            failed_action={"action": "push_or_create", "bookmark": "feat2", "error": "Network error"},
        )
        self.assertEqual(result["status"], "partial")
        self.assertIn("failed_action", result)

    def test_compute_plan_id_deterministic(self) -> None:
        from github_stack import compute_plan_id
        id1 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        id2 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        self.assertEqual(id1, id2)

    def test_compute_plan_id_changes_on_input(self) -> None:
        from github_stack import compute_plan_id
        id1 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        id2 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "def"}])
        self.assertNotEqual(id1, id2)

    def test_compute_plan_id_length(self) -> None:
        from github_stack import compute_plan_id
        plan_id = compute_plan_id("o/r", "main", [{"bookmark": "f1"}])
        self.assertEqual(len(plan_id), 16)  # 16 hex chars


if __name__ == "__main__":
    unittest.main()