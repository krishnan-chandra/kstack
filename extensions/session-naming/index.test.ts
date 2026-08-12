import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { createSessionNamingHandler } from "./index.ts";
import { handoffSessionName, normalizeSessionName, suggestSessionName } from "./names.ts";

const interactiveEvent: InputEvent = {
	type: "input",
	text: "Implement named session archiving",
	source: "interactive",
};

function makeHarness(options: {
	currentName?: string;
	sessionFile?: string;
	inputResult?: string | undefined;
	hasUI?: boolean;
	setError?: Error;
} = {}) {
	const names: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const api = {
		getSessionName: () => options.currentName,
		setSessionName: (name: string) => {
			if (options.setError) throw options.setError;
			names.push(name);
		},
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/sessions/current.jsonl"),
			getSessionId: () => "019ff703-37d4-7293-9432-5dd500034c03",
		},
		ui: {
			input: async () => options.inputResult,
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	return { handler: createSessionNamingHandler(api), ctx, names, notifications };
}

describe("session name suggestions", () => {
	it("prefers the handoff goal over boilerplate", () => {
		assert.equal(
			suggestSessionName("Continue work from the previous Pi session.\n\n## Goal\nFix archive selection\n\n## Instructions"),
			"Fix archive selection",
		);
	});

	it("normalizes whitespace and truncates long names", () => {
		assert.equal(normalizeSessionName("  Fix   archive\n picker "), "Fix archive picker");
		assert.equal(Array.from(normalizeSessionName("x".repeat(100))).length, 80);
		assert.ok(normalizeSessionName("x".repeat(100)).endsWith("…"));
	});

	it("uses the parent name for a default handoff goal", () => {
		assert.equal(
			handoffSessionName("Continue work", "Continue work", "Named archive flow"),
			"Named archive flow — continued",
		);
		assert.equal(handoffSessionName("Fix flaky tests", "Continue work", "Old work"), "Fix flaky tests");
	});
});

describe("session naming input handler", () => {
	it("uses an explicit interactive name before allowing the prompt", async () => {
		const harness = makeHarness({ inputResult: "  Archive picker cleanup  " });
		assert.deepEqual(await harness.handler(interactiveEvent, harness.ctx as never), { action: "continue" });
		assert.deepEqual(harness.names, ["Archive picker cleanup"]);
	});

	it("uses the suggested name when the user submits an empty value", async () => {
		const harness = makeHarness({ inputResult: "" });
		await harness.handler(interactiveEvent, harness.ctx as never);
		assert.deepEqual(harness.names, ["Implement named session archiving"]);
	});

	it("suppresses the prompt when naming is cancelled", async () => {
		const harness = makeHarness({ inputResult: undefined });
		assert.deepEqual(await harness.handler(interactiveEvent, harness.ctx as never), { action: "handled" });
		assert.deepEqual(harness.names, []);
		assert.match(harness.notifications[0].message, /Prompt not sent/);
	});

	it("automatically names extension input when no dialog is available", async () => {
		const harness = makeHarness({ hasUI: false });
		const event = { ...interactiveEvent, source: "extension" as const };
		assert.deepEqual(await harness.handler(event, harness.ctx as never), { action: "continue" });
		assert.deepEqual(harness.names, ["Implement named session archiving"]);
	});

	it("does not rename existing or ephemeral sessions", async () => {
		for (const options of [{ currentName: "Already named" }, { sessionFile: undefined }]) {
			const harness = makeHarness(options);
			assert.deepEqual(await harness.handler(interactiveEvent, harness.ctx as never), { action: "continue" });
			assert.deepEqual(harness.names, []);
		}
	});

	it("suppresses the prompt if persistence fails", async () => {
		const harness = makeHarness({ inputResult: "Archive", setError: new Error("disk full") });
		assert.deepEqual(await harness.handler(interactiveEvent, harness.ctx as never), { action: "handled" });
		assert.match(harness.notifications[0].message, /disk full/);
	});
});
