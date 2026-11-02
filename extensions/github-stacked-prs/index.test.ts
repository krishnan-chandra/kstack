import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestStackCapabilities, requestStackLanding, requestStackPublication } from "../shared/stack/channel.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import githubStackedPrsExtension, { renderOutcome } from "./index.ts";

function mockPi() {
	const handlers = new Map<string, Array<(value: BoundaryValue) => void>>();
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		events: {
			on: (event: string, handler: (value: BoundaryValue) => void) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			emit: (event: string, value: BoundaryValue) => {
				for (const handler of handlers.get(event) ?? []) handler(value);
			},
		},
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
	};
	return { pi, commands, tools };
}

describe("github-stacked-prs extension", () => {
	it("bounds rendered outcomes by UTF-8 bytes", () => {
		const rendered = renderOutcome({ status: "failed", error: "🧪".repeat(30_000) });
		assert.ok(Buffer.byteLength(rendered, "utf8") <= 50 * 1024);
		assert.equal(rendered.includes("�"), false);
	});

	it("includes a voice-aware metadata follow-up when publication creates a draft", () => {
		const rendered = renderOutcome({
			status: "completed",
			planId: "plan",
			publication: {
				topRef: "kstack/feature",
				pullRequests: [
					{
						ref: "kstack/feature",
						baseRef: "main",
						prNumber: 42,
						url: "https://example.test/pull/42",
						draft: true,
					},
				],
			},
			completedActions: [
				{ kind: "create-draft-pr", ref: "kstack/feature", prNumber: 42, url: "https://example.test/pull/42" },
			],
		});
		assert.match(rendered, /Immediately rewrite each new draft's title and body with the write-pr skill/);
		assert.match(rendered, /my-voice skill/);
	});

	it("emits the planning status during discovery and clears it on failure", async () => {
		for (const path of ["command", "tool"] as const) {
			let releaseExec: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined;
			const statuses: Array<{ key: string; value: string | undefined }> = [];
			let commandHandler: ((text: string, ctx: BoundaryValue) => Promise<void>) | undefined;
			let toolExecute:
				| ((
						id: string,
						params: BoundaryValue,
						signal: AbortSignal | undefined,
						onUpdate: BoundaryValue,
						ctx: BoundaryValue,
				  ) => Promise<BoundaryValue>)
				| undefined;

			const pi = {
				on: () => {},
				events: { on: () => {} },
				registerCommand: (_name: string, spec: { handler: (text: string, ctx: BoundaryValue) => Promise<void> }) => {
					commandHandler = spec.handler;
				},
				registerTool: (spec: {
					execute: (
						id: string,
						params: BoundaryValue,
						signal: AbortSignal | undefined,
						onUpdate: BoundaryValue,
						ctx: BoundaryValue,
					) => Promise<BoundaryValue>;
				}) => {
					toolExecute = spec.execute;
				},
				exec: () =>
					new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
						releaseExec = resolve;
					}),
			};
			githubStackedPrsExtension(
				/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never,
			);

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

			const running =
				path === "command"
					? commandHandler!(
							"publish --top kstack/example",
							/* SAFETY: Test double matches the ExtensionContext subset. */ ctx as never,
						)
					: toolExecute!(
							"review",
							{ top: "kstack/example" },
							undefined,
							undefined,
							/* SAFETY: Test double matches the ExtensionContext subset. */ ctx as never,
						);

			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(releaseExec, `${path}: discovery subprocess should be pending`);
			assert.deepEqual(statuses, [{ key: "gh-stack", value: "gh-stack: planning publication" }]);

			releaseExec({ code: 1, stdout: "", stderr: "review fixture: preflight blocked" });
			await running;
			assert.deepEqual(statuses, [
				{ key: "gh-stack", value: "gh-stack: planning publication" },
				{ key: "gh-stack", value: undefined },
			]);
		}
	});

	it("emits the initial publishing status for the delegated publication path and clears it on failure", async () => {
		const { pi } = mockPi();
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

		githubStackedPrsExtension(
			/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never,
		);

		const result = await requestStackPublication(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			{
				provider: "github",
				input: { repositoryPath: process.cwd(), manifestPath: "/nonexistent/manifest.json" },
				ctx: /* SAFETY: Test double matches the ExtensionCommandContext subset. */ ctx as never,
			},
		);

		assert.equal(result.handled, true);
		if (result.handled) assert.equal(result.outcome.status, "blocked");
		assert.deepEqual(statuses, [
			{ key: "gh-stack", value: "gh-stack: publishing" },
			{ key: "gh-stack", value: undefined },
		]);
	});

	it("emits the initial landing status for the delegated landing path and clears it on failure", async () => {
		const { pi } = mockPi();
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
				select: async () => undefined,
			},
		};

		githubStackedPrsExtension(
			/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never,
		);

		const result = await requestStackLanding(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			{
				provider: "github",
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
			{ key: "gh-stack", value: "gh-stack: landing" },
			{ key: "gh-stack", value: undefined },
		]);
	});

	it("claims GitHub capabilities and registers its one command/tool pair", async () => {
		const { pi, commands, tools } = mockPi();
		githubStackedPrsExtension(
			/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never,
		);
		const result = await requestStackCapabilities(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			"github",
		);
		assert.deepEqual(result, {
			handled: true,
			outcome: { schemaVersion: 1, publication: true, commands: ["publish"], tools: ["gh_stack_publish"] },
		});
		assert.deepEqual(commands, ["gh-stack"]);
		assert.deepEqual(tools, ["gh_stack_publish"]);
	});
});
