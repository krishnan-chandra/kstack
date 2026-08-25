import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPanelConfirmation } from "./confirmation.ts";
import type { ResolvedReviewTarget } from "./review-target.ts";
import type { ScopeBundle } from "./types.ts";

const scope: ScopeBundle = {
	path: "/tmp/bundle",
	dir: "/tmp",
	repoRoot: "/repo",
	reviewRoot: "/repo",
	headSha: "1".repeat(40),
	baseSha: "2".repeat(40),
	baseRef: "main",
	baseStrategy: "main",
	fileCount: 2,
	diffBytes: 2048,
	untrackedCount: 0,
	binaryCount: 0,
	truncated: false,
	contextFilesTouched: false,
	generatedAt: "now",
};

const common = {
	scope,
	reviewers: [{ label: "one", model: "test/one:medium" }],
	synthesisModel: "test/lead:medium",
	timeoutMinutes: 10,
	maxRuntimeMinutes: 30,
};

describe("buildPanelConfirmation", () => {
	it("describes a standard working-tree review", () => {
		const target: ResolvedReviewTarget = {
			kind: "worktree",
			base: { ref: "main", mergeBaseSha: scope.baseSha, strategy: "main" },
		};
		const message = buildPanelConfirmation({ ...common, target });
		assert.match(message, /Base: main \(22222222, main\)/);
		assert.match(message, /The repository is never modified/);
		assert.ok(!message.includes("PR:"));
	});

	it("describes the immutable PR fetch and warns for a closed PR", () => {
		const target: ResolvedReviewTarget = {
			kind: "pr",
			base: { ref: "main", mergeBaseSha: scope.baseSha, strategy: "pr" },
			pr: {
				number: 42,
				url: "https://github.com/o/r/pull/42",
				title: "Change",
				state: "CLOSED",
				headSha: "3".repeat(40),
				baseRefName: "main",
				mergeBaseSha: scope.baseSha,
			},
		};
		const message = buildPanelConfirmation({ ...common, target });
		assert.match(message, /PR: #42 .* \(state: CLOSED\)/);
		assert.match(message, /working tree and refs are untouched/);
		assert.match(message, /ephemeral snapshot/);
		assert.match(message, /Warning: PR #42 is CLOSED/);
	});
});
