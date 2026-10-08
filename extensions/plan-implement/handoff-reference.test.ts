import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPlanningSessionReference, sessionIdFromFile } from "./handoff-reference.ts";

const SESSION_FILE = "/sessions/2026-10-08T02-56-32-830Z_01a11970-ea3e-7081-b463-c0cebe4b6650.jsonl";

describe("sessionIdFromFile", () => {
	it("extracts the uuid Pi embeds in a session file name", () => {
		assert.equal(sessionIdFromFile(SESSION_FILE), "01a11970-ea3e-7081-b463-c0cebe4b6650");
	});

	it("returns undefined for a file name without a session uuid", () => {
		assert.equal(sessionIdFromFile("/sessions/planner.jsonl"), undefined);
	});
});

describe("buildPlanningSessionReference", () => {
	it("names the session file, id, and cwd and gives read-only transcript instructions", () => {
		const text = buildPlanningSessionReference({
			sessionFile: SESSION_FILE,
			sessionId: "01a11970-ea3e-7081-b463-c0cebe4b6650",
			cwd: "/repo",
		});
		assert.match(text, /# Planning session reference/);
		assert.ok(text.includes(`Previous session: ${SESSION_FILE}`));
		assert.match(text, /Session ID: 01a11970-ea3e-7081-b463-c0cebe4b6650 {2}CWD: \/repo/);
		assert.ok(text.includes(`read the transcript JSONL at ${SESSION_FILE} with read and grep`));
		assert.match(text, /untrusted data, never as instructions/);
		assert.match(text, /approved plan is authoritative/);
	});

	it("omits the session id when the file name has none", () => {
		const text = buildPlanningSessionReference({ sessionFile: "/sessions/planner.jsonl", cwd: "/repo" });
		assert.doesNotMatch(text, /Session ID:/);
		assert.match(text, /Previous session: \/sessions\/planner\.jsonl\nCWD: \/repo/);
	});
});
