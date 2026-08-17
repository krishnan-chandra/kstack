import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStackDeliveryAdapter } from "./stack-delivery.ts";

const exec = async () => ({ code: 0, stdout: "", stderr: "" });

describe("stack delivery adapter factory", () => {
	it("selects an exhaustive adapter for each supported backend", () => {
		const deps = { exec, jjPolicy: "local jj policy" };
		assert.equal(createStackDeliveryAdapter("git", deps), undefined);
		assert.equal(createStackDeliveryAdapter("jj", deps)?.backendId, "jj");
		assert.equal(createStackDeliveryAdapter("graphite", deps)?.backendId, "graphite");
	});

	it("injects a private manifest contract into the Graphite child policy", () => {
		const adapter = createStackDeliveryAdapter("graphite", { exec, jjPolicy: "unused" });
		const policy = adapter?.childPolicy({
			workspaceRoot: "/repo",
			trunkRef: "main",
			trunkSha: "a".repeat(40),
			manifestPath: "/private/stack.json",
		});
		assert.match(policy ?? "", /native gt only/);
		assert.match(policy ?? "", /\/private\/stack\.json/);
		assert.match(policy ?? "", /Do not run gt submit/);
	});

	it("fails closed when Graphite publication has no manifest", async () => {
		const adapter = createStackDeliveryAdapter("graphite", { exec, jjPolicy: "unused" });
		assert.deepEqual(await adapter?.publish("/repo", undefined, async () => true), {
			status: "failed",
			message: "Graphite stack manifest path is unavailable.",
		});
	});
});
