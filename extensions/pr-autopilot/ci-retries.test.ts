import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	appendFlakeRunRetry,
	groupFlakeRuns,
	pendingFlakeRunGroups,
	reconcileLegacyFlakeRetries,
} from "./ci-retries.ts";
import type { CheckRun, FlakeRunRetry } from "./types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function failedCheck(name: string, runId?: string): CheckRun {
	return {
		name,
		status: "failure",
		conclusion: "failure",
		runId,
	};
}

describe("CI run retry identity", () => {
	it("groups eligible checks by run in first-observed order", () => {
		assert.deepEqual(
			groupFlakeRuns(
				[
					failedCheck("unit", "222"),
					failedCheck("build", "111"),
					failedCheck("integration", "222"),
					failedCheck("build", "111"),
				],
				HEAD,
			),
			[
				{ runId: "222", headSha: HEAD, jobNames: ["unit", "integration"] },
				{ runId: "111", headSha: HEAD, jobNames: ["build"] },
			],
		);
	});

	it("keeps separate runs with the same job name independent", () => {
		assert.deepEqual(groupFlakeRuns([failedCheck("test", "111"), failedCheck("test", "222")], HEAD), [
			{ runId: "111", headSha: HEAD, jobNames: ["test"] },
			{ runId: "222", headSha: HEAD, jobNames: ["test"] },
		]);
	});

	it("ignores checks without an Actions run id", () => {
		assert.deepEqual(groupFlakeRuns([failedCheck("external")], HEAD), []);
	});

	it("conservatively maps one legacy name to every matching run", () => {
		const reconciled = reconcileLegacyFlakeRetries({
			checks: [failedCheck("test", "111"), failedCheck("test", "222"), failedCheck("other", "333")],
			headSha: HEAD,
			legacyRetryKeys: [`test@${HEAD}`, "unmatched@another-head"],
			runRetries: [],
		});
		assert.deepEqual(reconciled, {
			runRetries: [
				{ runId: "111", headSha: HEAD },
				{ runId: "222", headSha: HEAD },
			],
			legacyRetryKeys: ["unmatched@another-head"],
			changed: true,
		});
	});

	it("deduplicates exact records while preserving old heads and order", () => {
		const previousHead = "abcdef0123456789abcdef0123456789abcdef01";
		const retries: FlakeRunRetry[] = [
			{ runId: "111", headSha: previousHead },
			{ runId: "111", headSha: previousHead },
		];
		assert.deepEqual(appendFlakeRunRetry(retries, { runId: "111", headSha: HEAD }), [
			{ runId: "111", headSha: previousHead },
			{ runId: "111", headSha: HEAD },
		]);
	});

	it("filters retry groups by both run and head identity", () => {
		const groups = groupFlakeRuns([failedCheck("test", "111"), failedCheck("lint", "222")], HEAD);
		assert.deepEqual(
			pendingFlakeRunGroups(groups, [
				{ runId: "111", headSha: HEAD },
				{ runId: "222", headSha: "another-head" },
			]),
			[{ runId: "222", headSha: HEAD, jobNames: ["lint"] }],
		);
	});
});
