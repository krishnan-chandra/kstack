import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestStackCapabilities } from "../shared/stack/channel.ts";
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
