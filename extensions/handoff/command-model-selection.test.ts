import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandlerWithStubs, MODELS, makeFakeApi, makeFakeCtx, PARENT_MODEL } from "./command-test-fixtures.ts";

describe("handoff replacement model selection", () => {
	it("applies the requested model and effort when replacement defaults differ", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"--model openai/gpt-5.2:medium goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"newSession",
			"replacement.setModel",
			"replacement.setThinkingLevel",
			"fresh.sendUserMessage",
		]);
		assert.deepEqual(fake.replacementCalls.setModel, [MODELS[2]]);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["medium"]);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.ok(fake.notifications.some((notification) => notification.message.includes("Model: openai/gpt-5.2:medium")));
	});

	it("inherits the parent model and effort through the replacement session API", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "high" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, [PARENT_MODEL]);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
		assert.ok(
			fake.notifications.some((notification) => notification.message.includes("Model: anthropic/claude-opus-4-6:high")),
		);
	});

	it("skips the model switch when the replacement already starts on the expected model", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "high" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: PARENT_MODEL,
			freshThinkingLevel: "high",
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("reports a mismatch with the failure reason when the model cannot be applied", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
			replacementSetModelResult: false,
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"--model openai/gpt-5.2:medium goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply openai/gpt-5.2:medium"));
		assert.ok(warning.message.includes("anthropic/claude-sonnet-4-5"));
		assert.ok(warning.message.includes("no credentials for openai/gpt-5.2"));
		assert.ok(!warning.message.includes("startup"));
		assert.ok(!warning.message.includes("scoping"));
		// The handoff still continues on the replacement's actual state.
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("reports the clamped effort when the requested level is unsupported", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
			replacementAvailableEfforts: ["off", "minimal", "low", "medium"],
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"--model openai/gpt-5.2:xhigh goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply openai/gpt-5.2:xhigh"));
		assert.ok(warning.message.includes("openai/gpt-5.2:medium"));
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("warns without failing when no replacement API is bound", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandlerWithStubs(api, undefined)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply anthropic/claude-opus-4-6:low"));
		assert.ok(warning.message.includes("the replacement session API is unavailable"));
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("leaves the predecessor unchanged and skips selection when replacement is cancelled", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			newSessionResult: { cancelled: true },
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"--model openai/gpt-5.2:high goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.notifications.at(-1)!.message, "New session cancelled");
	});

	it("leaves the predecessor unchanged when replacement creation throws", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			newSessionError: new Error("runtime creation failed"),
		});

		await assert.rejects(
			createHandlerWithStubs(api)(
				"--model openai/gpt-5.2:high goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			),
			/runtime creation failed/,
		);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
	});

	it("accepts scoped model references without mutating the predecessor", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			scopedModels: [{ model: MODELS[2] }, { model: MODELS[3] }],
		});

		await createHandlerWithStubs(api, fake.replacementApi)(
			"--model openai/gpt-5.2 goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.equal(fake.calls.newSession, 1);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setModel, [MODELS[2]]);
	});

	it("rejects model references outside an active scope before replacement", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			scopedModels: [{ model: MODELS[2] }, { model: MODELS[3] }],
		});

		await createHandlerWithStubs(api)(
			"--model anthropic/claude-sonnet-4-5 goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);

		assert.equal(calls.newSession, 0);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes("scoping"));
	});

	it("rejects unknown and ambiguous references before opening the editor", async () => {
		for (const args of ["--model nope/does-not-exist goal", "--model gpt goal"]) {
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const { ctx, calls } = makeFakeCtx(order);
			await createHandlerWithStubs(api)(
				args,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			);
			assert.equal(calls.editorDrafts.length, 0);
			assert.equal(calls.newSession, 0);
		}
	});

	it("does not leak model syntax into the continuation goal", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL, thinkingLevel: "medium" });

		await createHandlerWithStubs(api)(
			"--model openai/gpt-5.2:high ship the feature",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);

		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nship the feature"));
		assert.ok(!draft.includes("--model"));
		assert.ok(!draft.includes("gpt-5.2"));
		assert.ok(!draft.includes(":high"));
	});
});
