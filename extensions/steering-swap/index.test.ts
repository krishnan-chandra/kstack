import assert from "node:assert/strict";
import test from "node:test";

import { applySwap, decideSwap, type SwapHost } from "./index.ts";

function host(options: { text: string; disableSubmit?: boolean; followUpHandler?: () => void }) {
	let editorText = options.text;
	const submitted: string[] = [];
	const handlers = new Map<string, () => void>();
	if (options.followUpHandler) {
		handlers.set("app.message.followUp", options.followUpHandler);
	}
	const swapHost = {
		disableSubmit: options.disableSubmit ?? false,
		getText: () => editorText,
		getExpandedText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
		onSubmit: (text: string) => {
			submitted.push(text);
		},
		actionHandlers: handlers,
	} as SwapHost;

	return { swapHost, submitted, getEditorText: () => editorText };
}

test("swaps submit and follow-up only while busy without autocomplete", () => {
	const base = { busy: true, autocompleteOpen: false, matchesSubmit: false, matchesFollowUp: false };

	assert.equal(decideSwap({ ...base, matchesSubmit: true }), "queueFollowUp");
	assert.equal(decideSwap({ ...base, matchesFollowUp: true }), "steer");
	assert.equal(decideSwap(base), "passthrough");
});

test("passes through when idle, so submit and autocomplete keep stock behavior", () => {
	const base = { busy: false, autocompleteOpen: false, matchesSubmit: false, matchesFollowUp: false };

	assert.equal(decideSwap({ ...base, matchesSubmit: true }), "passthrough");
	assert.equal(decideSwap({ ...base, matchesFollowUp: true }), "passthrough");
});

test("passes through while the autocomplete popup is open", () => {
	const base = { busy: true, autocompleteOpen: true, matchesSubmit: false, matchesFollowUp: false };

	assert.equal(decideSwap({ ...base, matchesSubmit: true }), "passthrough");
	assert.equal(decideSwap({ ...base, matchesFollowUp: true }), "passthrough");
});

test("passes through when one key is bound to both actions", () => {
	assert.equal(
		decideSwap({ busy: true, autocompleteOpen: false, matchesSubmit: true, matchesFollowUp: true }),
		"passthrough",
	);
});

test("queueFollowUp invokes Pi's native follow-up handler without touching the editor", () => {
	let followUps = 0;
	const editor = host({ text: "queued question", followUpHandler: () => followUps++ });

	assert.equal(applySwap(editor.swapHost, "queueFollowUp"), true);
	assert.equal(followUps, 1);
	// The native handler reads and clears the editor itself.
	assert.equal(editor.getEditorText(), "queued question");
	assert.deepEqual(editor.submitted, []);
});

test("queueFollowUp falls through when the native handler is not yet registered", () => {
	const editor = host({ text: "too early" });

	assert.equal(applySwap(editor.swapHost, "queueFollowUp"), false);
	assert.equal(editor.getEditorText(), "too early");
});

test("steer clears the editor and routes through Pi's native submit path", () => {
	const editor = host({ text: "  change direction\n" });

	assert.equal(applySwap(editor.swapHost, "steer"), true);
	assert.deepEqual(editor.submitted, ["change direction"]);
	assert.equal(editor.getEditorText(), "");
});

test("steer consumes but ignores blank text and disabled submit", () => {
	const blank = host({ text: " \n " });
	assert.equal(applySwap(blank.swapHost, "steer"), true);
	assert.deepEqual(blank.submitted, []);
	assert.equal(blank.getEditorText(), " \n ");

	const disabled = host({ text: "keep me", disableSubmit: true });
	assert.equal(applySwap(disabled.swapHost, "steer"), true);
	assert.deepEqual(disabled.submitted, []);
	assert.equal(disabled.getEditorText(), "keep me");
});

test("passthrough consumes nothing", () => {
	const editor = host({ text: "hello" });

	assert.equal(applySwap(editor.swapHost, "passthrough"), false);
	assert.equal(editor.getEditorText(), "hello");
	assert.deepEqual(editor.submitted, []);
});
