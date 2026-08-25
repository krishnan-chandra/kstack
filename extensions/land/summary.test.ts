import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLandResult } from "./summary.ts";
import type { FrontierResult, LandResult } from "./types.ts";

function result(status: LandResult["status"], frontiers: FrontierResult[] = []): LandResult {
	return {
		status,
		frontiers,
		autopilotRan: false,
		remainingRefs: [],
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

test("includes the first blocker when a blocked result has frontiers", () => {
	const blocked = result("blocked", [{ ...pr105, state: "blocked" }]);
	blocked.blockers = ["CI checks are still pending."];
	assert.equal(summarizeLandResult(blocked), "Did not land PR #105. CI checks are still pending.");
});

test("includes the blocker for a partially landed blocked frontier", () => {
	const partial = result("partially-landed", [{ ...pr105, state: "blocked" }]);
	partial.blockers = ["Watch is bounded. Retry after CI settles."];
	assert.equal(summarizeLandResult(partial), "#105 blocked. Watch is bounded. Retry after CI settles.");
});

test("keeps bounded-watch recovery visible in the collapsed result", () => {
	const blocked = result("blocked");
	blocked.blockers = [
		"CI still pending after watch. Watch is bounded. Inspect PR #105, then retry /land after CI settles.",
	];
	assert.equal(summarizeLandResult(blocked), blocked.blockers[0]);
});
