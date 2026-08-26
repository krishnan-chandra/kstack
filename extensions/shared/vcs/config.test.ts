import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadVcsBackend } from "./config.ts";

function configDir(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kstack-vcs-config-"));
	if (contents !== undefined) writeFileSync(join(dir, "kstack.json"), contents);
	return dir;
}

describe("VCS backend config", () => {
	it("defaults a missing section to Git with GitHub stacks", () => {
		const dir = configDir('{"panel-review":{}}');
		assert.deepEqual(loadVcsBackend({ PI_CODING_AGENT_DIR: dir }), {
			backend: "git",
			gitStackProvider: "github",
			warnings: [],
		});
	});

	it("loads every backend and Git stack-provider choice", () => {
		for (const backend of ["git", "jj", "graphite"] as const) {
			const loaded = loadVcsBackend({ PI_CODING_AGENT_DIR: configDir(JSON.stringify({ vcs: { backend } })) });
			assert.equal(loaded.backend, backend);
			if (loaded.backend === "git") assert.equal(loaded.gitStackProvider, "github");
			else assert.equal("gitStackProvider" in loaded, false);
		}
		const none = loadVcsBackend({
			PI_CODING_AGENT_DIR: configDir(JSON.stringify({ vcs: { backend: "git", stackProvider: "none" } })),
		});
		assert.equal(none.backend, "git");
		if (none.backend === "git") assert.equal(none.gitStackProvider, "none");
	});

	it("warns and defaults invalid Git stack providers", () => {
		const result = loadVcsBackend({
			PI_CODING_AGENT_DIR: configDir(JSON.stringify({ vcs: { backend: "git", stackProvider: "jj" } })),
		});
		assert.equal(result.backend, "git");
		if (result.backend === "git") assert.equal(result.gitStackProvider, "github");
		assert.match(result.warnings[0], /stackProvider.*github.*none/);
	});

	it("warns and ignores the key for fixed-provider backends", () => {
		for (const backend of ["jj", "graphite"] as const) {
			const result = loadVcsBackend({
				PI_CODING_AGENT_DIR: configDir(JSON.stringify({ vcs: { backend, stackProvider: "none" } })),
			});
			assert.match(result.warnings[0], new RegExp(`${backend} backend always uses the ${backend} stack provider`));
		}
	});

	it("defaults malformed sections and documents to Git with a warning", () => {
		for (const contents of ['{"vcs":{"backend":"svn"}}', '{"vcs":[]}', "{"]) {
			const result = loadVcsBackend({ PI_CODING_AGENT_DIR: configDir(contents) });
			assert.equal(result.backend, "git");
			if (result.backend === "git") assert.equal(result.gitStackProvider, "github");
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /Defaulting to the git backend/);
		}
	});
});
