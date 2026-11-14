import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { archiveDestination } from "../session-archive/archive-files.ts";
import { makeTempTree, messageEntry, sessionJsonl, userMessage } from "../session-archive/test-helpers.ts";
import { claimSessionTransition, releaseSessionTransition } from "../shared/session-transition.ts";
import { createHandoffHandler, createHandoffToolController } from "./command.ts";
import {
	CWD,
	HEADER_TIMESTAMP,
	MODELS,
	makeFakeApi,
	makeFakeCtx,
	PARENT_MODEL,
	SESSION_FILE,
	SESSION_ID,
	withAgentDir,
} from "./command-test-fixtures.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";
import { type HandoffSource, preflightHandoffHistory } from "./history-reader.ts";

const roots: string[] = [];
afterEach(() => {
	releaseSessionTransition(SESSION_ID);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createToolWiring(
	api: Parameters<typeof createHandoffHandler>[0],
	opts: {
		preflightHistory?: (source: HandoffSource) => ReturnType<typeof preflightHandoffHistory>;
		replacementApi?: Parameters<typeof createHandoffHandler>[1] extends infer D
			? D extends { getReplacementApi?: (id: string) => infer R }
				? R
				: never
			: never;
	} = {},
) {
	const sent: Array<{ content: string; options: { expandPromptTemplates: boolean } }> = [];
	const preflightHistory = opts.preflightHistory ?? (() => ({ kind: "ready" as const }));
	const controller = createHandoffToolController(api, {
		preflightHistory,
		sendUserMessage: (content, options) => sent.push({ content, options }),
	});
	const handler = createHandoffHandler(api, {
		preflightHistory,
		getReplacementApi: () => opts.replacementApi,
		consumeToolRequest: controller.consumeToolRequest,
	});
	return { controller, handler, sent };
}

describe("handoff tool parity and lifecycle", () => {
	it("hands off across non-TUI modes without opening the editor and supports default goal", async () => {
		for (const mode of ["print", "json", "rpc", "tui"] as const) {
			const order: string[] = [];
			const { api } = makeFakeApi(order, { thinkingLevel: "low" });
			const fake = makeFakeCtx(order, {
				mode,
				model: PARENT_MODEL,
				thinkingLevel: "low",
				freshModel: MODELS[0],
				freshThinkingLevel: "low",
			});
			const { controller, handler, sent } = createToolWiring(api, { replacementApi: fake.replacementApi });

			const result = await controller.execute(
				"call-1",
				{},
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.equal(result.terminate, true);
			assert.equal(result.details.scheduled, true);
			assert.equal(result.details.goal, DEFAULT_HANDOFF_GOAL);

			controller.onAgentSettled(
				{ aborted: false },
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0].options, { expandPromptTemplates: true });

			await handler(
				sent[0].content.replace(/^\/handoff /, ""),
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);

			assert.equal(fake.calls.editorDrafts.length, 0, mode);
			assert.equal(fake.calls.newSession, 1, mode);
			assert.equal(fake.calls.sendUserMessage.length, 1, mode);
			assert.ok(fake.calls.sendUserMessage[0].includes(`## Goal\n${DEFAULT_HANDOFF_GOAL}`), mode);
			assert.deepEqual(fake.calls.sessionNames, ["continue-implementation"], mode);
			assert.deepEqual(fake.replacementCalls.setModel, [PARENT_MODEL], mode);
			assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["low"], mode);
		}
	});

	it("supports model, effort suffix, standalone effort, kstack.json aliases, and scoped models", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		mkdirSync(tree.agentDir, { recursive: true });
		writeFileSync(
			join(tree.agentDir, "kstack.json"),
			JSON.stringify({
				models: {
					council: [{ label: "terra", model: "openai/gpt-5.2", thinking: "high" }],
				},
			}),
		);

		await withAgentDir(tree.agentDir, async () => {
			// 1. Alias with configured thinking level.
			{
				const order: string[] = [];
				const { api } = makeFakeApi(order, { thinkingLevel: "low" });
				const fake = makeFakeCtx(order, {
					model: PARENT_MODEL,
					thinkingLevel: "low",
					freshModel: MODELS[0],
					freshThinkingLevel: "low",
				});
				const { controller, handler, sent } = createToolWiring(api, { replacementApi: fake.replacementApi });
				const res = await controller.execute(
					"c1",
					{ goal: "Continue via alias", model: "terra" },
					undefined,
					undefined,
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				assert.equal(res.details.model, "openai/gpt-5.2");
				assert.equal(res.details.effort, "high");
				controller.onAgentSettled(
					{ aborted: false },
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				await handler(
					sent[0].content.replace(/^\/handoff /, ""),
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				assert.deepEqual(fake.replacementCalls.setModel, [MODELS[2]]);
				assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
			}

			// 2. Explicit effort overrides alias thinking level, and standalone effort inherits parent model.
			{
				const order: string[] = [];
				const { api } = makeFakeApi(order, { thinkingLevel: "low" });
				const fake = makeFakeCtx(order, {
					model: PARENT_MODEL,
					thinkingLevel: "low",
					freshModel: MODELS[0],
					freshThinkingLevel: "low",
				});
				const { controller, handler, sent } = createToolWiring(api, { replacementApi: fake.replacementApi });
				const res = await controller.execute(
					"c2",
					{ goal: "Override effort only", effort: "max" },
					undefined,
					undefined,
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				assert.equal(res.details.model, undefined);
				assert.equal(res.details.effort, "max");
				controller.onAgentSettled(
					{ aborted: false },
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				await handler(
					sent[0].content.replace(/^\/handoff /, ""),
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				assert.deepEqual(fake.replacementCalls.setModel, [PARENT_MODEL]);
				assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["max"]);
			}

			// 3. Conflicting model:effort and effort parameter rejects before scheduling.
			{
				const order: string[] = [];
				const { api } = makeFakeApi(order, { thinkingLevel: "low" });
				const fake = makeFakeCtx(order, { model: PARENT_MODEL, thinkingLevel: "low" });
				const { controller } = createToolWiring(api);
				await assert.rejects(
					controller.execute(
						"c3",
						{ model: "openai/gpt-5.2:low", effort: "high" },
						undefined,
						undefined,
						/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
					),
					/Conflicting effort levels/,
				);
			}

			// 4. Scoped models reject out-of-scope references before scheduling.
			{
				const order: string[] = [];
				const { api } = makeFakeApi(order);
				const fake = makeFakeCtx(order, { scopedModels: [{ model: MODELS[2] }] });
				const { controller } = createToolWiring(api);
				await assert.rejects(
					controller.execute(
						"c4",
						{ model: "anthropic/claude-sonnet-4-5" },
						undefined,
						undefined,
						/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
					),
					/Model scoping is active/,
				);
			}
		});
	});

	it("supports archive-first handoff and rejects malformed archive sources up front", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);

		// Malformed active session rejects during execute() without scheduling.
		const malformed = tree.writeSession(SESSION_ID, "not-json\n");
		{
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const fake = makeFakeCtx(order, { sessionFile: malformed, sessionDir: tree.sessionDir });
			const { controller } = createToolWiring(api);
			await withAgentDir(tree.agentDir, async () => {
				await assert.rejects(
					controller.execute(
						"bad-arch",
						{ archive: true, goal: "Should fail" },
						undefined,
						undefined,
						/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
					),
					/malformed session file/i,
				);
			});
			assert.equal(claimSessionTransition(SESSION_ID, "handoff") !== undefined, true);
			releaseSessionTransition(SESSION_ID);
		}

		// Valid active session archives before running replacement continuation.
		const valid = tree.writeSession(
			SESSION_ID,
			sessionJsonl([messageEntry("u1", null, userMessage("source history"))], { id: SESSION_ID, cwd: CWD }),
		);
		{
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const fake = makeFakeCtx(order, {
				sessionFile: valid,
				sessionDir: tree.sessionDir,
				expectedParentSession: undefined,
			});
			const { controller, handler, sent } = createToolWiring(api, { replacementApi: fake.replacementApi });
			await withAgentDir(tree.agentDir, async () => {
				await controller.execute(
					"ok-arch",
					{ archive: true, goal: "Continue after archiving" },
					undefined,
					undefined,
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				controller.onAgentSettled(
					{ aborted: false },
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
				await handler(
					sent[0].content.replace(/^\/handoff /, ""),
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				);
			});

			const archivedPath = archiveDestination(tree.archiveRoot, SESSION_ID, HEADER_TIMESTAMP);
			assert.equal(existsSync(valid), false);
			assert.equal(existsSync(archivedPath), true);
			assert.equal(fake.calls.sendUserMessage.length, 1);
			assert.ok(fake.customMessages[0].content.includes("Storage: archived before this handoff"));
		}
	});

	it("enforces history-access allowlist, re-validates on settle, and cleans up on abort/shutdown/conflict", async () => {
		// 1. Unavailable history tools rejects in execute().
		{
			const order: string[] = [];
			const { api } = makeFakeApi(order, { active: ["ls", "find"], registeredOnly: [] });
			const fake = makeFakeCtx(order);
			const { controller } = createToolWiring(api);
			await assert.rejects(
				controller.execute(
					"u1",
					{ goal: "Cannot read" },
					undefined,
					undefined,
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				),
				/no tool that can read the previous session/i,
			);
		}

		// 2. Degraded access warns in tool output and points replacement at transcript.
		{
			const order: string[] = [];
			const { api } = makeFakeApi(order, { active: ["read", "grep"], registeredOnly: [] });
			const fake = makeFakeCtx(order);
			const { controller, handler, sent } = createToolWiring(api);
			const res = await controller.execute(
				"d1",
				{ goal: "Review diff" },
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.match(res.content[0].text, /Warning: .*transcript file instead/i);
			controller.onAgentSettled(
				{ aborted: false },
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			await handler(
				sent[0].content.replace(/^\/handoff /, ""),
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.ok(fake.calls.sendUserMessage[0].includes(`read the transcript JSONL at ${SESSION_FILE}`));
		}

		// 3. Source deleted between tool execute() and command execution prevents replacement.
		{
			const tree = makeTempTree();
			roots.push(tree.root);
			const sessionFile = tree.writeSession(
				SESSION_ID,
				sessionJsonl([messageEntry("u1", null, userMessage("hi"))], { id: SESSION_ID, cwd: CWD }),
			);
			const env = { ...process.env, PI_CODING_AGENT_DIR: tree.agentDir };
			const preflightHistory = (source: HandoffSource) => preflightHandoffHistory(source, env);
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const fake = makeFakeCtx(order, { sessionFile });
			const { controller, handler, sent } = createToolWiring(api, { preflightHistory });

			await controller.execute(
				"del1",
				{ goal: "Will vanish" },
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			controller.onAgentSettled(
				{ aborted: false },
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			unlinkSync(sessionFile);
			await handler(
				sent[0].content.replace(/^\/handoff /, ""),
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.equal(fake.calls.newSession, 0);
			assert.equal(fake.notifications.at(-1)?.level, "error");
		}

		// 4. Cross-extension transition conflict, abort, and shutdown release.
		{
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const fake = makeFakeCtx(order);
			const { controller, handler, sent } = createToolWiring(api);

			assert.ok(claimSessionTransition(SESSION_ID, "archive_session"));
			await assert.rejects(
				controller.execute(
					"c1",
					{ goal: "Conflict" },
					undefined,
					undefined,
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
				),
				/already scheduled/i,
			);
			releaseSessionTransition(SESSION_ID);

			// Abort cancels before dispatch.
			await controller.execute(
				"c2",
				{ goal: "Aborted" },
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			controller.onAgentSettled(
				{ aborted: true },
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.equal(sent.length, 0);

			// Shutdown clears pending claim.
			await controller.execute(
				"c3",
				{ goal: "Shutdown" },
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			controller.onSessionShutdown(
				{},
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
			assert.ok(claimSessionTransition(SESSION_ID, "handoff"));
			releaseSessionTransition(SESSION_ID);

			// Forged --tool-token on /handoff in non-TUI mode still hits the interactive guard.
			await handler(
				"--tool-token=forged",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ makeFakeCtx([], {
					mode: "rpc",
				}).ctx as never,
			);
		}
	});
});
