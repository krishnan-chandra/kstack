"""Deterministic tests for github_stack.py.

Uses fake ``jj`` and ``gh`` executables; no real GitHub credentials or
network access.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

# Ensure the scripts directory is on the path for imports
_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from github_stack import (  # noqa: E402 - imports require the scripts path above
    KSTACK_COMMENT_MARKER,
    GitHubRepo,
    NavigationEntry,
    PRInfo,
    SliceAction,
    StackPlan,
    build_apply_result_json,
    build_navigation_comment,
    build_plan,
    build_plan_json,
    compute_plan_id,
    create_pr,
    find_kstack_comment,
    find_navigation_ancestors,
    find_pr_for_bookmark,
    get_pr_comments,
    get_pr_status,
    list_open_prs,
    parse_comment_metadata,
    parse_github_url,
    parse_navigation_comment_entries,
    push_bookmark,
    reconcile_stack_entries,
)
from stack_model import CommandResult, Slice, StackError  # noqa: E402


class GitHubStackUnitTest(unittest.TestCase):
    """Unit tests for github_stack helper functions that need no executables."""

    def test_parse_github_url_https(self) -> None:
        result = parse_github_url("https://github.com/owner/repo.git")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_https_no_dot_git(self) -> None:
        result = parse_github_url("https://github.com/owner/repo")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_ssh(self) -> None:
        result = parse_github_url("git@github.com:owner/repo.git")
        self.assertIsNotNone(result)
        self.assertEqual(result.owner, "owner")
        self.assertEqual(result.repo, "repo")

    def test_parse_github_url_non_github(self) -> None:
        result = parse_github_url("https://gitlab.com/owner/repo.git")
        self.assertIsNone(result)

    def test_parse_github_url_invalid(self) -> None:
        result = parse_github_url("not a url")
        self.assertIsNone(result)

    def test_parse_github_url_empty(self) -> None:
        result = parse_github_url("")
        self.assertIsNone(result)

    def test_list_open_prs_matches_exact_head_repository_case_insensitively(self) -> None:
        payload = json.dumps([
            {
                "number": 1,
                "headRefName": "feat1",
                "baseRefName": "main",
                "title": "right repo",
                "isDraft": True,
                "url": "https://github.com/Owner/Repo/pull/1",
                "headRepository": {"nameWithOwner": "Owner/Repo"},
                "headRepositoryOwner": {"login": "Owner"},
            },
            {
                "number": 2,
                "headRefName": "feat1",
                "baseRefName": "main",
                "title": "same-owner fork",
                "isDraft": True,
                "url": "https://github.com/Owner/Repo/pull/2",
                "headRepository": {"nameWithOwner": "Owner/repo-fork"},
                "headRepositoryOwner": {"login": "Owner"},
            },
        ])
        with patch("github_stack.run_gh", return_value=CommandResult(payload, "", 0)):
            prs = list_open_prs(GitHubRepo("owner", "repo"), ".")
        self.assertEqual([pr.number for pr in prs], [1])

    def test_list_open_prs_ignores_deleted_forks_and_decodes_concatenated_json(self) -> None:
        values = [
            {
                "number": 1,
                "headRefName": "deleted",
                "baseRefName": "main",
                "headRepository": None,
                "headRepositoryOwner": None,
            },
            {
                "number": 2,
                "headRefName": "feature",
                "baseRefName": "main",
                "headRepository": {"nameWithOwner": "owner/repo"},
                "headRepositoryOwner": {"login": "owner"},
            },
        ]
        payload = "\n".join(json.dumps(value, indent=2) for value in values)
        with patch("github_stack.run_gh", return_value=CommandResult(payload, "", 0)):
            prs = list_open_prs(GitHubRepo("owner", "repo"), ".")
        self.assertEqual([pr.number for pr in prs], [2])
        self.assertEqual(prs[0].head_owner, "owner")

    def test_push_bookmark_uses_supported_safe_jj_arguments(self) -> None:
        with patch("stack_model.run_jj", return_value=CommandResult("", "", 0)) as run_jj:
            push_bookmark(".", "origin", "feature")
        run_jj.assert_called_once_with(
            ["git", "push", "--remote", "origin", "--bookmark", "feature"],
            cwd=".",
            timeout=30,
        )

    @unittest.skipUnless(shutil.which("jj") and shutil.which("git"), "jj and git are required")
    def test_push_bookmark_creates_and_safely_rewrites_remote_bookmark(self) -> None:
        with tempfile.TemporaryDirectory(prefix="jj-push-test-") as root:
            remote = os.path.join(root, "remote.git")
            work = os.path.join(root, "work")

            def run(*args: str, cwd: str | None = None) -> subprocess.CompletedProcess[str]:
                return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, timeout=30)

            run("git", "init", "--bare", "--quiet", remote)
            run("git", "init", "--quiet", "-b", "main", work)
            run("git", "config", "user.name", "Test", cwd=work)
            run("git", "config", "user.email", "test@example.com", cwd=work)
            with open(os.path.join(work, "file"), "w", encoding="utf-8") as handle:
                handle.write("base\n")
            run("git", "add", "file", cwd=work)
            run("git", "commit", "--quiet", "-m", "base", cwd=work)
            run("git", "remote", "add", "origin", remote, cwd=work)
            run("git", "push", "--quiet", "-u", "origin", "main", cwd=work)
            run("jj", "git", "init", "--colocate", work)
            run("jj", "-R", work, "new", "main", "-m", "feature")
            with open(os.path.join(work, "file"), "a", encoding="utf-8") as handle:
                handle.write("v1\n")
            run("jj", "-R", work, "bookmark", "create", "feature", "-r", "@")

            push_bookmark(work, "origin", "feature")
            first = run("git", f"--git-dir={remote}", "rev-parse", "refs/heads/feature").stdout.strip()

            with open(os.path.join(work, "file"), "a", encoding="utf-8") as handle:
                handle.write("v2\n")
            run("jj", "-R", work, "describe", "-m", "feature rewritten")
            push_bookmark(work, "origin", "feature")
            second = run("git", f"--git-dir={remote}", "rev-parse", "refs/heads/feature").stdout.strip()

            self.assertNotEqual(first, second)

    def test_create_pr_stops_when_created_pr_cannot_be_resolved(self) -> None:
        responses = [
            CommandResult("https://github.com/o/r/pull/7\n", "", 0),
            CommandResult("", "lookup failed", 1),
        ]
        with patch("github_stack.run_gh", side_effect=responses):
            with self.assertRaisesRegex(StackError, "Run plan again"):
                create_pr(GitHubRepo("o", "r"), "feature", "main", "Title", ".")

    def test_find_pr_for_bookmark(self) -> None:
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
        self.assertIsNone(find_pr_for_bookmark([], "feat1"))

    def test_find_pr_for_bookmark_rejects_ambiguity(self) -> None:
        prs = [
            PRInfo(1, "feat1", "main", "one", True, "url1", "o"),
            PRInfo(2, "feat1", "release", "two", True, "url2", "o"),
        ]
        self.assertIsNone(find_pr_for_bookmark(prs, "feat1"))

    def test_build_navigation_comment(self) -> None:
        entries = [
            NavigationEntry(1, "feat1", "main", "open"),
            NavigationEntry(None, "feat2", "feat1", "unknown"),
        ]
        comment = build_navigation_comment(entries, "main")
        self.assertIn(KSTACK_COMMENT_MARKER, comment)
        self.assertIn("kstack", comment)
        self.assertIn("feat1", comment)
        self.assertIn("feat2", comment)
        self.assertIn("main", comment)

    def test_find_kstack_comment_found(self) -> None:
        comments = [
            {"id": 1, "body": "regular comment"},
            {"id": 2, "body": f"{KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->\nnav content"},
        ]
        result = find_kstack_comment(comments)
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], 2)

    def test_find_kstack_comment_accepts_owned_legacy_marker(self) -> None:
        comments = [{"id": 7, "body": f"{KSTACK_COMMENT_MARKER}\nlegacy nav", "user": "publisher"}]
        self.assertEqual(find_kstack_comment(comments, gh_user="publisher")["id"], 7)

    def test_find_kstack_comment_rejects_wrong_author_or_schema(self) -> None:
        comments = [
            {
                "id": 1,
                "body": f"{KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->",
                "user": "someone-else",
            },
            {
                "id": 2,
                "body": f"{KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v999 -->",
                "user": "publisher",
            },
        ]
        self.assertIsNone(find_kstack_comment(comments, gh_user="publisher"))

    def test_find_kstack_comment_not_found(self) -> None:
        comments = [
            {"id": 1, "body": "regular comment"},
            {"id": 2, "body": "another comment"},
        ]
        self.assertIsNone(find_kstack_comment(comments))

    def test_find_kstack_comment_empty(self) -> None:
        self.assertIsNone(find_kstack_comment([]))

    def test_parse_comment_metadata_valid(self) -> None:
        body = f"{KSTACK_COMMENT_MARKER}\n<!-- kstack-stack-schema-v1 -->"
        meta = parse_comment_metadata(body)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["schema_version"], 1)

    def test_parse_comment_metadata_no_marker(self) -> None:
        self.assertIsNone(parse_comment_metadata("just a comment"))

    def test_navigation_comment_round_trips_structured_entries_safely(self) -> None:
        entries = [
            NavigationEntry(74, "feat-->|one", "main", "merged"),
            NavigationEntry(75, "feat2", "feat-->|one", "draft"),
        ]
        body = build_navigation_comment(entries, "main")
        data_line = next(line for line in body.splitlines() if "kstack-stack-data" in line)

        self.assertNotIn("feat-->", data_line)
        self.assertEqual(parse_navigation_comment_entries(body), entries)

    def test_parse_navigation_comment_entries_from_markdown_table(self) -> None:
        body = (
            f"{KSTACK_COMMENT_MARKER}\n"
            "<!-- kstack-stack-schema-v1 -->\n\n"
            "## Stack navigation (kstack)\n\n"
            "| PR | Bookmark | Base | Status |\n"
            "|---|---|---|---|\n"
            "| #10 | `feat1` | `main` | Merged |\n"
            "| #11 | `feat2` | `feat1` | Open |\n"
        )
        entries = parse_navigation_comment_entries(body)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0].pr_number, 10)
        self.assertEqual(entries[0].bookmark, "feat1")
        self.assertEqual(entries[0].status, "merged")
        self.assertEqual(entries[1].pr_number, 11)
        self.assertEqual(entries[1].bookmark, "feat2")
        self.assertEqual(entries[1].status, "open")

    def test_reconcile_stack_entries_preserves_merged_ancestor_prs(self) -> None:
        # Existing comment on PR 11 has feat1 (PR 10) and feat2 (PR 11)
        existing_comments = [{
            "id": 1,
            "user": "publisher",
            "body": (
                f"{KSTACK_COMMENT_MARKER}\n"
                "<!-- kstack-stack-schema-v1 -->\n"
                "| PR | Bookmark | Base |\n"
                "|---|---|---|\n"
                "| #10 | `feat1` | `main` |\n"
                "| #11 | `feat2` | `feat1` |\n"
            ),
        }]
        # PR 10 merged (not in open_prs), local stack only has feat2 (now targeting main) and new feat3
        active_slices = [
            SliceAction("feat2", 11, False, False, False, "main", "main"),
            SliceAction("feat3", 12, True, True, False, None, "feat2"),
        ]
        prior_entries = parse_navigation_comment_entries(existing_comments[0]["body"])
        reconciled = reconcile_stack_entries(
            active_slices,
            prior_entries,
            {10: "merged", 11: "open", 12: "draft"},
            "main",
        )
        self.assertEqual(reconciled, [
            NavigationEntry(10, "feat1", "main", "merged"),
            NavigationEntry(11, "feat2", "main", "open"),
            NavigationEntry(12, "feat3", "feat2", "draft"),
        ])

    def test_find_navigation_ancestors_excludes_removed_descendants(self) -> None:
        active = [SliceAction("feat2", 11, False, False, False, "main", "main")]
        prior = [
            NavigationEntry(10, "feat1", "main", "merged"),
            NavigationEntry(11, "feat2", "feat1", "open"),
            NavigationEntry(12, "feat3", "feat2", "closed"),
        ]

        self.assertEqual(find_navigation_ancestors(active, prior), prior[:1])

    def test_get_pr_status_distinguishes_merged_from_closed(self) -> None:
        responses = [
            CommandResult('{"state":"closed","merged":true}', "", 0),
            CommandResult('{"state":"closed","merged":false}', "", 0),
        ]
        with patch("github_stack.run_gh", side_effect=responses):
            self.assertEqual(get_pr_status(GitHubRepo("o", "r"), 10, "."), "merged")
            self.assertEqual(get_pr_status(GitHubRepo("o", "r"), 11, "."), "closed")

    def test_get_pr_comments_raises_on_api_failure(self) -> None:
        with (
            patch("github_stack.run_gh", return_value=CommandResult("", "network failed", 1)),
            self.assertRaisesRegex(StackError, "Could not read comments"),
        ):
            get_pr_comments(GitHubRepo("o", "r"), 12, ".")

    def test_build_plan_only_pushes_changed_bookmarks(self) -> None:
        plan = build_plan(
            cwd=".",
            remote_name="origin",
            gh_repo=GitHubRepo("o", "r"),
            default_branch="main",
            slices=[
                Slice("synced", None, ["a"], "Synced"),
                Slice("changed", "synced", ["b"], "Changed"),
            ],
            local_bookmarks=[
                {"name": "synced", "commit_id": "111"},
                {"name": "changed", "commit_id": "222"},
            ],
            remote_bookmarks=[
                {"name": "synced", "commit_id": "111"},
                {"name": "changed", "commit_id": "old"},
            ],
            open_prs=[],
        )
        self.assertFalse(plan.slices[0].push_required)
        self.assertTrue(plan.slices[1].push_required)

    def test_build_plan_uses_unresolved_target_in_plan_id_state(self) -> None:
        plan = build_plan(
            cwd=".", remote_name="origin", gh_repo=GitHubRepo("o", "r"),
            default_branch="main", slices=[Slice("feature", None, ["a"], "Feature")],
            local_bookmarks=[
                {"name": "feature", "commit_id": "one"},
                {"name": "feature", "commit_id": "two"},
            ],
            remote_bookmarks=[], open_prs=[],
        )
        expected = compute_plan_id("o/r", "main", [{
            "bookmark": "feature",
            "local_commit_id": None,
            "remote_commit_id": None,
            "existing_pr_number": None,
            "existing_pr_base": None,
            "target_base": "main",
        }])
        self.assertEqual(plan.plan_id, expected)
        self.assertTrue(any("exactly one local target" in blocker for blocker in plan.blockers))

    def test_build_plan_blocks_conflicted_remote_bookmark(self) -> None:
        plan = build_plan(
            cwd=".", remote_name="origin", gh_repo=GitHubRepo("o", "r"),
            default_branch="main", slices=[Slice("feature", None, ["a"], "Feature")],
            local_bookmarks=[{"name": "feature", "commit_id": "new"}],
            remote_bookmarks=[
                {"name": "feature", "commit_id": "old1"},
                {"name": "feature", "commit_id": "old2"},
            ],
            open_prs=[],
        )
        self.assertTrue(any("conflicted" in blocker for blocker in plan.blockers))

    def test_build_plan_json(self) -> None:
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
        result = build_apply_result_json(
            completed_actions=[{"action": "push", "bookmark": "feat1", "status": "ok"}],
            failed_action=None,
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["completed_actions"]), 1)

    def test_build_apply_result_partial(self) -> None:
        result = build_apply_result_json(
            completed_actions=[{"action": "push", "bookmark": "feat1", "status": "ok"}],
            failed_action={"action": "push_or_create", "bookmark": "feat2", "error": "Network error"},
        )
        self.assertEqual(result["status"], "partial")
        self.assertIn("failed_action", result)

    def test_compute_plan_id_deterministic(self) -> None:
        id1 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        id2 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        self.assertEqual(id1, id2)

    def test_compute_plan_id_changes_on_input(self) -> None:
        id1 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "abc"}])
        id2 = compute_plan_id("owner/repo", "main", [{"bookmark": "feat1", "local_commit_id": "def"}])
        self.assertNotEqual(id1, id2)

    def test_compute_plan_id_length(self) -> None:
        plan_id = compute_plan_id("o/r", "main", [{"bookmark": "f1"}])
        self.assertEqual(len(plan_id), 16)  # 16 hex chars


if __name__ == "__main__":
    unittest.main()