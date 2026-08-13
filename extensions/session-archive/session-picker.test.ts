import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionSelectionModel, selectSessionChoicesWithDialogs } from "./session-selection.ts";

const choices = [
	{ label: "Alpha", session: { path: "/sessions/a.jsonl" } },
	{ label: "Beta", session: { path: "/sessions/b.jsonl" } },
	{ label: "Gamma", session: { path: "/sessions/c.jsonl" } },
];

describe("SessionSelectionModel", () => {
	it("toggles any subset and returns it in picker order", () => {
		const model = new SessionSelectionModel(choices);
		model.move(2);
		model.toggleCurrent();
		model.move(-1);
		model.toggleCurrent();
		assert.deepEqual(model.selectedChoices().map((choice) => choice.label), ["Beta", "Gamma"]);
		model.toggleCurrent();
		assert.deepEqual(model.selectedChoices().map((choice) => choice.label), ["Gamma"]);
	});

	it("wraps navigation and exposes the current row", () => {
		const model = new SessionSelectionModel(choices);
		model.move(-1);
		assert.equal(model.currentIndex, 2);
		model.move(1);
		assert.equal(model.currentIndex, 0);
		model.move(-12);
		assert.equal(model.currentIndex, 0);
	});
});

describe("RPC session multi-selection", () => {
	it("collects multiple choices before explicit completion", async () => {
		const answers = ["Beta", "Alpha", "Archive selected (2)"];
		const selected = await selectSessionChoicesWithDialogs(choices, async () => answers.shift());
		assert.deepEqual(selected?.map((choice) => choice.label), ["Alpha", "Beta"]);
	});

	it("cancels without a selection and finishes when every choice is selected", async () => {
		assert.equal(await selectSessionChoicesWithDialogs(choices, async () => undefined), undefined);
		const answers = ["Alpha", "Beta", "Gamma"];
		const selected = await selectSessionChoicesWithDialogs(choices, async () => answers.shift());
		assert.deepEqual(selected?.map((choice) => choice.label), ["Alpha", "Beta", "Gamma"]);
	});
});
