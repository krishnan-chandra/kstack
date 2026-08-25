import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StackPublishOutcome } from "../shared/stack/outcome.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import {
	claimJjStackCapabilities,
	claimStackLanding,
	claimStackPublication,
	isJjStackCapabilitiesRequest,
	isJjStackLandingRequest,
	isJjStackPublicationRequest,
	JJ_STACK_CAPABILITIES,
	JJ_STACK_CAPABILITIES_EVENT,
	JJ_STACK_LANDING_EVENT,
	JJ_STACK_PUBLICATION_EVENT,
	requestJjStackCapabilities,
	requestStackLanding,
	requestStackPublication,
} from "./api.ts";

const outcome: StackPublishOutcome = { status: "declined" };

describe("jj-stack request channels", () => {
	it("claims capabilities synchronously and reports an unloaded extension", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, JJ_STACK_CAPABILITIES_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};
		assert.equal(
			isJjStackCapabilitiesRequest({
				schemaVersion: 1,
				payload: { schemaVersion: 1 },
				claimed: false,
			}),
			true,
		);
		pi.events.on(JJ_STACK_CAPABILITIES_EVENT, (value) =>
			claimJjStackCapabilities(value, async () => JJ_STACK_CAPABILITIES),
		);
		assert.deepEqual(
			await requestJjStackCapabilities(
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			),
			{
				handled: true,
				outcome: JJ_STACK_CAPABILITIES,
			},
		);
		assert.deepEqual(
			await requestJjStackCapabilities(
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
					events: { emit: () => {} },
				} as never,
			),
			{
				handled: false,
			},
		);
	});

	it("claims stack-prefix landing and rejects malformed payloads", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, JJ_STACK_LANDING_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};
		pi.events.on(JJ_STACK_LANDING_EVENT, (value) => claimStackLanding(value, async () => ({ status: "not-stack" })));
		assert.deepEqual(
			await requestStackLanding(
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
				{ repositoryPath: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never,
			),
			{ handled: true, outcome: { status: "not-stack" } },
		);
		assert.equal(
			isJjStackLandingRequest({
				schemaVersion: 1,
				payload: {
					input: { repositoryPath: "/repo", prNumber: 0, headBookmark: "feat2", readiness: "watch" },
					ctx: {},
				},
				claimed: false,
			}),
			false,
		);
	});

	it("claims publication once and rejects malformed payloads", async () => {
		const listeners: Array<(value: BoundaryValue) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
				emit: (name: string, value: BoundaryValue) => {
					assert.equal(name, JJ_STACK_PUBLICATION_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};
		pi.events.on(JJ_STACK_PUBLICATION_EVENT, (value) => claimStackPublication(value, async () => outcome));
		const result = await requestStackPublication(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			{ repositoryPath: "/repo" },
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never,
		);
		assert.deepEqual(result, { handled: true, outcome });
		assert.equal(
			isJjStackPublicationRequest({
				schemaVersion: 1,
				payload: { input: { repositoryPath: "" }, ctx: {} },
				claimed: false,
			}),
			false,
		);
		assert.equal(
			claimStackPublication(
				{
					schemaVersion: 1,
					payload: { input: { repositoryPath: "/repo" }, ctx: {} },
					claimed: true,
				},
				async () => outcome,
			),
			false,
		);
	});
});
