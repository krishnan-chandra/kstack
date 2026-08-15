import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueLandConfirmation } from "./confirmation.ts";
import { routeLand } from "./routing.ts";
import type { LandOptions, LandResult } from "./types.ts";

const options: LandOptions = {
	target: { kind: "single", prNumber: 12 },
	readiness: "watch",
	method: "squash",
};

function singleResult(): LandResult {
	return {
		status: "landed",
		frontiers: [
			{
				prNumber: 12,
				url: "https://example/12",
				expectedHeadSha: "bbb",
				method: "squash",
				state: "landed",
			},
		],
		autopilotRan: true,
		remainingBookmarks: [],
		completedMutations: ["single"],
		blockers: [],
	};
}

describe("routeLand", () => {
	it("routes a selected stacked PR through the complete stack prefix", async () => {
		let ranSingle = false;
		const result = await routeLand(options, {
			backend: "jj",
			requestStackLanding: async () => ({
				handled: true,
				outcome: {
					status: "stack",
					outcome: {
						status: "completed",
						frontiers: [
							{
								bookmark: "feat1",
								prNumber: 11,
								url: "https://example/11",
								expectedHeadSha: "aaa",
								method: "squash",
								state: "landed",
							},
							{
								bookmark: "feat2",
								prNumber: 12,
								url: "https://example/12",
								expectedHeadSha: "bbb",
								method: "squash",
								state: "landed",
							},
						],
						remainingBookmarks: [],
						completedMutations: ["landed 11", "landed 12"],
						recoveryOperationIds: ["op1", "op2"],
					},
				},
			}),
			runSingle: async () => {
				ranSingle = true;
				return singleResult();
			},
		});
		assert.equal(ranSingle, false);
		assert.equal(result.status, "landed");
		assert.deepEqual(
			result.frontiers.map((frontier) => frontier.prNumber),
			[11, 12],
		);
	});

	it("preserves single-PR behavior for Git, non-stacks, and internal stack frontiers", async () => {
		let requests = 0;
		const git = await routeLand(options, {
			backend: "git",
			requestStackLanding: async () => {
				requests++;
				return { handled: true, outcome: { status: "not-stack" } };
			},
			runSingle: async () => singleResult(),
		});
		assert.equal(git.status, "landed");

		const nonStack = await routeLand(options, {
			backend: "jj",
			requestStackLanding: async () => {
				requests++;
				return { handled: true, outcome: { status: "not-stack" } };
			},
			runSingle: async () => singleResult(),
		});
		assert.equal(nonStack.status, "landed");

		const internal = await routeLand(
			{ ...options, confirmation: issueLandConfirmation() },
			{
				backend: "jj",
				requestStackLanding: async () => {
					requests++;
					return { handled: true, outcome: { status: "not-stack" } };
				},
				runSingle: async () => singleResult(),
			},
		);
		assert.equal(internal.status, "landed");
		assert.equal(requests, 1);
	});

	it("blocks rather than risking an individual middle merge when stack detection is unavailable", async () => {
		let ranSingle = false;
		const result = await routeLand(options, {
			backend: "jj",
			requestStackLanding: async () => ({ handled: false }),
			runSingle: async () => {
				ranSingle = true;
				return singleResult();
			},
		});
		assert.equal(ranSingle, false);
		assert.equal(result.status, "blocked");
		assert.match(result.blockers.join("\n"), /jj-stacked-prs extension is unavailable/i);
	});
});
