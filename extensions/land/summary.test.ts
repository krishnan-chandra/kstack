import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLandResult } from "./summary.ts";
import type { FrontierResult, LandResult } from "./types.ts";

function result(status: LandResult["status"], frontiers: FrontierResult[] = []): LandResult {
	return {
		status,
		frontiers,
		autopilotRan: false,
		remainingBookmarks: [],
		completedMutations: [],
		blockers: [],
	};
}

const pr105: FrontierResult = {
	prNumber: 105,
	url: "https://example.test/105",
	expectedHeadSha: "abc",
	method: "squash",
	state: "landed",
};

const pr106: FrontierResult = { ...pr105, prNumber: 106, url: "https://example.test/106", state: "queued" };

test("names the landed pull request instead of counting frontiers", () => {
	const summary = summarizeLandResult(result("landed", [pr105]));
	assert.equal(summary, "Landed PR #105.");
	assert.doesNotMatch(summary, /frontier/i);
	assert.doesNotMatch(summary, /\$\{/);
});

test("names stacked pull requests that GitHub accepted", () => {
	const summary = summarizeLandResult(result("partially-landed", [pr105, pr106]));
	assert.equal(summary, "#105 merged. #106 accepted, waiting for GitHub.");
	assert.doesNotMatch(summary, /frontier/i);
});

test("says GitHub accepted a single unverified pull request", () => {
	const summary = summarizeLandResult(result("partially-landed", [{ ...pr105, state: "queued" }]));
	assert.equal(summary, "GitHub accepted PR #105. Waiting to verify the merge.");
});

test("describes a blocked run with no selected pull request", () => {
	assert.equal(summarizeLandResult(result("blocked")), "Did not land a pull request.");
});
