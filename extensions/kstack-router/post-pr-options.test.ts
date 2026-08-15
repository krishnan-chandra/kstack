import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PostPrEffects, resolvePostPrOptions } from "./post-pr-options.ts";
import type { RouterArgs } from "./types.ts";

function args(partial: Partial<RouterArgs> = {}): RouterArgs {
	return { task: "", ...partial };
}

function effects(
	options: { selects?: Array<string | undefined>; inputs?: Array<string | undefined>; current?: () => boolean } = {},
) {
	const selects = [...(options.selects ?? [])];
	const inputs = [...(options.inputs ?? [])];
	const calls: string[] = [];
	const fx: PostPrEffects = {
		select: async (title, choices) => {
			calls.push(`select:${title}:${choices.join("|")}`);
			return selects.shift();
		},
		input: async (title) => {
			calls.push(`input:${title}`);
			return inputs.shift();
		},
		isSessionCurrent: options.current ?? (() => true),
	};
	return { fx, calls };
}

describe("resolvePostPrOptions", () => {
	it("returns no request for non-post routes without post-PR flags", async () => {
		const { fx, calls } = effects();
		assert.deepEqual(await resolvePostPrOptions("review", args(), fx), { ok: true });
		assert.deepEqual(calls, []);
	});

	it("rejects post-PR flags on non-post routes", async () => {
		const { fx } = effects();
		assert.deepEqual(await resolvePostPrOptions("review", args({ prNumber: 3 }), fx), {
			failed: "--pr is only valid with the pr-autopilot or land routes.",
		});
		assert.deepEqual(await resolvePostPrOptions("change", args({ autopilotMode: "drive" }), fx), {
			failed: "--mode is only valid with the pr-autopilot route.",
		});
		assert.deepEqual(await resolvePostPrOptions("investigate", args({ landMethod: "squash" }), fx), {
			failed: "--method is only valid with the land route.",
		});
		assert.deepEqual(await resolvePostPrOptions("fast-change", args({ readiness: "watch" }), fx), {
			failed: "--readiness is only valid with the land route.",
		});
	});

	it("rejects implementation flags on post-PR routes", async () => {
		const { fx } = effects();
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ delivery: "single" }), fx), {
			failed: "--single/--stack is only valid with implementation routes.",
		});
		assert.deepEqual(await resolvePostPrOptions("land", args({ worktree: true }), fx), {
			failed: "--worktree is only valid with the change or fast-change routes.",
		});
		assert.deepEqual(await resolvePostPrOptions("land", args({ changeKind: "feature" }), fx), {
			failed: "--change-kind is only valid with the change or fast-change routes.",
		});
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ landMethod: "rebase" }), fx), {
			failed: "--method and --readiness are only valid with the land route.",
		});
		assert.deepEqual(await resolvePostPrOptions("land", args({ autopilotMode: "check" }), fx), {
			failed: "--mode is only valid with the pr-autopilot route.",
		});
	});

	it("resolves an explicit autopilot request without prompting", async () => {
		const { fx, calls } = effects();
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ autopilotMode: "drive", prNumber: 42 }), fx), {
			ok: true,
			request: { route: "pr-autopilot", mode: "drive", prNumber: 42 },
		});
		assert.deepEqual(calls, []);
	});

	it("prompts for autopilot mode and accepts a blank PR as undefined", async () => {
		const { fx, calls } = effects({
			selects: ["drive — loop until merge-ready (3 cycles)"],
			inputs: ["   "],
		});
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args(), fx), {
			ok: true,
			request: { route: "pr-autopilot", mode: "drive", prNumber: undefined },
		});
		assert.ok(calls[0]?.startsWith("select:PR autopilot mode:"));
		assert.ok(calls.includes("input:PR number (blank = lowest unmerged):"));
	});

	it("parses a prompted autopilot PR number", async () => {
		const { fx } = effects({ inputs: ["18"] });
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ autopilotMode: "check" }), fx), {
			ok: true,
			request: { route: "pr-autopilot", mode: "check", prNumber: 18 },
		});
	});

	it("fails on an invalid prompted autopilot PR", async () => {
		const { fx } = effects({ inputs: ["0"] });
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ autopilotMode: "check" }), fx), {
			failed: "PR number must be a positive integer.",
		});
	});

	it("cancels when autopilot mode or PR prompts are dismissed", async () => {
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args(), effects({ selects: [undefined] }).fx), {
			cancelled: true,
		});
		assert.deepEqual(
			await resolvePostPrOptions("pr-autopilot", args({ autopilotMode: "watch" }), effects({ inputs: [undefined] }).fx),
			{ cancelled: true },
		);
	});

	it("resolves an explicit land request without prompting", async () => {
		const { fx, calls } = effects();
		assert.deepEqual(
			await resolvePostPrOptions("land", args({ prNumber: 9, readiness: "watch", landMethod: "squash" }), fx),
			{ ok: true, request: { route: "land", prNumber: 9, readiness: "watch", method: "squash" } },
		);
		assert.deepEqual(calls, []);
	});

	it("prompts for land PR and readiness and leaves method undefined", async () => {
		const { fx } = effects({
			inputs: ["12"],
			selects: ["check — one readiness pass, then confirm"],
		});
		assert.deepEqual(await resolvePostPrOptions("land", args(), fx), {
			ok: true,
			request: { route: "land", prNumber: 12, readiness: "check", method: undefined },
		});
	});

	it("fails on a blank or invalid land PR", async () => {
		assert.deepEqual(await resolvePostPrOptions("land", args(), effects({ inputs: [""] }).fx), {
			failed: "Land requires a positive PR number.",
		});
		assert.deepEqual(await resolvePostPrOptions("land", args(), effects({ inputs: ["nope"] }).fx), {
			failed: "Land requires a positive PR number.",
		});
	});

	it("cancels when land PR or readiness prompts are dismissed", async () => {
		assert.deepEqual(await resolvePostPrOptions("land", args(), effects({ inputs: [undefined] }).fx), {
			cancelled: true,
		});
		assert.deepEqual(await resolvePostPrOptions("land", args({ prNumber: 4 }), effects({ selects: [undefined] }).fx), {
			cancelled: true,
		});
	});

	it("cancels when the session is already stale", async () => {
		const { fx, calls } = effects({ current: () => false });
		assert.deepEqual(await resolvePostPrOptions("pr-autopilot", args({ autopilotMode: "check", prNumber: 1 }), fx), {
			cancelled: true,
		});
		assert.deepEqual(calls, []);
	});

	it("cancels when the session is replaced after a prompt", async () => {
		let checks = 0;
		const { fx } = effects({
			inputs: ["5"],
			current: () => {
				checks++;
				return checks === 1;
			},
		});
		assert.deepEqual(await resolvePostPrOptions("land", args({ readiness: "check" }), fx), { cancelled: true });
	});
});
