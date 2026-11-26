import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../validation.ts";
import { claimStackLanding, requestStackLanding, STACK_LANDING_EVENT } from "./channel.ts";

describe("shared stack landing channel", () => {
	it("claims landing for the matching provider and ignores other providers", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, STACK_LANDING_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};

		pi.events.on(STACK_LANDING_EVENT, (value) =>
			claimStackLanding(value, "graphite", async () => ({ status: "not-stack" })),
		);

		const result = await requestStackLanding(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			{
				provider: "graphite",
				input: {
					repositoryPath: "/repo",
					prNumber: 42,
					headRef: "kstack/feat",
					readiness: "watch",
					method: "squash",
				},
				capabilities: {
					runAutopilot: async () => ({ handled: true, outcome: {} }),
				},
				ctx: /* SAFETY: Mock ExtensionContext */ {} as never,
			},
		);
		assert.deepEqual(result, { handled: true, outcome: { status: "not-stack" } });

		const otherProvider = await requestStackLanding(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			{
				provider: "jj",
				input: {
					repositoryPath: "/repo",
					prNumber: 42,
					headRef: "kstack/feat",
					readiness: "watch",
					method: "squash",
				},
				capabilities: {},
				ctx: /* SAFETY: Mock ExtensionContext */ {} as never,
			},
		);
		assert.deepEqual(otherProvider, { handled: false });
	});

	it("rejects malformed landing payloads when claiming", () => {
		const noop = async () => ({ status: "not-stack" as const });
		assert.equal(
			claimStackLanding(
				{
					schemaVersion: 1,
					payload: {
						provider: "graphite",
						input: { repositoryPath: "/repo", prNumber: -1, headRef: "feat", readiness: "watch" },
						capabilities: {},
						ctx: {},
					},
					claimed: false,
				},
				"graphite",
				noop,
			),
			false,
		);
		assert.equal(
			claimStackLanding(
				{
					schemaVersion: 1,
					payload: {
						provider: "graphite",
						input: { repositoryPath: "/repo", prNumber: 1, headRef: "feat", readiness: "watch" },
						capabilities: { landPr: "removed" },
						ctx: {},
					},
					claimed: false,
				},
				"graphite",
				noop,
			),
			false,
		);
	});
});
