import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vcsPolicy } from "./policy.ts";

describe("vcsPolicy", () => {
	it("defines terminology for every backend", () => {
		assert.deepEqual(
			(["git", "jj", "graphite"] as const).map((id) => {
				const policy = vcsPolicy(id);
				return [policy.id, policy.refNoun, policy.workstreamNoun, policy.baseUpdateVerb];
			}),
			[
				["git", "branch", "Git checkout", "merge"],
				["jj", "bookmark", "jj workspace", "merge"],
				["graphite", "Graphite branch", "Graphite checkout", "restack"],
			],
		);
	});

	it("injects mutually exclusive mutation guidance", () => {
		assert.match(vcsPolicy("git").childGuidance, /Do not run jj commands/);
		assert.match(vcsPolicy("jj").childGuidance, /Do not run git status, add, commit/);
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
