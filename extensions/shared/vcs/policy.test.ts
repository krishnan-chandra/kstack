import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vcsPolicy } from "./policy.ts";

describe("vcsPolicy", () => {
	it("defines terminology for every backend", () => {
		assert.deepEqual(
			(["git", "jj", "graphite"] as const).map((id) => {
				const policy = vcsPolicy(id);
				return [policy.id, policy.workstreamNoun, policy.baseUpdateVerb];
			}),
			[
				["git", "Git checkout", "merge"],
				["jj", "jj workspace", "merge"],
				["graphite", "Graphite checkout", "restack"],
			],
		);
	});

	it("keeps child guidance inspection-only so the parent owns recording", () => {
		for (const id of ["git", "jj", "graphite"] as const) {
			const guidance = vcsPolicy(id).childGuidance;
			assert.match(guidance, /only to inspect/);
			assert.doesNotMatch(guidance, /Make incremental|Record work with/);
		}
	});

	it("formats remote bases for the selected backend", () => {
		assert.equal(vcsPolicy("git").remoteBaseDisplay("main"), "origin/main");
		assert.equal(vcsPolicy("jj").remoteBaseDisplay("main"), "main@origin");
	});

	it("describes Graphite restacks and rewrite risk", () => {
		const policy = vcsPolicy("graphite");
		assert.equal(policy.baseUpdateVerb, "restack");
		assert.match(policy.fixPublicationDisclosure, /rewrite/i);
	});
});
