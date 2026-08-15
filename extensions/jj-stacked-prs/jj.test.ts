import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJjAdapter, parseBookmarkLines, parseStackCommits } from "./jj.ts";

describe("jj adapters", () => {
	it("parses local bookmark rows and rejects malformed or duplicate output", () => {
		assert.deepEqual(parseBookmarkLines("feat1\tabc\nfeat2\tdef\n"), [
			{ name: "feat1", commitId: "abc" },
			{ name: "feat2", commitId: "def" },
		]);
		assert.throws(() => parseBookmarkLines("feat1"), /Malformed/);
		assert.throws(() => parseBookmarkLines("feat1\tabc\nfeat1\tabc\n"), /Duplicate/);
	});

	it("validates stack JSON and keeps full ids", () => {
		const commits = parseStackCommits(
			'{"change_id":"abcdefghijklmnopqrstuvwxyz","commit_id":"0123456789abcdef0123456789abcdef01234567","subject":"feat","empty":false,"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],"remote_bookmarks":[],"parents":["trunk"]}',
		);
		assert.equal(commits[0].changeId.length, 26);
		assert.equal(commits[0].commitId.length, 40);
		assert.throws(() => parseStackCommits('{"change_id":"a"}'), /missing commit_id/);
	});

	it("quotes bookmark names as exact revsets for mutation", async () => {
		const calls: string[][] = [];
		const adapter = createJjAdapter(async (argv) => {
			calls.push([...argv]);
			return { kind: "ok", code: 0, stdout: "", stderr: "" };
		});
		await adapter.rebaseStack(".", "feat|all()", "abc");
		await adapter.abandonRange(".", "abc", "feat|all()");
		assert.deepEqual(calls, [
			["jj", "rebase", "-b", 'bookmarks(exact:"feat|all()")', "-o", "abc"],
			["jj", "abandon", '(abc)..bookmarks(exact:"feat|all()")'],
		]);
	});

	it("does not treat this repository's current trunk as a fixture", () => {
		const commits = parseStackCommits(
			'{"change_id":"aaa","commit_id":"111","subject":"feat","empty":false,"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],"remote_bookmarks":[],"parents":["independent-trunk"]}',
		);
		assert.equal(commits[0].parentCommitIds[0], "independent-trunk");
		assert.notEqual(commits[0].parentCommitIds[0], "c81cd2b3268964e1dd2767749ace32f6fa03837c");
	});
});
