"""Deterministic tests for stack_model.py using injected fake executables.

These tests do not require a real jj workspace, GitHub credentials, or
network access. They use a fake ``jj`` shell script that returns controlled
output.
"""

import os
import stat
import sys
import tempfile
import unittest

# Ensure the scripts directory is on the path for imports
_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from stack_model import (  # noqa: E402 - imports require the scripts path above
    StackError,
    derive_slices,
    detect_blockers,
    detect_top_bookmark,
    enforce_output_cap,
    parse_concatenated_json,
    parse_jj_version,
    run_cmd,
)


def _fake_jj_path(script: str) -> str:
    """Write a fake jj script to a temp file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".sh", prefix="fake_jj_")
    os.close(fd)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n")
        f.write(script)
    os.chmod(path, stat.S_IRWXU)
    return path


class StackModelUnitTest(unittest.TestCase):
    """Unit tests for stack_model helper functions that don't need jj."""

    def setUp(self) -> None:
        # Move to a temp directory to isolate tests
        self._orig_cwd = os.getcwd()
        self._tmpdir = tempfile.mkdtemp(prefix="stack_model_test_")
        os.chdir(self._tmpdir)

    def tearDown(self) -> None:
        os.chdir(self._orig_cwd)

    def test_parse_jj_version_standard(self) -> None:
        self.assertEqual(parse_jj_version("jj 0.44.0\n"), (0, 44))
        self.assertEqual(parse_jj_version("jj 0.45.1\n"), (0, 45))
        self.assertEqual(parse_jj_version("jj 1.0.0\n"), (1, 0))

    def test_parse_jj_version_prefix(self) -> None:
        self.assertEqual(parse_jj_version("jujutsu 0.44.0 (rev abc)\n"), (0, 44))

    def test_parse_jj_version_none(self) -> None:
        self.assertIsNone(parse_jj_version("not a version string\n"))

    def test_parse_jj_version_empty(self) -> None:
        self.assertIsNone(parse_jj_version(""))

    def test_parse_concatenated_json_empty(self) -> None:
        self.assertEqual(parse_concatenated_json(""), [])

    def test_parse_concatenated_json_single(self) -> None:
        result = parse_concatenated_json('{"a": 1}')
        self.assertEqual(result, [{"a": 1}])

    def test_parse_concatenated_json_multiple(self) -> None:
        result = parse_concatenated_json('{"a": 1}{"b": 2}')
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {"a": 1})
        self.assertEqual(result[1], {"b": 2})

    def test_detect_top_bookmark_empty(self) -> None:
        self.assertIsNone(detect_top_bookmark([]))

    def test_detect_top_bookmark_skips_trunk_names(self) -> None:
        commits = [
            {"bookmarks": ["main"], "change_id": "aaa"},
            {"bookmarks": ["feature"], "change_id": "bbb"},
        ]
        self.assertEqual(detect_top_bookmark(commits), "feature")

    def test_detect_top_bookmark_falls_back(self) -> None:
        commits = [
            {"bookmarks": ["main"], "change_id": "aaa"},
            {"bookmarks": ["master"], "change_id": "bbb"},
        ]
        self.assertEqual(detect_top_bookmark(commits), "master")

    def test_detect_top_bookmark_no_bookmarks(self) -> None:
        commits = [
            {"bookmarks": [], "change_id": "aaa"},
            {"bookmarks": [], "change_id": "bbb"},
        ]
        self.assertIsNone(detect_top_bookmark(commits))

    def test_derive_slices_single(self) -> None:
        stack = [
            {"change_id": "aaa", "bookmarks": ["feat1"], "subject": "feat: add feature 1"},
        ]
        slices = derive_slices(stack, "feat1")
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0].bookmark, "feat1")
        self.assertIsNone(slices[0].base_bookmark)
        self.assertEqual(slices[0].change_ids, ["aaa"])

    def test_derive_slices_multi(self) -> None:
        stack = [
            {"change_id": "aaa", "bookmarks": ["feat1"], "subject": "feat: add feature 1"},
            {"change_id": "bbb", "bookmarks": [], "subject": "wip"},
            {"change_id": "ccc", "bookmarks": ["feat2"], "subject": "feat: add feature 2"},
        ]
        slices = derive_slices(stack, "feat2")
        self.assertEqual(len(slices), 2)
        self.assertEqual(slices[0].bookmark, "feat1")
        self.assertIsNone(slices[0].base_bookmark)
        self.assertEqual(slices[0].change_ids, ["aaa"])
        self.assertEqual(slices[1].bookmark, "feat2")
        self.assertEqual(slices[1].base_bookmark, "feat1")
        self.assertEqual(slices[1].change_ids, ["bbb", "ccc"])

    def test_derive_slices_unbookmarked_tip(self) -> None:
        """Unbookmarked changes after the last bookmark are not part of any slice.
        The top bookmark defines the final PR boundary; working-copy changes above
        it remain outside the stack's PR slices.
        """
        stack = [
            {"change_id": "aaa", "bookmarks": [], "subject": "wip"},
            {"change_id": "bbb", "bookmarks": ["feat1"], "subject": "feat: first"},
            {"change_id": "ccc", "bookmarks": [], "subject": "wip2"},
        ]
        slices = derive_slices(stack, "feat1")
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0].bookmark, "feat1")
        # ccc sits above the top bookmark and is not part of any slice
        self.assertEqual(slices[0].change_ids, ["aaa", "bbb"])

    def test_detect_blockers_conflict(self) -> None:
        commits = [
            {"change_id": "aaa", "commit_id": "aaa123", "subject": "feat: x", "conflict": True,
             "divergent": False, "merge": False, "empty": False,
             "bookmarks": ["feat1"], "parents": ["trunk_hash"]},
        ]
        blockers = detect_blockers(commits, "trunk_hash", "feat1", None)
        self.assertTrue(any("merge conflict" in b for b in blockers))

    def test_detect_blockers_empty_bookmarked(self) -> None:
        commits = [
            {"change_id": "aaa", "commit_id": "aaa123", "subject": "feat: x", "conflict": False,
             "divergent": False, "merge": False, "empty": True,
             "bookmarks": ["feat1"], "parents": ["trunk_hash"]},
        ]
        blockers = detect_blockers(commits, "trunk_hash", "feat1", None)
        self.assertTrue(any("empty" in b.lower() for b in blockers))

    def test_detect_blockers_no_root(self) -> None:
        commits = [
            {"change_id": "aaa", "commit_id": "aaa123", "subject": "feat: x", "conflict": False,
             "divergent": False, "merge": False, "empty": False,
             "bookmarks": ["feat1"], "parents": ["wrong_hash"]},
        ]
        blockers = detect_blockers(commits, "trunk_hash", "feat1", None)
        self.assertTrue(any("not rooted" in b for b in blockers))

    def test_detect_blockers_empty_commits(self) -> None:
        blockers = detect_blockers([], "trunk_hash", "feat1", None)
        self.assertTrue(any("No commits" in b for b in blockers))

    def test_detect_blockers_no_top(self) -> None:
        blockers = detect_blockers([], "trunk_hash", None, None)
        self.assertTrue(any("No top bookmark" in b for b in blockers))

    def test_run_cmd_rejects_output_over_cap(self) -> None:
        with self.assertRaisesRegex(StackError, "output exceeded"):
            run_cmd(
                [sys.executable, "-c", "print('x' * 1000)"],
                cwd=self._tmpdir,
                output_cap=100,
            )

    def test_enforce_output_cap_under_limit(self) -> None:
        model = {"stack": [{"a": 1}], "stack_size": 1}
        result = enforce_output_cap(model, cap_bytes=1024 * 1024)
        self.assertFalse(result.get("output_truncated", False))

    def test_enforce_output_cap_over_limit(self) -> None:
        model = {"stack": [{"x": "y" * 5000}], "stack_size": 1, "blockers": []}
        result = enforce_output_cap(model, cap_bytes=100)
        self.assertTrue(result.get("output_truncated", True))


if __name__ == "__main__":
    unittest.main()