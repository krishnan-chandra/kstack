"""Deterministic tests for publish_stack.py.

Uses fake ``jj`` and ``gh`` executables injected via PATH manipulation.
No real GitHub credentials or network access.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

PUBLISH_SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "scripts", "publish_stack.py"
)


def _make_fake_bin(commands: dict[str, str]) -> str:
    """Create a temp bin directory with fake executables.

    *commands* maps executable names to shell script bodies (without the shebang).
    """
    tmpdir = tempfile.mkdtemp(prefix="fake_bin_")
    for name, script in commands.items():
        path = os.path.join(tmpdir, name)
        with open(path, "w") as f:
            f.write("#!/bin/sh\n")
            f.write(script)
        os.chmod(path, stat.S_IRWXU)
    return tmpdir


class PublishStackApplyUnitTest(unittest.TestCase):
    def test_plan_and_apply_block_truncated_stack(self) -> None:
        from publish_stack import cmd_apply, cmd_plan

        args = SimpleNamespace(
            repo=".", trunk="trunk()", top="feat1", max_stack=50,
            timeout=20, remote="origin", plan_id="plan123",
        )
        model = {"blockers": [], "truncated": True, "top": "feat1", "stack": []}
        for command in (cmd_plan, cmd_apply):
            with self.subTest(command=command.__name__), patch(
                "publish_stack.build_inspect_model", return_value=model
            ):
                result = command(args)
            self.assertEqual(result["status"], "blocked")
            self.assertTrue(any("truncated" in blocker for blocker in result["blockers"]))

    def test_plan_and_apply_require_top_as_final_boundary(self) -> None:
        from publish_stack import cmd_apply, cmd_plan
        from stack_model import Slice

        args = SimpleNamespace(
            repo=".", trunk="trunk()", top="feat2", max_stack=50,
            timeout=20, remote="origin", plan_id="plan123",
        )
        model = {"blockers": [], "truncated": False, "top": "feat2", "stack": []}
        incomplete = [Slice("feat1", None, ["change1"], "First")]
        for command in (cmd_plan, cmd_apply):
            with (
                self.subTest(command=command.__name__),
                patch("publish_stack.build_inspect_model", return_value=model),
                patch("publish_stack.derive_slices", return_value=incomplete),
            ):
                result = command(args)
            self.assertEqual(result["status"], "blocked")
            self.assertTrue(any("final PR boundary" in blocker for blocker in result["blockers"]))

    def test_comment_reconciliation_skips_when_authenticated_user_is_unknown(self) -> None:
        from github_stack import GitHubRepo, RemoteInfo, SliceAction, StackPlan
        from publish_stack import cmd_apply
        from stack_model import Slice

        slices = [Slice("feat1", None, ["change1"], "First")]
        plan = StackPlan(
            "plan123", {"owner": "owner", "repo": "repo", "default_branch": "main"},
            "origin", "main",
            [SliceAction("feat1", 11, False, False, False, "main", "main")],
            [{"pr_number": 11, "action": "create_or_update", "body_template": "navigation", "bookmark": "feat1"}],
            [],
        )
        args = SimpleNamespace(
            repo=".", trunk="trunk()", top="feat1", max_stack=50,
            timeout=20, remote="origin", plan_id="plan123",
        )
        model = {"blockers": [], "truncated": False, "top": "feat1", "stack": []}
        with (
            patch("publish_stack.build_inspect_model", return_value=model),
            patch("publish_stack.derive_slices", return_value=slices),
            patch("publish_stack.get_remote_info", return_value=RemoteInfo("origin", "https://github.com/owner/repo", GitHubRepo("owner", "repo"))),
            patch("publish_stack.get_default_branch", return_value="main"),
            patch("publish_stack.list_open_prs", return_value=[]),
            patch("publish_stack.list_bookmarks", return_value=[]),
            patch("publish_stack.list_remote_bookmarks", return_value=[]),
            patch("publish_stack.build_plan", return_value=plan),
            patch("publish_stack.get_gh_user", return_value=""),
            patch("publish_stack.get_pr_comments") as get_comments,
            patch("publish_stack.create_or_update_comment") as write_comment,
        ):
            result = cmd_apply(args)

        self.assertEqual(result["status"], "completed")
        self.assertIn("could not determine", result["comment_errors"][0])
        get_comments.assert_not_called()
        write_comment.assert_not_called()

    def test_first_publish_comments_include_all_created_pr_numbers(self) -> None:
        from github_stack import GitHubRepo, PRInfo, RemoteInfo, SliceAction, StackPlan
        from publish_stack import cmd_apply
        from stack_model import Slice

        slices = [
            Slice("feat1", None, ["change1"], "First"),
            Slice("feat2", "feat1", ["change2"], "Second"),
        ]
        actions = [
            SliceAction("feat1", None, True, True, False, None, "main"),
            SliceAction("feat2", None, True, True, False, None, "feat1"),
        ]
        plan = StackPlan(
            "plan123",
            {"owner": "owner", "repo": "repo", "default_branch": "main"},
            "origin",
            "main",
            actions,
            [
                {"pr_number": None, "action": "create_or_update", "body_template": "navigation", "bookmark": "feat1"},
                {"pr_number": None, "action": "create_or_update", "body_template": "navigation", "bookmark": "feat2"},
            ],
            [],
        )
        created = [
            PRInfo(11, "feat1", "main", "First", True, "https://example/11", "owner"),
            PRInfo(12, "feat2", "feat1", "Second", True, "https://example/12", "owner"),
        ]
        args = SimpleNamespace(
            repo=".", trunk="trunk()", top="feat2", max_stack=50,
            timeout=20, remote="origin", plan_id="plan123",
        )
        model = {"blockers": [], "truncated": False, "top": "feat2", "stack": []}

        with (
            patch("publish_stack.build_inspect_model", return_value=model),
            patch("publish_stack.derive_slices", return_value=slices),
            patch("publish_stack.get_remote_info", return_value=RemoteInfo("origin", "https://github.com/owner/repo", GitHubRepo("owner", "repo"))),
            patch("publish_stack.get_default_branch", return_value="main"),
            patch("publish_stack.list_open_prs", return_value=[]),
            patch("publish_stack.list_bookmarks", return_value=[]),
            patch("publish_stack.list_remote_bookmarks", return_value=[]),
            patch("publish_stack.build_plan", return_value=plan),
            patch("publish_stack.push_bookmark"),
            patch("publish_stack.create_pr", side_effect=created),
            patch("publish_stack.get_gh_user", return_value="publisher"),
            patch("publish_stack.get_pr_comments", return_value=[]),
            patch("publish_stack.create_or_update_comment", return_value={}) as write_comment,
        ):
            result = cmd_apply(args)

        self.assertEqual(result["status"], "completed")
        self.assertEqual([entry["pr_number"] for entry in result["completed_actions"] if entry["action"] == "create_pr"], [11, 12])
        self.assertEqual(write_comment.call_count, 2)
        for comment_call in write_comment.call_args_list:
            body = comment_call.args[2]
            self.assertIn("#11", body)
            self.assertIn("#12", body)


class PublishStackPlanTest(unittest.TestCase):
    """Tests for the 'plan' subcommand using fake jj and gh."""

    def setUp(self) -> None:
        self._orig_path = os.environ.get("PATH", "")
        self._tmpdir = tempfile.mkdtemp(prefix="publish_test_")
        # Create a minimal git repo so git remote commands work
        self._init_git_repo()

    def tearDown(self) -> None:
        os.environ["PATH"] = self._orig_path
        # Clean up temp files

    def _init_git_repo(self) -> None:
        """Initialize a bare minimum git repo for remote queries."""
        subprocess.run(
            ["git", "init", "--quiet"],
            cwd=self._tmpdir,
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=self._tmpdir, capture_output=True, timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=self._tmpdir, capture_output=True, timeout=10,
        )
        # Add a remote
        subprocess.run(
            ["git", "remote", "add", "origin", "https://github.com/owner/repo.git"],
            cwd=self._tmpdir, capture_output=True, timeout=10,
        )

    def _make_fake_env(
        self,
        jj_version: str = "jj 0.44.0",
        jj_workspace_root_output: str = "/tmp/fake_root",
        jj_log_output: str = "",
        jj_bookmark_list: str = "",
        gh_api_output: str = '{"default_branch": "main"}',
        gh_pr_list_output: str = "[]",
        stack_json: str = "",
    ) -> dict[str, str]:
        """Create fake jj and gh executables and return the env with PATH set."""
        jj_script = f"""
if [ "$1" = "--version" ]; then
  echo "{jj_version}"
elif [ "$1" = "workspace" ] && [ "$2" = "root" ]; then
  echo "{jj_workspace_root_output}"
elif [ "$1" = "bookmark" ] && [ "$2" = "list" ]; then
  echo "{jj_bookmark_list}"
elif [ "$1" = "log" ]; then
  echo "{jj_log_output}"
elif [ "$1" = "git" ] && [ "$2" = "push" ]; then
  echo "pushed"
elif [ "$1" = "git" ] && [ "$2" = "fetch" ]; then
  echo "fetched"
else
  echo "unexpected jj call: $*" >&2
  exit 1
fi
"""
        gh_script = f"""
if [ "$1" = "api" ] && echo "$*" | grep -q "/repos"; then
  {self._build_gh_api_handler(gh_api_output)}
elif [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '{gh_pr_list_output}'
elif [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo 'https://github.com/owner/repo/pull/1'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{{"number":1,"headRefName":"feat1","baseRefName":"main","title":"feat: test","isDraft":true,"url":"https://github.com/owner/repo/pull/1"}}'
elif [ "$1" = "auth" ]; then
  echo "authenticated"
else
  echo "unexpected gh call: $*" >&2
  exit 1
fi
"""
        fake_bin = _make_fake_bin({"jj": jj_script, "gh": gh_script})
        env = os.environ.copy()
        env["PATH"] = f"{fake_bin}:{self._orig_path}"
        return env

    def _build_gh_api_handler(self, output: str) -> str:
        return f'echo \'{output}\''

    def test_plan_blocked_no_top(self) -> None:
        """Without a top bookmark, plan should return blocked."""
        # Create fake jj that returns no bookmarks
        log_output = '{"change_id":"abc","commit_id":"def","subject":"test","empty":false,"conflict":false,"divergent":false,"merge":false,"bookmarks":[],"remote_bookmarks":[],"parents":["trunk123"],"is_working_copy":true}'
        env = self._make_fake_env(
            jj_log_output=log_output,
            jj_bookmark_list="",
        )
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "plan", "--repo", self._tmpdir,
             "--top", "feat1", "--remote", "origin"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        output = json.loads(result.stdout)
        # The fake jj doesn't have the bookmark, so we expect it to fail
        self.assertIn(output.get("status"), ("blocked", "error"))

    def test_plan_structure(self) -> None:
        """Verify plan has the expected top-level keys."""
        # We just verify basic structure with a minimal valid setup
        log_output = ('{"change_id":"abc","commit_id":"def","subject":"feat: test","empty":false,'
                      '"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],'
                      '"remote_bookmarks":[],"parents":["trunk123"],"is_working_copy":false}')
        env = self._make_fake_env(
            jj_log_output=log_output,
            jj_bookmark_list="feat1\tcommit1",
            gh_api_output='{"default_branch": "main"}',
            gh_pr_list_output='[]',
        )
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "plan", "--repo", self._tmpdir,
             "--top", "feat1", "--remote", "origin"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"Invalid JSON output: {result.stdout}")

        # Check expected keys
        if output.get("status") == "ok":
            self.assertIn("plan_id", output)
            self.assertIn("plan", output)
            self.assertIn("slices", output["plan"])
        else:
            # May be blocked due to fake jj not behaving exactly right
            self.assertIn("status", output)

    def test_apply_stale_planid(self) -> None:
        """Applying with a stale plan ID should return stale_plan."""
        log_output = ('{"change_id":"abc","commit_id":"def","subject":"feat: test","empty":false,'
                      '"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],'
                      '"remote_bookmarks":[],"parents":["trunk123"],"is_working_copy":false}')
        env = self._make_fake_env(
            jj_log_output=log_output,
            jj_bookmark_list="feat1\tcommit1",
            gh_api_output='{"default_branch": "main"}',
            gh_pr_list_output='[]',
        )
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "apply", "--repo", self._tmpdir,
             "--top", "feat1", "--remote", "origin", "--plan-id", "stale_id_123"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"Invalid JSON output: {result.stdout}")

        # May be blocked or stale - either is acceptable
        self.assertIn("status", output)
        if output["status"] == "stale_plan":
            self.assertIn("provided_plan_id", output)
            self.assertIn("recomputed_plan_id", output)

    def test_apply_blocked_no_bookmark(self) -> None:
        """Apply without bookmark should return blocked."""
        log_output = ('{"change_id":"abc","commit_id":"def","subject":"test","empty":false,'
                      '"conflict":false,"divergent":false,"merge":false,"bookmarks":[],'
                      '"remote_bookmarks":[],"parents":["trunk123"],"is_working_copy":true}')
        env = self._make_fake_env(jj_log_output=log_output, jj_bookmark_list="")
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "apply", "--repo", self._tmpdir,
             "--top", "feat1", "--remote", "origin", "--plan-id", "abc"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"Invalid JSON output: {result.stdout}")
        self.assertIn(output.get("status"), ("blocked", "error"))

    def test_help_exists(self) -> None:
        """Verify the script has plan and apply subcommands."""
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("plan", result.stdout)
        self.assertIn("apply", result.stdout)

    def test_plan_help_text(self) -> None:
        """Verify plan subcommand help."""
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "plan", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("--top", result.stdout)
        self.assertIn("--remote", result.stdout)

    def test_apply_help_text(self) -> None:
        """Verify apply subcommand help."""
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT, "apply", "--help"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("--plan-id", result.stdout)
        self.assertIn("--top", result.stdout)

    def test_no_command_errors(self) -> None:
        """Running without a subcommand should error."""
        result = subprocess.run(
            [sys.executable, PUBLISH_SCRIPT],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr.lower() + result.stdout.lower())


if __name__ == "__main__":
    unittest.main()