import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildHandoffConversationText,
	buildHandoffUserMessage,
	DEFAULT_HANDOFF_GOAL,
	estimateConversationTokens,
	formatHistoryReference,
	HANDOFF_SYSTEM_PROMPT,
	type ConversationConverters,
} from "./handoff-context.ts";

const SESSION_FILE = "/Users/x/.pi/agent/sessions/--proj--/2026-08-11T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/Users/x/proj";

/** Fake converters that pass messages through as JSON text. */
const fakeConverters: ConversationConverters = {
	convertToLlm: ((messages: unknown[]) => messages) as ConversationConverters["convertToLlm"],
	serializeConversation: ((messages: unknown[]) =>
		messages.map((m) => JSON.stringify(m)).join("\n")) as ConversationConverters["serializeConversation"],
};

describe("buildHandoffConversationText", () => {
	it("serializes messages through the injected Pi converters", () => {
		const messages = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		];
		const text = buildHandoffConversationText(messages as never, fakeConverters);
		assert.ok(text.includes('"hello"'));
		assert.ok(text.includes('"hi"'));
		assert.equal(text.split("\n").length, 2);
	});

	it("returns empty text for an empty message list", () => {
		assert.equal(buildHandoffConversationText([], fakeConverters), "");
	});
});

describe("formatHistoryReference", () => {
	it("includes file, session id, cwd, and archive lookup guidance", () => {
		const ref = formatHistoryReference(SESSION_FILE, SESSION_ID, CWD);
		assert.ok(ref.includes(`Previous session: ${SESSION_FILE}`));
		assert.ok(ref.includes(`Session ID: ${SESSION_ID}`));
		assert.ok(ref.includes(`CWD: ${CWD}`));
		assert.ok(ref.includes("search_session_archive"));
	});

	it("marks ephemeral sessions as prompt-only history", () => {
		const ref = formatHistoryReference(undefined, SESSION_ID, CWD);
		assert.ok(ref.includes("(ephemeral"));
		assert.ok(ref.includes(SESSION_ID));
		assert.ok(!ref.includes("Lookup:"));
	});
});

describe("buildHandoffUserMessage", () => {
	it("embeds history, reference, and goal", () => {
		const msg = buildHandoffUserMessage("CONVERSATION", "GOAL", "REFERENCE");
		assert.ok(msg.includes("## Conversation History\n\nCONVERSATION"));
		assert.ok(msg.includes("## History Reference\n\nREFERENCE"));
		assert.ok(msg.includes("## User's Goal for New Thread\n\nGOAL"));
	});
});

describe("prompts and estimates", () => {
	it("system prompt requires resume point and verbatim history reference", () => {
		assert.ok(HANDOFF_SYSTEM_PROMPT.includes("resume point"));
		assert.ok(HANDOFF_SYSTEM_PROMPT.includes("verbatim"));
		assert.ok(HANDOFF_SYSTEM_PROMPT.includes("## Previous session"));
	});

	it("default goal names the resume point", () => {
		assert.ok(DEFAULT_HANDOFF_GOAL.includes("resume point"));
	});

	it("estimates tokens at ~4 chars per token", () => {
		assert.equal(estimateConversationTokens(""), 0);
		assert.equal(estimateConversationTokens("abcd"), 1);
		assert.equal(estimateConversationTokens("abcde"), 2);
	});
});
