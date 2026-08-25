import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitExec } from "./review-scope.ts";
import {
	buildIntentPrefill,
	noChangesMessage,
	type ResolvedReviewTarget,
	resolveReviewTarget,
} from "./review-target.ts";
import type { ScopeBundle } from "./types.ts";

const SHA = "1".repeat(40);
const scope: ScopeBundle = {
	path: "/tmp/bundle",
	dir: "/tmp",
	repoRoot: "/repo",
	reviewRoot: "/repo",
	headSha: SHA,
	baseSha: SHA,
	baseRef: "main",
	baseStrategy: "main",
	fileCount: 1,
	diffBytes: 1,
	untrackedCount: 0,
	binaryCount: 0,
	truncated: false,
	contextFilesTouched: false,
	generatedAt: "now",
};

const worktreeTarget: ResolvedReviewTarget = {
	kind: "worktree",
	base: { ref: "main", mergeBaseSha: SHA, strategy: "explicit" },
};

const prTarget: ResolvedReviewTarget = {
	kind: "pr",
	base: { ref: "main", mergeBaseSha: SHA, strategy: "pr" },
	pr: {
		number: 42,
		url: "https://github.com/o/r/pull/42",
		title: "Change",
		state: "OPEN",
		headSha: "2".repeat(40),
		baseRefName: "main",
		mergeBaseSha: SHA,
	},
};

describe("review target helpers", () => {
	it("resolves the standard base without invoking the PR executor", async () => {
		const gitExec: GitExec = (args) => {
			const key = args.join(" ");
			if (key === "rev-parse --verify main^{commit}") return `${SHA}\n`;
			if (key === "merge-base main HEAD") return `${SHA}\n`;
			if (key.startsWith("rev-parse --abbrev-ref")) throw new Error("no upstream");
			throw new Error(`unexpected git call: ${key}`);
		};
		const target = await resolveReviewTarget(
			async () => {
				throw new Error("PR executor must not run");
			},
			gitExec,
			"/repo",
			{ base: "main" },
		);
		assert.deepEqual(target, worktreeTarget);
	});

	it("builds mode-specific editor prefills", () => {
		const gitExec: GitExec = (args) => (args.at(-1)?.endsWith("HEAD") ? "local change\n" : "PR change\n");
		assert.match(buildIntentPrefill(worktreeTarget, gitExec, "/repo"), /Review these changes:\nlocal change/);
		assert.match(buildIntentPrefill(prTarget, gitExec, "/repo"), /Review PR #42: Change\n\nCommits in PR:\nPR change/);
	});

	it("builds mode-specific no-change messages", () => {
		assert.match(noChangesMessage(worktreeTarget, scope), /Commit, stage, or modify files/);
		assert.match(noChangesMessage(prTarget, scope), /No reviewable changes for PR #42/);
	});
});
