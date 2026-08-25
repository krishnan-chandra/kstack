import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../validation.ts";
import {
	claimStackCapabilities,
	claimStackLanding,
	claimStackPreflight,
	claimStackPublication,
	isStackCapabilitiesRequest,
	isStackLandingRequest,
	isStackPreflightRequest,
	isStackPublicationRequest,
	requestStackCapabilities,
	requestStackLanding,
	requestStackPreflight,
	requestStackPublication,
	STACK_CAPABILITIES_EVENT,
	STACK_LANDING_EVENT,
	STACK_PREFLIGHT_EVENT,
	STACK_PUBLICATION_EVENT,
	type StackProviderCapabilities,
} from "./channel.ts";
import type { StackPublishOutcome } from "./outcome.ts";

const sampleCapabilities: StackProviderCapabilities = {
	schemaVersion: 1,
	publication: true,
	commands: ["inspect", "plan", "publish", "sync", "advance", "land"],
};

const samplePublishOutcome: StackPublishOutcome = { status: "declined" };

describe("shared stack request channels", () => {
	it("claims capabilities for the target provider and ignores other providers", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, STACK_CAPABILITIES_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};

		assert.equal(
			isStackCapabilitiesRequest({
				schemaVersion: 1,
				payload: { provider: "jj" },
				claimed: false,
			}),
			true,
		);

		// Claim jj only
		pi.events.on(STACK_CAPABILITIES_EVENT, (value) =>
			claimStackCapabilities(value, "jj", async () => sampleCapabilities),
		);

		// jj request succeeds
		const jjResult = await requestStackCapabilities(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			"jj",
		);
		assert.deepEqual(jjResult, {
			handled: true,
			outcome: sampleCapabilities,
		});

		// graphite request is unclaimed (handled: false)
		const graphiteResult = await requestStackCapabilities(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			"graphite",
		);
		assert.deepEqual(graphiteResult, { handled: false });
	});

	it("claims preflight for the matching provider and rejects invalid payloads", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, STACK_PREFLIGHT_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};

		const preflightOutcome = {
			ok: true as const,
			workspaceRoot: "/repo",
			trunkRef: "trunk()",
			trunkSha: "a".repeat(40),
			childPolicy: "test-policy",
		};

		pi.events.on(STACK_PREFLIGHT_EVENT, (value) => claimStackPreflight(value, "jj", async () => preflightOutcome));

		const result = await requestStackPreflight(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			{ provider: "jj", cwd: "/repo" },
		);
		assert.deepEqual(result, { handled: true, outcome: preflightOutcome });

		assert.equal(
			isStackPreflightRequest({
				schemaVersion: 1,
				payload: { provider: "jj", cwd: "" },
				claimed: false,
			}),
			false,
		);
	});

	it("claims publication once and validates publication payload", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, STACK_PUBLICATION_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};

		pi.events.on(STACK_PUBLICATION_EVENT, (value) =>
			claimStackPublication(value, "jj", async () => samplePublishOutcome),
		);

		const result = await requestStackPublication(
			/* SAFETY: This test fixture mocks ExtensionAPI for channel dispatch. */ pi as never,
			{
				provider: "jj",
				input: { repositoryPath: "/repo" },
				ctx: /* SAFETY: Mock ExtensionCommandContext */ {} as never,
			},
		);
		assert.deepEqual(result, { handled: true, outcome: samplePublishOutcome });

		assert.equal(
			isStackPublicationRequest({
				schemaVersion: 1,
				payload: { provider: "jj", input: { repositoryPath: "" }, ctx: {} },
				claimed: false,
			}),
			false,
		);
	});

	it("claims landing and validates callback capabilities and input", async () => {
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
					landPr: async () => ({ handled: true, outcome: {} }),
					runAutopilot: async () => ({ handled: true, outcome: {} }),
				},
				ctx: /* SAFETY: Mock ExtensionContext */ {} as never,
			},
		);
		assert.deepEqual(result, { handled: true, outcome: { status: "not-stack" } });

		assert.equal(
			isStackLandingRequest({
				schemaVersion: 1,
				payload: {
					provider: "graphite",
					input: { repositoryPath: "/repo", prNumber: -1, headRef: "feat", readiness: "watch" },
					capabilities: {},
					ctx: {},
				},
				claimed: false,
			}),
			false,
		);
	});
});
