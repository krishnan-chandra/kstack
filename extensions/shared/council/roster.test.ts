import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../validation.ts";
import { resolveCouncilRoster } from "./roster.ts";

const ALIASES = [
	{ label: "opus", model: "anthropic/claude-opus-5-5", thinking: "high" },
	{ label: "astra", model: "openai/gpt-6-astra", thinking: "high" },
	{ label: "argon", model: "google/gemini-4-argon", thinking: "high" },
];

function envWith(root: BoundaryValue | undefined): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "kstack-roster-"));
	if (root !== undefined) writeFileSync(join(dir, "kstack.json"), JSON.stringify(root));
	return { PI_CODING_AGENT_DIR: dir };
}

function errorOf(result: ReturnType<typeof resolveCouncilRoster>): string {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected roster resolution to fail");
	return result.error;
}

describe("resolveCouncilRoster", () => {
	const council = { aliases: ALIASES, council: { seats: ["opus", "astra", "argon"], maxRounds: 4 } };

	it("drops an Opus planner and letters the remaining seats in order", () => {
		const result = resolveCouncilRoster({
			env: envWith(council),
			plannerModel: "anthropic/claude-opus-5-5",
			whenMissing: "error",
		});
		assert.deepEqual(result, {
			ok: true,
			roster: {
				seats: [
					{ letter: "A", model: "openai/gpt-6-astra:high" },
					{ letter: "B", model: "google/gemini-4-argon:high" },
				],
				excluded: ["anthropic/claude-opus-5-5:high"],
				maxRounds: 4,
				timeoutMinutes: 15,
				reviewTimeoutMinutes: 10,
			},
		});
	});

	it("ignores the thinking level when matching the planner", () => {
		const result = resolveCouncilRoster({
			env: envWith(council),
			plannerModel: "openai/gpt-6-astra:xhigh",
			whenMissing: "skip",
		});
		assert.ok(result.ok);
		assert.deepEqual(
			result.roster?.seats.map((seat) => seat.model),
			["anthropic/claude-opus-5-5:high", "google/gemini-4-argon:high"],
		);
	});

	it("lets --seats replace configured seats while keeping configured knobs", () => {
		const result = resolveCouncilRoster({
			env: envWith(council),
			plannerModel: "anthropic/claude-opus-5-5",
			seatsOverride: ["argon", "openai/gpt-6-luna:low"],
			whenMissing: "error",
		});
		assert.ok(result.ok);
		assert.deepEqual(result.roster?.seats, [
			{ letter: "A", model: "google/gemini-4-argon:high" },
			{ letter: "B", model: "openai/gpt-6-luna:low" },
		]);
		assert.equal(result.roster?.maxRounds, 4);
	});

	it("uses the built-in seat when council omits seats", () => {
		const result = resolveCouncilRoster({ env: envWith({ council: {} }), plannerModel: "a/b", whenMissing: "error" });
		assert.ok(result.ok);
		assert.deepEqual(result.roster?.seats, [{ letter: "A", model: "openai/gpt-6-astra:xhigh" }]);
	});

	it("skips or errors on a missing council section by caller policy", () => {
		assert.deepEqual(resolveCouncilRoster({ env: envWith({}), plannerModel: "a/b", whenMissing: "skip" }), {
			ok: true,
		});
		assert.match(
			errorOf(resolveCouncilRoster({ env: envWith(undefined), plannerModel: "a/b", whenMissing: "error" })),
			/configure council\.seats in kstack\.json or pass --seats/i,
		);
		const override = resolveCouncilRoster({
			env: envWith(undefined),
			plannerModel: "a/b",
			seatsOverride: ["openai/gpt-6-astra:high"],
			whenMissing: "error",
		});
		assert.ok(override.ok);
		assert.deepEqual(override.roster, {
			seats: [{ letter: "A", model: "openai/gpt-6-astra:high" }],
			excluded: [],
			maxRounds: 3,
			timeoutMinutes: 15,
			reviewTimeoutMinutes: 10,
		});
	});

	it("rejects a legacy adversary section with a migration message", () => {
		const error = errorOf(
			resolveCouncilRoster({
				env: envWith({ adversary: { adversary: "astra" } }),
				plannerModel: "a/b",
				whenMissing: "skip",
			}),
		);
		assert.match(error, /council\.seats/);
	});

	it("rejects duplicates, an empty post-exclusion roster, too many seats, and unknown aliases", () => {
		const env = envWith({ aliases: ALIASES });
		assert.match(
			errorOf(
				resolveCouncilRoster({
					env,
					plannerModel: "a/b",
					seatsOverride: ["astra", "openai/gpt-6-astra:low"],
					whenMissing: "error",
				}),
			),
			/repeat the model openai\/gpt-6-astra/,
		);
		assert.match(
			errorOf(
				resolveCouncilRoster({
					env,
					plannerModel: "anthropic/claude-opus-5-5",
					seatsOverride: ["opus"],
					whenMissing: "error",
				}),
			),
			/Every council seat uses the planner model/,
		);
		assert.match(
			errorOf(
				resolveCouncilRoster({
					env,
					plannerModel: "x/y",
					seatsOverride: ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"],
					whenMissing: "error",
				}),
			),
			/1 to 5 seats; got 6/,
		);
		assert.match(
			errorOf(resolveCouncilRoster({ env, plannerModel: "x/y", seatsOverride: ["nope"], whenMissing: "error" })),
			/not found/,
		);
	});

	it("checks availability only for seats that sit", () => {
		const unavailable = resolveCouncilRoster({
			env: envWith(council),
			plannerModel: "anthropic/claude-opus-5-5",
			whenMissing: "error",
			available: (provider) => provider !== "google",
		});
		assert.match(errorOf(unavailable), /unavailable or unauthenticated: google\/gemini-4-argon/);
		const plannerUnavailable = resolveCouncilRoster({
			env: envWith(council),
			plannerModel: "anthropic/claude-opus-5-5",
			whenMissing: "error",
			available: (provider) => provider !== "anthropic",
		});
		assert.ok(plannerUnavailable.ok);
	});
});
