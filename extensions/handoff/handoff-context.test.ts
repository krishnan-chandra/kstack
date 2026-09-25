import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReferenceHandoffPrompt, DEFAULT_HANDOFF_GOAL, formatHistoryReference } from "./handoff-context.ts";
import type { HistoryAccess } from "./history-access.ts";

const SESSION_FILE =
	"/Users/x/.pi/agent/sessions/--proj--/2026-08-11T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/Users/x/proj";
const FULL: HistoryAccess = { kind: "handoff", search: true };

describe("formatHistoryReference", () => {
	it("includes file, session id, cwd, and handoff-tool-only lookup guidance", () => {
		const ref = formatHistoryReference(SESSION_FILE, SESSION_ID, CWD, FULL);
		assert.ok(ref.includes(`Previous session: ${SESSION_FILE}`));
		assert.ok(ref.includes(`Session ID: ${SESSION_ID}`));
		assert.ok(ref.includes(`CWD: ${CWD}`));
		assert.ok(ref.includes("read_handoff_history and search_handoff_history"));
		assert.ok(ref.includes("active or archived storage automatically"));
		assert.ok(ref.includes("do not open the session file directly"));
		assert.ok(!ref.includes("read_session_archive"));
		assert.ok(!ref.includes("search_session_archive"));
	});
});

describe("buildReferenceHandoffPrompt", () => {
	it("builds a small prompt with the goal and exact reference", () => {
		const ref = formatHistoryReference(SESSION_FILE, SESSION_ID, CWD, FULL);
		const prompt = buildReferenceHandoffPrompt("Implement teams support.", ref, FULL);
		assert.ok(prompt.includes("## Goal\nImplement teams support."));
		assert.ok(prompt.includes(`## Previous session\n${ref}`));
	});

	it("directs the next agent to read the outline first rather than receiving a summary", () => {
		const prompt = buildReferenceHandoffPrompt("Continue.", "REFERENCE", FULL);
		assert.ok(prompt.includes("Call read_handoff_history first, with no arguments"));
		assert.ok(prompt.includes("default outline maps the whole previous session"));
		assert.ok(prompt.includes('read_handoff_history({ view: "entries", offset, limit })'));
		assert.ok(prompt.includes("Use search_handoff_history"));
		assert.ok(prompt.includes("what is done, what is pending"));
		assert.ok(!prompt.includes("## Context"));
	});

	it("keeps the default goal focused on the previous resume point", () => {
		assert.ok(DEFAULT_HANDOFF_GOAL.includes("resume point"));
	});
});
