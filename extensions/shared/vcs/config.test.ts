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
	it("defaults a missing section to git without a warning", () => {
		const dir = configDir('{"panel-review":{}}');
		assert.deepEqual(loadVcsBackend({ PI_CODING_AGENT_DIR: dir }), {
			backend: "git",
			warnings: [],
		});
	});

	it("loads git, jj, and graphite", () => {
		for (const backend of ["git", "jj", "graphite"] as const) {
			const dir = configDir(JSON.stringify({ vcs: { backend } }));
			assert.equal(loadVcsBackend({ PI_CODING_AGENT_DIR: dir }).backend, backend);
		}
	});

	it("defaults malformed sections and documents to git with a warning", () => {
		for (const contents of ['{"vcs":{"backend":"svn"}}', '{"vcs":[]}', "{"]) {
			const result = loadVcsBackend({ PI_CODING_AGENT_DIR: configDir(contents) });
			assert.equal(result.backend, "git");
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /Defaulting to the git backend/);
		}
	});
});
