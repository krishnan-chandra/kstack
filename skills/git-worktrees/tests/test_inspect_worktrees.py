from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "inspect_worktrees.py"
PLANNER = Path(__file__).parents[1] / "scripts" / "plan_worktree.py"
SPEC = importlib.util.spec_from_file_location("inspect_worktrees", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InspectWorktreesTest(unittest.TestCase):
    def test_parse_porcelain_z(self) -> None:
        data = (
            b"worktree /repo\0HEAD abc\0branch refs/heads/main\0\0"
            b"worktree /managed/x\0HEAD def\0branch refs/heads/kstack/x\0locked build\0\0"
        )
        self.assertEqual(
            MODULE.parse_worktree_porcelain_z(data),
            [
                {"worktree": "/repo", "HEAD": "abc", "branch": "refs/heads/main"},
                {"worktree": "/managed/x", "HEAD": "def", "branch": "refs/heads/kstack/x", "locked": "build"},
            ],
        )

    def test_inspects_dirty_managed_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            repo = root / "repo"
            managed = root / "managed"
            repo.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
            (repo / "file.txt").write_text("base\n")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)
            planned = subprocess.run(
                [sys.executable, str(PLANNER), "--repo", str(repo), "--root", str(managed), "--task", "change"],
                capture_output=True,
                text=True,
                check=True,
            )
            plan = json.loads(planned.stdout)
            worktree = Path(plan["path"])
            self.assertEqual(plan["branch"], "kstack/change")
            self.assertEqual(worktree.name, "change")
            self.assertRegex(worktree.parent.name, r"^repo-[0-9a-f]{8}$")
            self.assertEqual(len(plan["base_sha"]), 40)

            worktree.parent.mkdir(parents=True)
            subprocess.run(["git", "worktree", "add", "-q", "-b", "kstack/change", str(worktree), "HEAD"], cwd=repo, check=True)
            (worktree / "new.txt").write_text("untracked\n")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(managed)],
                capture_output=True,
                text=True,
                check=True,
            )
            payload = json.loads(result.stdout)
            self.assertEqual(payload["orphans"], [])
            self.assertEqual(len(payload["worktrees"]), 1)
            item = payload["worktrees"][0]
            self.assertEqual(item["branch"], "kstack/change")
            self.assertTrue(item["dirty"])
            self.assertEqual(item["untracked_entries"], 1)

    def test_marks_symlink_as_orphan_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            managed = root / "managed"
            namespace = managed / "repo-12345678"
            outside = root / "outside"
            namespace.mkdir(parents=True)
            outside.mkdir()
            (namespace / "escape").symlink_to(outside, target_is_directory=True)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(managed)],
                capture_output=True,
                text=True,
                check=True,
            )
            payload = json.loads(result.stdout)
            self.assertEqual(payload["worktrees"], [])
            self.assertIn("symlink", payload["orphans"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
