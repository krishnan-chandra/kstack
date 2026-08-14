import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionSelectionModel, selectSessionChoicesWithDialogs } from "./session-selection.ts";

const choices = [
	{ label: "Alpha", session: { path: "/sessions/a.jsonl", id: "a", modified: new Date(0) } },
	{ label: "Beta", session: { path: "/sessions/b.jsonl", id: "b", modified: new Date(0) } },
	{ label: "Gamma", session: { path: "/sessions/c.jsonl", id: "c", modified: new Date(0) } },
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

	it("wraps one-row navigation and clamps page navigation", () => {
		const manyChoices = Array.from({ length: 15 }, (_, index) => ({
			label: `Session ${index}`,
			session: { path: `/sessions/${index}.jsonl`, id: `${index}`, modified: new Date(0) },
		}));
		const model = new SessionSelectionModel(manyChoices);
		model.move(-1);
		assert.equal(model.currentIndex, 14);
		model.move(1);
		assert.equal(model.currentIndex, 0);
		model.move(5);
		model.movePage(-12);
		assert.equal(model.currentIndex, 0);
		model.movePage(12);
		assert.equal(model.currentIndex, 12);
		model.movePage(12);
		assert.equal(model.currentIndex, 14);
	});

	it("uses the focused session when Enter confirms an empty selection", () => {
		const model = new SessionSelectionModel(choices);
		model.move(1);
		assert.deepEqual(model.confirmedChoices().map((choice) => choice.label), ["Beta"]);
		model.toggleCurrent();
		model.move(1);
		assert.deepEqual(model.confirmedChoices().map((choice) => choice.label), ["Beta"]);
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
