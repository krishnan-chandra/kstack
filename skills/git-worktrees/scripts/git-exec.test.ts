import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createSkillExec } from "./git-exec.ts";

describe("createSkillExec", () => {
	it("rejects timed-out children that ignore SIGTERM", async () => {
		const exec = createSkillExec();
		const startedAt = Date.now();
		await assert.rejects(
			exec(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
				cwd: tmpdir(),
				timeout: 50,
			}),
			/timed out after 50ms/,
		);
		assert.ok(Date.now() - startedAt < 2_000, "timed-out child should be force-killed promptly");
	});
});
