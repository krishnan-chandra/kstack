import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestStackCapabilities, requestStackLanding, requestStackPublication } from "../shared/stack/channel.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import graphiteStackedPrsExtension from "./index.ts";

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
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	return { pi, handlers };
}

describe("graphite-stacked-prs extension", () => {
	it("emits the initial publishing status for the delegated publication path and clears it on failure", async () => {
		const { pi } = createMockPi();
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				setStatus: (key: string, value: string | undefined) => {
					statuses.push({ key, value });
				},
				notify: () => {},
				confirm: async () => true,
			},
		};

		graphiteStackedPrsExtension(/* SAFETY: Test double matches ExtensionAPI subset used by extension. */ pi as never);

		const result = await requestStackPublication(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			{
				provider: "graphite",
				input: { repositoryPath: process.cwd(), manifestPath: "/nonexistent/manifest.json" },
				ctx: /* SAFETY: Test double matches the ExtensionCommandContext subset. */ ctx as never,
			},
		);

		assert.equal(result.handled, true);
		if (result.handled) assert.equal(result.outcome.status, "blocked");
		assert.deepEqual(statuses, [
			{ key: "graphite-stack", value: "graphite-stack: publishing" },
			{ key: "graphite-stack", value: undefined },
		]);
	});

	it("emits the initial validating-stack status for the delegated landing path and clears it on failure", async () => {
		const { pi } = createMockPi();
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			waitForIdle: async () => {},
			ui: {
				setStatus: (key: string, value: string | undefined) => {
					statuses.push({ key, value });
				},
				notify: () => {},
				confirm: async () => true,
			},
		};

		graphiteStackedPrsExtension(/* SAFETY: Test double matches ExtensionAPI subset used by extension. */ pi as never);

		const result = await requestStackLanding(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			{
				provider: "graphite",
				input: {
					repositoryPath: process.cwd(),
					prNumber: 42,
					headRef: "kstack/feat",
					readiness: "watch",
					method: "squash",
				},
				capabilities: {
					runAutopilot: async () => ({ handled: true as const, outcome: { status: "not-stack" as const } }),
				},
				ctx: /* SAFETY: Test double matches the ExtensionContext subset. */ ctx as never,
			},
		);

		assert.equal(result.handled, true);
		if (result.handled) assert.equal(result.outcome.status, "stack");
		assert.deepEqual(statuses, [
			{ key: "graphite-stack", value: "graphite-stack: validating stack" },
			{ key: "graphite-stack", value: undefined },
		]);
	});

	it("registers handlers and claims the four channels for provider graphite", async () => {
		const { pi } = createMockPi();
		graphiteStackedPrsExtension(/* SAFETY: Test double matches ExtensionAPI subset used by extension. */ pi as never);

		// Capabilities
		const caps = await requestStackCapabilities(
			/* SAFETY: Test double matches ExtensionAPI. */ pi as never,
			"graphite",
		);
		assert.deepEqual(caps, {
			handled: true,
			outcome: {
				schemaVersion: 1,
				publication: true,
			},
		});

		// Ignores jj
		const jjCaps = await requestStackCapabilities(/* SAFETY: Test double matches ExtensionAPI. */ pi as never, "jj");
		assert.deepEqual(jjCaps, { handled: false });
	});
});
