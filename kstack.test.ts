import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKstackExtensions } from "./kstack.ts";

test("registerKstackExtensions preserves order and rejects a partial load", async () => {
	const loaded: string[] = [];
	const pi = {} as ExtensionAPI;

	await assert.rejects(
		registerKstackExtensions(pi, [
			{
				name: "alpha",
				async register() {
					await Promise.resolve();
					loaded.push("alpha");
				},
			},
			{
				name: "broken",
				register() {
					loaded.push("broken");
					throw new Error("boom");
				},
			},
			{
				name: "gamma",
				register() {
					loaded.push("gamma");
				},
			},
		]),
		/boom/,
	);

	assert.deepEqual(loaded, ["alpha", "broken"]);
});
