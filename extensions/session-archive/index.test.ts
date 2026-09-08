import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionArchiveExtension from "./index.ts";

interface RegisteredTool {
	name: string;
	description: string;
}

describe("session archive retained-history registration", () => {
	it("registers both retained-history tools without touching the cache during module load", async () => {
		const temp = mkdtempSync(join(tmpdir(), "kstack-subagent-history-index-"));
		const prior = process.env.PI_CODING_AGENT_DIR;
		const tools: RegisteredTool[] = [];
		const events: string[] = [];
		const commands: string[] = [];
		try {
			process.env.PI_CODING_AGENT_DIR = temp;
			const fake: Partial<ExtensionAPI> = {
				on(name) {
					events.push(name);
				},
				registerCommand(name) {
					commands.push(name);
				},
				registerTool(tool) {
					tools.push({ name: tool.name, description: tool.description });
				},
			};
			await sessionArchiveExtension(
				/* SAFETY: This test controls the fixture and exercises only extension registration. */ fake as ExtensionAPI,
			);
			assert.ok(commands.includes("session-archive"));
			assert.ok(events.includes("session_start"));
			assert.deepEqual(
				tools.map((tool) => tool.name),
				["search_session_archive", "read_session_archive", "search_subagent_history", "read_subagent_history"],
			);
			const search = tools.find((tool) => tool.name === "search_subagent_history");
			const read = tools.find((tool) => tool.name === "read_subagent_history");
			assert.match(search?.description ?? "", /read-only|read only/i);
			assert.match(search?.description ?? "", /refreshes on demand/);
			assert.match(read?.description ?? "", /exact UUID/);
			assert.equal(existsSync(join(temp, "archive")), false, "factory load must not initialize the archive");
			assert.equal(existsSync(join(temp, "cache")), false, "factory load must not initialize child-history cache");
		} finally {
			if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prior;
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
