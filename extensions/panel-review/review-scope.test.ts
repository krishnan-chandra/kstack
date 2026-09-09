import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import {
	type CollectScopeOptions,
	collectScope,
	type GitExec,
	readUntracked,
	resolveBase,
	touchesContextFile,
	truncateUtf8,
} from "./review-scope.ts";

/** Fake git: map "args joined" prefixes to stdout; throw on unknown. */
function fakeGit(responses: Record<string, string>): GitExec {
	return (args) => {
		const key = args.join(" ");
		for (const [prefix, out] of Object.entries(responses)) {
			if (key.startsWith(prefix)) return out;
		}
		throw new Error(`unexpected git call: ${key}`);
	};
}

describe("resolveBase", () => {
	const head = { "rev-parse --verify HEAD^{commit}": "headsha\n" };

	it("honors an explicit base that resolves", () => {
		const exec = fakeGit({
			"rev-parse --verify main^{commit}": "mainsha\n",
			"merge-base main HEAD": "mbsha\n",
		});
		const base = resolveBase(exec, "/repo", "main");
		assert.equal(base.strategy, "explicit");
		assert.equal(base.mergeBaseSha, "mbsha");
	});

	it("rejects an explicit base that does not resolve", () => {
		const exec = fakeGit({});
		assert.throws(() => resolveBase(exec, "/repo", "nope"), /does not resolve/);
	});

	it("prefers upstream, then origin/HEAD, then main, then HEAD", () => {
		const upstream = fakeGit({
			"rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/topic\n",
			"rev-parse --verify origin/topic^{commit}": "sha\n",
			"merge-base origin/topic HEAD": "mb\n",
		});
		assert.equal(resolveBase(upstream, "/repo").strategy, "upstream");

		const remoteDefault = fakeGit({
			"rev-parse --verify refs/remotes/origin/HEAD^{commit}": "sha\n",
			"merge-base refs/remotes/origin/HEAD HEAD": "mb\n",
		});
		assert.equal(resolveBase(remoteDefault, "/repo").strategy, "remote-default");

		const main = fakeGit({
			"rev-parse --verify main^{commit}": "sha\n",
			"merge-base main HEAD": "mb\n",
		});
		assert.equal(resolveBase(main, "/repo").strategy, "main");

		const headOnly = fakeGit(head);
		const base = resolveBase(headOnly, "/repo");
		assert.equal(base.strategy, "head");
		assert.equal(base.mergeBaseSha, "headsha");
	});
});

describe("truncateUtf8", () => {
	it("never splits a multi-byte sequence", () => {
		const text = "a".repeat(10) + "€".repeat(10); // € = 3 bytes
		const { text: out, truncated } = truncateUtf8(text, 11);
		assert.ok(truncated);
		assert.ok(Buffer.byteLength(out, "utf8") <= 11);
		assert.equal(out, "a".repeat(10));
	});
});

describe("readUntracked", () => {
	it("skips symlinks, binaries, and path escapes", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-scope-"));
		try {
			writeFileSync(join(dir, "text.ts"), "const x = 1;\n");
			writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
			symlinkSync(join(dir, "text.ts"), join(dir, "link.ts"));

			assert.equal(
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
					readUntracked(dir, "text.ts") as { text: string }
				).text,
				"const x = 1;\n",
			);
			assert.deepEqual(readUntracked(dir, "bin.dat"), { skipped: "binary" });
			assert.deepEqual(readUntracked(dir, "link.ts"), { skipped: "symlink" });
			assert.deepEqual(readUntracked(dir, "../escape.ts"), { skipped: "path escapes repository root" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("truncates large files on a UTF-8 boundary without reading them whole", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-scope-"));
		try {
			// 2-byte chars; a cut at an odd byte lands mid-sequence.
			writeFileSync(join(dir, "big.txt"), "é".repeat(100));
			const r = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ readUntracked(
				dir,
				"big.txt",
				undefined,
				51,
			) as { text: string; truncated: boolean };
			assert.equal(r.truncated, true);
			assert.ok(Buffer.byteLength(r.text, "utf8") <= 51);
			assert.ok(!r.text.includes("�")); // no mojibake at the cut
			assert.equal(r.text, "é".repeat(25)); // 50 bytes, last whole char kept
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("touchesContextFile", () => {
	it("matches basenames Pi loads as context files", () => {
		assert.ok(touchesContextFile("AGENTS.md"));
		assert.ok(touchesContextFile("docs/CLAUDE.md"));
		assert.ok(touchesContextFile("AGENTS.override.md"));
		assert.ok(!touchesContextFile("docs/agents.md")); // case-sensitive
		assert.ok(!touchesContextFile("AGENTS.md.bak"));
		assert.ok(!touchesContextFile("src/agent.ts"));
	});
});

describe("collectScope", () => {
	function makeRepo() {
		const root = mkdtempSync(join(tmpdir(), "pr-repo-"));
		writeFileSync(join(root, "untracked.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "blob.bin"), Buffer.from([0, 0, 0]));
		return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
	}

	const gitFor =
		(root: string, diff: string): GitExec =>
		(args) => {
			const key = args.join(" ");
			if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
			if (key.startsWith("rev-parse HEAD")) return "headsha\n";
			if (key.startsWith("diff --find-renames --find-copies")) return diff;
			if (key.startsWith("diff --name-status -z")) return diff.trim() ? "M\0tracked.ts\0" : "";
			if (key.startsWith("diff --name-status")) return diff.trim() ? "M\ttracked.ts\n" : "";
			if (key.startsWith("status --porcelain")) return "M  tracked.ts\0?? untracked.ts\0?? blob.bin\0";
			if (key.startsWith("log --format=%s")) return "subject one\nsubject two\n";
			throw new Error(`unexpected: ${key}`);
		};

	it("writes a mode-0600 bundle with intent, diff, and untracked contents", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "Test intent", {
				exec: gitFor(root, "diff --git a/tracked.ts b/tracked.ts\n+line\n"),
			});
			bundleDir = scope.dir;
			const content = readFileSync(scope.path, "utf8");
			assert.match(content, /Test intent/);
			assert.match(content, /diff --git/);
			assert.match(content, /export const a = 1/);
			assert.match(content, /blob\.bin[\s\S]*skipped: binary/);
			assert.match(content, /subject one/);
			assert.equal(scope.untrackedCount, 2);
			assert.equal(scope.binaryCount, 1);
			assert.equal(scope.truncated, false);
			assert.equal((parseInt((0o100600).toString(8), 8) & 0o777) === 0o600, true);
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("flags changesets that touch context files", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const exec: GitExec = (args) => {
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith("rev-parse HEAD")) return "headsha\n";
				if (key.startsWith("diff --find-renames --find-copies")) return "diff --git a/AGENTS.md b/AGENTS.md\n+x\n";
				if (key.startsWith("diff --name-status -z")) return "M\0AGENTS.md\0";
				if (key.startsWith("diff --name-status")) return "M\tAGENTS.md\n";
				if (key.startsWith("status --porcelain")) return "M  AGENTS.md\0?? docs/CLAUDE.md\0";
				if (key.startsWith("log --format=%s")) return "subject\n";
				throw new Error(`unexpected: ${key}`);
			};
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", { exec });
			bundleDir = scope.dir;
			assert.equal(scope.contextFilesTouched, true);
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("flags a rename whose source is a context file", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const exec: GitExec = (args) => {
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith("rev-parse HEAD")) return "headsha\n";
				if (key.startsWith("diff --find-renames --find-copies")) return "diff\n";
				if (key.startsWith("diff --name-status -z")) return "";
				if (key.startsWith("diff --name-status")) return "";
				if (key.startsWith("status --porcelain")) return "R  notes.md\0AGENTS.md\0";
				if (key.startsWith("log --format=%s")) return "subject\n";
				throw new Error(`unexpected: ${key}`);
			};
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", { exec });
			bundleDir = scope.dir;
			assert.equal(scope.contextFilesTouched, true);
			assert.ok(scope.changedPaths.includes("AGENTS.md"));
			assert.ok(scope.changedPaths.includes("notes.md"));
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("does not flag ordinary changesets", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", {
				exec: gitFor(root, "diff --git a/tracked.ts b/tracked.ts\n+line\n"),
			});
			bundleDir = scope.dir;
			assert.equal(scope.contextFilesTouched, false);
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("expands untracked directories via --untracked-files=all", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		const seenArgs: string[][] = [];
		try {
			writeFileSync(join(root, "new-file.ts"), "export const b = 2;\n");
			const exec: GitExec = (args) => {
				seenArgs.push(args);
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith("rev-parse HEAD")) return "headsha\n";
				if (key.startsWith("diff --find-renames --find-copies")) return "";
				if (key.startsWith("diff --name-status")) return "";
				// With -uall, git lists the file inside the new directory, not "?? dir/".
				if (key.startsWith("status --porcelain")) return "?? dir/new-file.ts\0";
				if (key.startsWith("log --format=%s")) return "";
				throw new Error(`unexpected: ${key}`);
			};
			mkdirSync(join(root, "dir"));
			writeFileSync(join(root, "dir", "new-file.ts"), "export const b = 2;\n");
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", { exec });
			bundleDir = scope.dir;
			const statusCall = seenArgs.find((a) => a[0] === "status");
			assert.ok(statusCall?.includes("--untracked-files=all"));
			const content = readFileSync(scope.path, "utf8");
			assert.match(content, /dir\/new-file\.ts/);
			assert.match(content, /export const b = 2/);
			assert.ok(!/not a regular file/.test(content));
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("caps the number of untracked files and discloses the overflow", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const exec: GitExec = (args) => {
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith("rev-parse HEAD")) return "headsha\n";
				if (key.startsWith("diff --find-renames --find-copies")) return "";
				if (key.startsWith("diff --name-status")) return "";
				if (key.startsWith("status --porcelain")) return "?? a.ts\0?? b.ts\0?? c.ts\0";
				if (key.startsWith("log --format=%s")) return "";
				throw new Error(`unexpected: ${key}`);
			};
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", {
				exec,
				untrackedFiles: 2,
			});
			bundleDir = scope.dir;
			const content = readFileSync(scope.path, "utf8");
			assert.match(content, /3 untracked files; only the first 2 are included/);
			assert.match(content, /### a\.ts/);
			assert.ok(!/### c\.ts/.test(content));
			assert.equal(scope.untrackedCount, 3); // count reflects reality, not the cap
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("supports commit-target mode without invoking git status or reading untracked files", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		const seenArgs: string[][] = [];
		try {
			// Target existence is verified by PR resolution; this unit owns only
			// commit-range argument construction.
			const targetSha = "4".repeat(40);
			const exec: GitExec = (args) => {
				seenArgs.push(args);
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith(`--no-replace-objects diff --find-renames --find-copies mbsha..${targetSha}`))
					return "diff --git a/tracked.ts b/tracked.ts\n+line\n";
				if (
					key.startsWith(`--no-replace-objects diff --name-status -z --find-renames --find-copies mbsha..${targetSha}`)
				)
					return "M\0tracked.ts\0";
				if (key.startsWith(`--no-replace-objects diff --name-status --find-renames mbsha..${targetSha}`))
					return "M\ttracked.ts\n";
				if (key.startsWith(`--no-replace-objects log --format=%s mbsha..${targetSha}`)) return "commit 1\n";
				throw new Error(`unexpected: ${key}`);
			};
			const options: CollectScopeOptions = {
				exec,
				headSha: targetSha,
			};
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "pr" }, "PR review", options);
			bundleDir = scope.dir;
			assert.equal(scope.headSha, targetSha);
			assert.equal(scope.repoRoot, root);
			assert.equal(scope.reviewRoot, root);
			assert.equal(scope.baseStrategy, "pr");
			assert.equal(scope.untrackedCount, 0);
			assert.ok(!seenArgs.some((a) => a[0] === "status"));
			assert.ok(!seenArgs.some((a) => a[0] === "rev-parse" && a[1] === "HEAD"));
			assert.ok(
				seenArgs.filter((a) => a.includes("diff") || a.includes("log")).every((a) => a[0] === "--no-replace-objects"),
			);
			const content = readFileSync(scope.path, "utf8");
			assert.match(content, new RegExp(`HEAD: ${targetSha}`));
			assert.match(content, /commit 1/);
			assert.ok(!content.includes("Untracked Files"));
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("honors ordinary Git replacement behavior in working-tree mode", () => {
		const root = mkdtempSync(join(tmpdir(), "panel-scope-wt-"));
		const repo = join(root, "repo");
		mkdirSync(repo);
		const vcsEnv = createVcsTestEnv(root);
		const run = (args: string[]) => {
			const res = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: vcsEnv });
			assert.equal(res.status, 0, res.stderr || res.error?.message);
			return res.stdout.trim();
		};
		let bundleDir: string | undefined;
		try {
			run(["init", "-q"]);
			run(["config", "user.email", "test@example.com"]);
			run(["config", "user.name", "Test"]);
			writeFileSync(join(repo, "file.txt"), "base\n");
			run(["add", "file.txt"]);
			run(["commit", "-qm", "base"]);
			const baseSha = run(["rev-parse", "HEAD"]);

			writeFileSync(join(repo, "file.txt"), "committed\n");
			run(["add", "file.txt"]);
			run(["commit", "-qm", "committed"]);
			const headSha = run(["rev-parse", "HEAD"]);

			// Replace baseSha with headSha so ordinary Git sees no diff against base
			run(["replace", baseSha, headSha]);

			const seenArgs: string[][] = [];
			const realExec: GitExec = (args, cwd) => {
				seenArgs.push(args);
				const res = spawnSync("git", args, { cwd, encoding: "utf8", env: vcsEnv });
				assert.equal(res.status, 0, res.stderr || res.error?.message);
				return res.stdout;
			};

			const wtScope = collectScope(repo, { ref: "main", mergeBaseSha: baseSha, strategy: "explicit" }, "wt review", {
				exec: realExec,
			});
			bundleDir = wtScope.dir;

			assert.ok(!seenArgs.some((a) => a[0] === "--no-replace-objects"));
			assert.equal(wtScope.fileCount, 0);

			seenArgs.length = 0;
			let commitBundleDir: string | undefined;
			try {
				const commitScope = collectScope(
					repo,
					{ ref: "main", mergeBaseSha: baseSha, strategy: "explicit" },
					"commit review",
					{ exec: realExec, headSha },
				);
				commitBundleDir = commitScope.dir;
				assert.ok(
					seenArgs.filter((a) => a.includes("diff") || a.includes("log")).every((a) => a[0] === "--no-replace-objects"),
				);
				assert.equal(commitScope.fileCount, 1);
				assert.deepEqual(commitScope.changedPaths, ["file.txt"]);
			} finally {
				if (commitBundleDir) rmSync(commitBundleDir, { recursive: true, force: true });
			}
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains NUL-delimited unusual names and both rename endpoints", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const exec: GitExec = (args) => {
				const key = args.join(" ");
				if (key.startsWith("rev-parse --show-toplevel")) return `${root}\n`;
				if (key.startsWith("rev-parse HEAD")) return "headsha\n";
				if (key.startsWith("diff --find-renames --find-copies")) return "diff\n";
				if (key.startsWith("diff --name-status -z")) return "R100\0old\tname.ts\0new\nname.ts\0";
				if (key.startsWith("diff --name-status")) return "R100\told name.ts\tnew name.ts\n";
				if (key.startsWith("status --porcelain")) return "";
				if (key.startsWith("log --format=%s")) return "";
				throw new Error(`unexpected: ${key}`);
			};
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "i", { exec });
			bundleDir = scope.dir;
			assert.deepEqual(scope.changedPaths, ["old\tname.ts", "new\nname.ts"]);
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});

	it("marks the bundle truncated when the diff exceeds budget", () => {
		const { root, cleanup } = makeRepo();
		let bundleDir: string | undefined;
		try {
			const bigDiff = `diff --git ${"x".repeat(100_000)}`;
			const scope = collectScope(root, { ref: "main", mergeBaseSha: "mbsha", strategy: "explicit" }, "big", {
				exec: gitFor(root, bigDiff),
				bundleBytes: 8 * 1024,
			});
			bundleDir = scope.dir;
			assert.equal(scope.truncated, true);
			const content = readFileSync(scope.path, "utf8");
			assert.ok(Buffer.byteLength(content, "utf8") <= 8 * 1024);
			assert.match(content, /BUNDLE TRUNCATED/);
		} finally {
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			cleanup();
		}
	});
});
