import assert from "node:assert/strict";
import test from "node:test";
import { runHostedPhase } from "./hosted-phase.ts";

function effects(events: string[], options: { current?: boolean; controller?: AbortController } = {}) {
	const controller = options.controller ?? new AbortController();
	return {
		beginRole: () => {
			events.push("begin");
			return controller;
		},
		endRole: (ended: AbortController) => {
			assert.equal(ended, controller);
			events.push("end");
		},
		isCurrent: () => options.current ?? true,
		setStatus: (status: string | undefined) => events.push(status ?? "clear"),
	};
}

test("runs with the owned signal and cleans up in order", async () => {
	const events: string[] = [];
	const controller = new AbortController();
	const outcome = await runHostedPhase(effects(events, { controller }), {
		phase: "planning",
		status: "planning",
		run: async (signal) => {
			assert.equal(signal, controller.signal);
			events.push("run");
			return 42;
		},
	});

	assert.deepEqual(outcome, { status: "ran", value: 42 });
	assert.deepEqual(events, ["begin", "planning", "run", "end", "clear"]);
});

test("does not run when role ownership is unavailable", async () => {
	const events: string[] = [];
	const outcome = await runHostedPhase(
		{
			...effects(events),
			beginRole: () => undefined,
		},
		{
			phase: "fixing",
			status: "fixing",
			run: async () => {
				throw new Error("must not run");
			},
		},
	);

	assert.deepEqual(outcome, { status: "unavailable" });
	assert.deepEqual(events, []);
});

test("releases ownership after an exception", async () => {
	const events: string[] = [];
	await assert.rejects(
		runHostedPhase(effects(events), {
			phase: "publishing",
			status: "publishing",
			run: async () => {
				events.push("throw");
				throw new Error("boom");
			},
		}),
		/boom/,
	);
	assert.deepEqual(events, ["begin", "publishing", "throw", "end", "clear"]);
});

test("does not clear status through a stale session", async () => {
	const events: string[] = [];
	await runHostedPhase(effects(events, { current: false }), {
		phase: "implementing",
		status: "implementing",
		run: async () => "done",
	});
	assert.deepEqual(events, ["begin", "implementing", "end"]);
});
