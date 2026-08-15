import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import { parseJjVersion, preflightVcs } from "./preflight.ts";

const gitRoot: ExecFn = async (command, args) => {
	assert.equal(command, "git");
	assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
	return { code: 0, stdout: "/repo\n", stderr: "" };
};

function fakeExec(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>): ExecFn {
	return async (command, args) => {
		const response = responses[`${command} ${args.join(" ")}`] ?? {};
		return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
	};
}

const validJjResponses = {
	"jj --version": { stdout: "jj 0.44.0\n" },
	"jj workspace root": { stdout: "/repo\n" },
	"git rev-parse --show-toplevel": { stdout: "/repo\n" },
	"jj config get user.name": { stdout: "Example User\n" },
	"jj config get user.email": { stdout: "user@example.com\n" },
};

describe("VCS preflight", () => {
	it("accepts a plain Git working tree", async () => {
		assert.deepEqual(await preflightVcs("/repo/src", "git", gitRoot, { exists: () => false }), {
			ok: true,
			workspaceRoot: "/repo",
		});
	});

	it("refuses Git mutation in a jj-managed workspace", async () => {
		const result = await preflightVcs("/repo", "git", gitRoot, { exists: (path) => path === "/repo/.jj" });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /jj-managed/);
		assert.match(result.ok ? "" : result.error, /skill:setup-kstack/);
	});

	it("rejects a missing Git working tree", async () => {
		const exec: ExecFn = async () => ({ code: 128, stdout: "", stderr: "not a repository" });
		const result = await preflightVcs("/tmp", "git", exec);
		assert.deepEqual(result, { ok: false, error: "The git backend requires a Git working tree." });
	});

	it("turns a missing Git executable into a preflight error", async () => {
		const exec: ExecFn = async () => {
			throw new Error("spawn git ENOENT");
		};
		const result = await preflightVcs("/tmp", "git", exec);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /ENOENT/);
	});

	it("accepts jj 0.44 in a colocated workspace with an identity", async () => {
		assert.deepEqual(await preflightVcs("/repo/src", "jj", fakeExec(validJjResponses)), {
			ok: true,
			workspaceRoot: "/repo",
		});
	});

	it("rejects old jj versions", async () => {
		const result = await preflightVcs("/repo", "jj", fakeExec({ "jj --version": { stdout: "jj 0.43.1\n" } }));
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /jj >= 0\.44/);
	});

	it("rejects a jj workspace nested in a different Git worktree", async () => {
		const result = await preflightVcs(
			"/repo",
			"jj",
			fakeExec({ ...validJjResponses, "git rev-parse --show-toplevel": { stdout: "/outer\n" } }),
		);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /differ/);
	});

	it("requires the jj user identity", async () => {
		const result = await preflightVcs(
			"/repo",
			"jj",
			fakeExec({ ...validJjResponses, "jj config get user.email": { code: 1, stderr: "not found" } }),
		);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /jj config set --user user\.email/);
	});

	it("turns later jj spawn failures into preflight errors", async () => {
		const exec: ExecFn = async (command, args) => {
			if (command === "jj" && args[0] === "--version") {
				return { code: 0, stdout: "jj 0.44.0\n", stderr: "" };
			}
			throw new Error(`spawn ${command} ${args.join(" ")} EACCES`);
		};
		const result = await preflightVcs("/repo", "jj", exec);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /EACCES/);
	});
});

describe("parseJjVersion", () => {
	it("parses release and platform-suffixed output", () => {
		assert.deepEqual(parseJjVersion("jj 0.44.0-aarch64-apple-darwin"), [0, 44]);
	});

	it("rejects output without a dotted numeric version", () => {
		assert.equal(parseJjVersion("Jujutsu nightly"), null);
	});
});
