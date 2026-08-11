import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildReferenceHandoffPrompt,
	DEFAULT_HANDOFF_GOAL,
	formatHistoryReference,
} from "./handoff-context.ts";

const SESSION_FILE =
	"/Users/x/.pi/agent/sessions/--proj--/2026-08-11T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/Users/x/proj";

describe("formatHistoryReference", () => {
	it("includes file, session id, cwd, and accurate archive lookup guidance", () => {
		const ref = formatHistoryReference(SESSION_FILE, SESSION_ID, CWD);
		assert.ok(ref.includes(`Previous session: ${SESSION_FILE}`));
		assert.ok(ref.includes(`Session ID: ${SESSION_ID}`));
		assert.ok(ref.includes(`CWD: ${CWD}`));
		assert.ok(ref.includes("read_session_archive"));
		assert.ok(ref.includes("search_session_archive"));
		assert.ok(ref.includes("session_id"));
	});
});

describe("buildReferenceHandoffPrompt", () => {
	it("builds a small prompt with the goal and exact reference", () => {
		const ref = formatHistoryReference(SESSION_FILE, SESSION_ID, CWD);
		const prompt = buildReferenceHandoffPrompt("Implement teams support.", ref);
		assert.ok(prompt.includes("## Goal\nImplement teams support."));
		assert.ok(prompt.includes(`## Previous session\n${ref}`));
	});

	it("directs the next agent to inspect history rather than receiving a summary", () => {
		const prompt = buildReferenceHandoffPrompt("Continue.", "REFERENCE");
		assert.ok(prompt.includes("Call read_handoff_history before making changes"));
		assert.ok(prompt.includes("Use search_handoff_history"));
		assert.ok(prompt.includes("what is done, what is pending"));
		assert.ok(!prompt.includes("## Context"));
	});

	it("keeps the default goal focused on the previous resume point", () => {
		assert.ok(DEFAULT_HANDOFF_GOAL.includes("resume point"));
	});
});
