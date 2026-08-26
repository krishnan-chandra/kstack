import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	claimStackCapabilities,
	claimStackPreflight,
	claimStackPublication,
	STACK_CAPABILITIES_EVENT,
	STACK_PREFLIGHT_EVENT,
	STACK_PUBLICATION_EVENT,
} from "../shared/stack/channel.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { createStackDeliveryClient } from "./stack-delivery.ts";

function createMockPi() {
	const handlers = new Map<string, Array<(value: BoundaryValue) => void>>();
	const pi = {
		events: {
			on: (event: string, handler: (value: BoundaryValue) => void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			emit: (event: string, value: BoundaryValue) => {
				for (const handler of handlers.get(event) ?? []) {
					handler(value);
				}
			},
		},
	};
	return { pi, handlers };
}

describe("createStackDeliveryClient", () => {
	it("returns undefined for Git backend", () => {
		const { pi } = createMockPi();
		const client = createStackDeliveryClient(
			/* SAFETY: Test mock */ pi as never,
			"git",
			/* SAFETY: Test mock */ {} as never,
		);
		assert.equal(client, undefined);
	});

	it("preflights through provider channels", async () => {
		const { pi } = createMockPi();
		pi.events.on(STACK_CAPABILITIES_EVENT, (data) =>
			claimStackCapabilities(data, "jj", async () => ({
				schemaVersion: 1,
				publication: true,
			})),
		);
		pi.events.on(STACK_PREFLIGHT_EVENT, (data) =>
			claimStackPreflight(data, "jj", async () => ({
				ok: true,
				workspaceRoot: "/repo",
				trunkRef: "trunk()",
				trunkSha: "a".repeat(40),
				childPolicy: "jj-policy",
			})),
		);

		const client = createStackDeliveryClient(
			/* SAFETY: Test mock */ pi as never,
			"jj",
			/* SAFETY: Test mock */ {} as never,
		);
		assert.ok(client);
		assert.equal(client.provider, "jj");

		const preflight = await client.preflight("/repo");
		assert.equal(preflight.ok, true);
		if (preflight.ok) {
			assert.equal(preflight.trunkRef, "trunk()");
			assert.equal(preflight.childPolicy, "jj-policy");
		}
	});

	it("publishes through provider channels", async () => {
		const { pi } = createMockPi();
		pi.events.on(STACK_PUBLICATION_EVENT, (data) =>
			claimStackPublication(data, "graphite", async () => ({
				status: "completed",
				planId: "p1",
				publication: { topRef: "kstack/top", pullRequests: [] },
				completedActions: [],
			})),
		);

		const client = createStackDeliveryClient(
			/* SAFETY: Test mock */ pi as never,
			"graphite",
			/* SAFETY: Test mock */ {} as never,
		);
		assert.ok(client);
		assert.equal(client.provider, "graphite");

		const published = await client.publish("/repo");
		assert.equal(published.status, "completed");
	});

	it("handles missing provider extension gracefully", async () => {
		const { pi } = createMockPi();
		const client = createStackDeliveryClient(
			/* SAFETY: Test mock */ pi as never,
			"jj",
			/* SAFETY: Test mock */ {} as never,
		);
		assert.ok(client);

		const preflight = await client.preflight("/repo");
		assert.equal(preflight.ok, false);
		if (!preflight.ok) {
			assert.match(preflight.error, /jj-stacked-prs extension to be loaded/);
		}

		const published = await client.publish("/repo");
		assert.equal(published.status, "failed");
	});
});
