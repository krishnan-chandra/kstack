import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepositorySource } from "./repository-source.ts";
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
	changedPaths: ["tracked.ts"],
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

function source(layout: RepositorySource["layout"], git: GitExec, githubRepository?: string): RepositorySource {
	return {
		root: "/repo",
		layout,
		gitDir: layout === "git-worktree" ? undefined : "/store",
		git,
		exec: async () => {
			throw new Error("async executor must not run");
		},
		githubRepository,
	};
}

const prJson = {
	number: 42,
	url: "https://github.com/o/r/pull/42",
	title: "Change",
	state: "OPEN",
	headRefOid: "2".repeat(40),
	baseRefName: "main",
	baseRefOid: SHA,
};

describe("review target helpers", () => {
	it("resolves the standard base in a Git worktree without invoking the PR executor", async () => {
		const gitExec: GitExec = (args) => {
			const key = args.join(" ");
			if (key === "rev-parse --verify main^{commit}") return `${SHA}\n`;
			if (key === "merge-base main HEAD") return `${SHA}\n`;
			if (key.startsWith("rev-parse --abbrev-ref")) throw new Error("no upstream");
			throw new Error(`unexpected git call: ${key}`);
		};
		const resolution = await resolveReviewTarget(source("git-worktree", gitExec), { base: "main" });
		assert.deepEqual(resolution, { target: worktreeTarget, warnings: [] });
	});

	it("pins the jj working copy in a jj workspace and surfaces base warnings", async () => {
		const head = "3".repeat(40);
		const gitExec: GitExec = (args) => {
			if (args[0] === "merge-base") return `${SHA}\n`;
			throw new Error(`unexpected git call: ${args.join(" ")}`);
		};
		const commandExec = (command: string, args: string[]) => {
			const key = `${command} ${args.join(" ")}`;
			if (key.includes("conflicts() & @")) return "";
			if (key.includes("-r @ ")) return `${head}\n`;
			if (key.includes("-r trunk()")) return `${"0".repeat(40)}\n`;
			if (key.includes("present(main)")) return SHA;
			throw new Error(`unexpected command: ${key}`);
		};
		const resolution = await resolveReviewTarget(source("jj-workspace", gitExec), {}, { commandExec });
		assert.deepEqual(resolution.target, {
			kind: "jj",
			headSha: head,
			base: { ref: "main", mergeBaseSha: SHA, strategy: "main" },
		});
		assert.equal(resolution.warnings.length, 1);
	});

	it("resolves a PR through gh -R and the source object store from any layout", async () => {
		const seen: string[][] = [];
		const store: RepositorySource = {
			...source("jj-workspace", () => "", "acme/widgets"),
			exec: async (command, args) => {
				seen.push([command, ...args]);
				if (command === "gh") return { code: 0, stdout: JSON.stringify(prJson), stderr: "" };
				if (args[0] === "merge-base") return { code: 0, stdout: `${SHA}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		const resolution = await resolveReviewTarget(store, { pr: 42 });
		assert.equal(resolution.target.kind, "pr");
		assert.deepEqual(seen[0], [
			"gh",
			"pr",
			"view",
			"42",
			"-R",
			"acme/widgets",
			"--json",
			"number,url,title,state,baseRefName,headRefOid,baseRefOid",
		]);
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
