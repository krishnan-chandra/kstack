import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "../shared/github.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { createJjGitHubGateway } from "./github-gateway.ts";

const repository = { owner: "o", repo: "r" };

describe("createJjGitHubGateway", () => {
	it("preserves conclusive process failures", async () => {
		const gateway = createJjGitHubGateway(async () => ({ kind: "spawn-failed", message: "gh is unavailable" }));

		await assert.rejects(
			gateway.getDefaultBranch(repository, "."),
			(error: BoundaryValue) => error instanceof GitHubError && error.kind === "failed",
		);
	});

	it("preserves indeterminate process failures", async () => {
		const gateway = createJjGitHubGateway(async () => ({
			kind: "uncertain",
			message: "process ended without a status",
			stdout: "",
			stderr: "",
		}));

		await assert.rejects(
			gateway.getDefaultBranch(repository, "."),
			(error: BoundaryValue) => error instanceof GitHubError && error.kind === "indeterminate",
		);
	});
});
