import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	claimJjStackCapabilities,
	claimStackPublication,
	isJjStackCapabilitiesRequest,
	isJjStackPublicationRequest,
	JJ_STACK_CAPABILITIES,
	JJ_STACK_CAPABILITIES_EVENT,
	JJ_STACK_PUBLICATION_EVENT,
	requestJjStackCapabilities,
	requestStackPublication,
} from "./api.ts";
import type { StackPublicationOutcome } from "./types.ts";

const outcome: StackPublicationOutcome = { status: "declined" };

describe("jj-stack request channels", () => {
	it("claims capabilities synchronously and reports an unloaded extension", async () => {
		const listeners: Array<(value: unknown) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: unknown) => void) => listeners.push(listener),
				emit: (name: string, value: unknown) => {
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
		assert.deepEqual(await requestJjStackCapabilities(pi as never), {
			handled: true,
			outcome: JJ_STACK_CAPABILITIES,
		});
		assert.deepEqual(await requestJjStackCapabilities({ events: { emit: () => {} } } as never), {
			handled: false,
		});
	});

	it("claims publication once and rejects malformed payloads", async () => {
		const listeners: Array<(value: unknown) => void> = [];
		const pi = {
			events: {
				on: (_name: string, listener: (value: unknown) => void) => listeners.push(listener),
				emit: (name: string, value: unknown) => {
					assert.equal(name, JJ_STACK_PUBLICATION_EVENT);
					for (const listener of listeners) listener(value);
				},
			},
		};
		pi.events.on(JJ_STACK_PUBLICATION_EVENT, (value) => claimStackPublication(value, async () => outcome));
		const result = await requestStackPublication(pi as never, { repositoryPath: "/repo" }, {} as never);
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
