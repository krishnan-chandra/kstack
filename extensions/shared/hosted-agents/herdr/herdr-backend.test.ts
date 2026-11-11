import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHerdrBackend, herdrIntegrationFilePath } from "./herdr-backend.ts";
import { mapHerdrErrorCode } from "./herdr-cli.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("mapHerdrErrorCode", () => {
	it("maps Herdr CLI error codes onto Kstack backend error codes", () => {
		assert.equal(mapHerdrErrorCode("agent_not_found", "missing"), "not_found");
		assert.equal(mapHerdrErrorCode("pane_not_found", "missing"), "not_found");
		assert.equal(mapHerdrErrorCode("agent_pane_busy", "shell busy"), "pane_busy");
		assert.equal(mapHerdrErrorCode("agent_blocked", "blocked"), "agent_blocked");
		assert.equal(mapHerdrErrorCode("agent_not_ready", "waiting"), "agent_blocked");
		assert.equal(mapHerdrErrorCode("agent_prompt_stalled", "stalled"), "prompt_stalled");
		assert.equal(mapHerdrErrorCode("agent_name_in_use", "agent name x already in use"), "name_conflict");
		assert.equal(mapHerdrErrorCode("timeout", "timed out"), "timeout");
		assert.equal(mapHerdrErrorCode("aborted", "cancelled"), "aborted");
		assert.equal(mapHerdrErrorCode("syntax_error", "bad flag"), "protocol_error");
	});
});

describe("createHerdrBackend", () => {
	it("reports the caller's live tab, passes keepFraction directly as --ratio, and resolves findAgentsNamed through agent get", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-herdr-backend-"));
		roots.push(root);
		const env = {
			HERDR_ENV: "1",
			HERDR_WORKSPACE_ID: "w1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_TAB_ID: "w1:tStale",
			PI_CODING_AGENT_DIR: root,
		};
		mkdirSync(join(root, "extensions"), { recursive: true });
		writeFileSync(herdrIntegrationFilePath(env), "");
		const calls: string[][] = [];
		const backend = createHerdrBackend({
			env,
			exec: async (args) => {
				calls.push(args);
				if (args[0] === "status") return { code: 0, stdout: "running\n", stderr: "" };
				if (args[0] === "pane" && args[1] === "layout") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: { type: "pane_layout", layout: { area: { width: 240, height: 60 }, tab_id: "w1:t1" } },
						}),
						stderr: "",
					};
				}
				if (args[0] === "pane" && args[1] === "split") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: { type: "pane_info", pane: { pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "unknown" } },
						}),
						stderr: "",
					};
				}
				if (args[0] === "agent" && args[1] === "get" && args[2] === "missing") {
					return {
						code: 1,
						stdout: "",
						stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
					};
				}
				if (args[0] === "agent" && args[1] === "get") {
					return {
						code: 0,
						stdout: JSON.stringify({
							result: {
								type: "agent_info",
								agent: {
									name: args[2],
									pane_id: "w1:p2",
									tab_id: "w1:t1",
									agent_status: "idle",
									cwd: "/repo",
									agent_session: { kind: "path", value: "/s.jsonl" },
								},
							},
						}),
						stderr: "",
					};
				}
				return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
			},
		});

		const preflight = await backend.preflight();
		assert.deepEqual(preflight, { ok: true, caller: { paneId: "w1:p1", tabId: "w1:t1" } });
		assert.deepEqual(backend.extraPiArgs(), ["-e", herdrIntegrationFilePath(env)]);

		const split = await backend.splitPane({ paneId: "w1:p1", direction: "down", keepFraction: 0.25, cwd: "/repo" });
		assert.deepEqual(split, { ok: true, value: { paneId: "w1:p2", tabId: "w1:t1" } });
		const splitCall = calls.find((call) => call[0] === "pane" && call[1] === "split");
		assert.deepEqual(splitCall, [
			"pane",
			"split",
			"w1:p1",
			"--direction",
			"down",
			"--ratio",
			"0.25",
			"--cwd",
			"/repo",
			"--no-focus",
		]);

		assert.deepEqual(await backend.findAgentsNamed("missing"), { ok: true, value: [] });
		const found = await backend.findAgentsNamed("seat-a");
		assert.equal(found.ok && found.value.length, 1);
	});
});
