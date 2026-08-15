import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	deriveSlices,
	detectBlockers,
	detectTopBookmark,
	inferUniqueTop,
	parseConcatenatedJson,
	shortenId,
	truncateStack,
} from "./stack.ts";
import type { StackCommit } from "./types.ts";

function commit(overrides: Partial<StackCommit> & Pick<StackCommit, "changeId" | "commitId">): StackCommit {
	return {
		subject: "feat: x",
		bookmarks: [],
		remoteBookmarks: [],
		parentCommitIds: ["trunk"],
		empty: false,
		conflict: false,
		divergent: false,
		merge: false,
		workingCopy: false,
		...overrides,
	};
}

describe("parseConcatenatedJson", () => {
	it("returns an empty list for empty input", () => {
		assert.deepEqual(parseConcatenatedJson(""), []);
	});

	it("parses a single object", () => {
		assert.deepEqual(parseConcatenatedJson('{"a": 1}'), [{ a: 1 }]);
	});

	it("parses concatenated objects", () => {
		assert.deepEqual(parseConcatenatedJson('{"a": 1}{"b": 2}'), [{ a: 1 }, { b: 2 }]);
	});

	it("parses objects that contain nested braces inside strings", () => {
		assert.deepEqual(parseConcatenatedJson('{"subject":"fix } brace"}{"ok":true}'), [
			{ subject: "fix } brace" },
			{ ok: true },
		]);
	});
});

describe("detectTopBookmark", () => {
	it("returns undefined for an empty stack", () => {
		assert.equal(detectTopBookmark([]), undefined);
	});

	it("skips trunk-named bookmarks", () => {
		assert.equal(detectTopBookmark([{ bookmarks: ["main"] }, { bookmarks: ["feature"] }]), "feature");
	});

	it("falls back to a trunk-named bookmark when that is all that exists", () => {
		assert.equal(detectTopBookmark([{ bookmarks: ["main"] }, { bookmarks: ["master"] }]), "master");
	});

	it("returns undefined when no bookmarks exist", () => {
		assert.equal(detectTopBookmark([{ bookmarks: [] }, { bookmarks: [] }]), undefined);
	});
});

describe("inferUniqueTop", () => {
	it("infers a unique non-trunk top", () => {
		const result = inferUniqueTop([
			commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"] }),
			commit({ changeId: "bbb", commitId: "2", bookmarks: ["feat2"] }),
		]);
		assert.deepEqual(result, { top: "feat2" });
	});

	it("allows one empty working-copy child above the inferred top", () => {
		const result = inferUniqueTop([
			commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"] }),
			commit({
				changeId: "wc",
				commitId: "2",
				subject: "",
				empty: true,
				workingCopy: true,
			}),
		]);
		assert.deepEqual(result, { top: "feat1" });
	});

	it("rejects a non-empty unbookmarked tail", () => {
		const result = inferUniqueTop([
			commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"] }),
			commit({ changeId: "tail", commitId: "2", subject: "wip leftover" }),
		]);
		assert.equal("blocker" in result, true);
		if ("blocker" in result) assert.equal(result.blocker.code, "unbookmarked-tail");
	});

	it("reports missing-top when nothing can be inferred", () => {
		const result = inferUniqueTop([commit({ changeId: "aaa", commitId: "1" })]);
		assert.equal("blocker" in result, true);
		if ("blocker" in result) assert.equal(result.blocker.code, "missing-top");
	});
});

describe("deriveSlices", () => {
	it("derives a single bookmarked change", () => {
		const slices = deriveSlices(
			[commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"], subject: "feat: add feature 1" })],
			"feat1",
		);
		assert.deepEqual(slices, [
			{ bookmark: "feat1", baseBookmark: null, changeIds: ["aaa"], subject: "feat: add feature 1" },
		]);
	});

	it("assigns unbookmarked changes to the next bookmark", () => {
		const slices = deriveSlices(
			[
				commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"], subject: "feat: add feature 1" }),
				commit({ changeId: "bbb", commitId: "2", subject: "wip" }),
				commit({ changeId: "ccc", commitId: "3", bookmarks: ["feat2"], subject: "feat: add feature 2" }),
			],
			"feat2",
		);
		assert.equal(slices.length, 2);
		assert.deepEqual(slices[0].changeIds, ["aaa"]);
		assert.equal(slices[0].baseBookmark, null);
		assert.deepEqual(slices[1], {
			bookmark: "feat2",
			baseBookmark: "feat1",
			changeIds: ["bbb", "ccc"],
			subject: "feat: add feature 2",
		});
	});

	it("leaves an unbookmarked tip out of every slice", () => {
		const slices = deriveSlices(
			[
				commit({ changeId: "aaa", commitId: "1", subject: "wip" }),
				commit({ changeId: "bbb", commitId: "2", bookmarks: ["feat1"], subject: "feat: first" }),
				commit({ changeId: "ccc", commitId: "3", subject: "wip2" }),
			],
			"feat1",
		);
		assert.equal(slices.length, 1);
		assert.deepEqual(slices[0].changeIds, ["aaa", "bbb"]);
	});
});

describe("detectBlockers", () => {
	it("flags a conflict", () => {
		const blockers = detectBlockers({
			commits: [commit({ changeId: "aaa", commitId: "aaa123", conflict: true, bookmarks: ["feat1"] })],
			trunkCommit: "trunk",
			topBookmark: "feat1",
		});
		assert.ok(blockers.some((blocker) => blocker.code === "conflict"));
	});

	it("flags an empty bookmarked change that is not the working copy", () => {
		const blockers = detectBlockers({
			commits: [commit({ changeId: "aaa", commitId: "aaa123", empty: true, bookmarks: ["feat1"] })],
			trunkCommit: "trunk",
			topBookmark: "feat1",
		});
		assert.ok(blockers.some((blocker) => blocker.code === "empty-boundary"));
	});

	it("flags a stack that is not rooted at trunk", () => {
		const blockers = detectBlockers({
			commits: [commit({ changeId: "aaa", commitId: "aaa123", bookmarks: ["feat1"], parentCommitIds: ["wrong"] })],
			trunkCommit: "trunk",
			topBookmark: "feat1",
		});
		assert.ok(blockers.some((blocker) => blocker.code === "not-rooted-at-trunk"));
	});

	it("flags an empty stack and a missing top", () => {
		const blockers = detectBlockers({ commits: [], trunkCommit: "trunk", topBookmark: undefined });
		assert.ok(blockers.some((blocker) => blocker.code === "empty-stack"));
		assert.ok(blockers.some((blocker) => blocker.code === "missing-top"));
	});

	it("flags divergence, merges, empty descriptions, and multiple bookmarks", () => {
		const blockers = detectBlockers({
			commits: [
				commit({
					changeId: "aaa",
					commitId: "1",
					divergent: true,
					merge: true,
					subject: "",
					bookmarks: ["feat1", "feat1-alt"],
				}),
			],
			trunkCommit: "trunk",
			topBookmark: "feat1",
		});
		assert.ok(blockers.some((blocker) => blocker.code === "divergence"));
		assert.ok(blockers.some((blocker) => blocker.code === "merge"));
		assert.ok(blockers.some((blocker) => blocker.code === "empty-description"));
		assert.ok(blockers.some((blocker) => blocker.code === "multiple-bookmarks"));
	});

	it("flags a selected top that is not the final boundary", () => {
		const blockers = detectBlockers({
			commits: [
				commit({ changeId: "aaa", commitId: "1", bookmarks: ["feat1"] }),
				commit({ changeId: "bbb", commitId: "2", bookmarks: ["feat2"] }),
			],
			trunkCommit: "trunk",
			topBookmark: "feat1",
		});
		assert.ok(blockers.some((blocker) => blocker.code === "top-not-final-boundary"));
	});
});

describe("rendering helpers", () => {
	it("shortens ids only for display", () => {
		const full = "abcdefghijklmnopqrstuvwxyz";
		assert.equal(shortenId(full, 12), "abcdefghijkl");
		assert.equal(full.length, 26);
	});

	it("truncates a stack at the configured cap", () => {
		const result = truncateStack([1, 2, 3, 4], 2);
		assert.deepEqual(result, { items: [1, 2], truncated: true });
	});
});
