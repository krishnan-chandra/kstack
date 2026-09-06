import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestStackFrontierLand } from "./api.ts";
import landExtension from "./index.ts";
import { StackLandingLifecycle } from "./lifecycle.ts";

describe("StackLandingLifecycle", () => {
	it("aborts the active provider request without owning nested single-PR runs", () => {
		const lifecycle = new StackLandingLifecycle();
		const signal = lifecycle.begin();
		assert.ok(signal);
		assert.equal(signal.aborted, false);
		assert.equal(lifecycle.abort(), true);
		assert.equal(signal.aborted, true);
		lifecycle.end(signal);
		assert.equal(lifecycle.abort(), false);
	});
});

describe("land registration", () => {
	it("registers the command, shortcut, renderer, and lifecycle handlers without launching a subprocess", () => {
		const commands: string[] = [];
		const shortcuts: string[] = [];
		const events: string[] = [];
		const renderers: string[] = [];
		const lifecycleHandlers: Array<() => void> = [];
		landExtension(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				on: (name: string, handler: () => void) => {
					events.push(name);
					if (name === "session_start" || name === "session_shutdown") lifecycleHandlers.push(handler);
				},
				registerShortcut: (name: string) => {
					shortcuts.push(name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
				registerMessageRenderer: (name: string) => {
					renderers.push(name);
				},
				events: { on: (name: string) => events.push(name) },
			} as never,
		);
		assert.deepEqual(commands, ["land"]);
		assert.ok(shortcuts.includes("ctrl+shift+l"));
		assert.deepEqual(renderers, ["land"]);
		assert.ok(events.includes("session_start"));
		assert.ok(events.includes("session_shutdown"));
		for (const handler of lifecycleHandlers) handler();
	});

	it("scopes jj PR lookup and preserves repository-resolution cancellation", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const root = mkdtempSync(join(tmpdir(), "kstack-land-jj-index-"));
		const agentDir = join(root, "agent");
		try {
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "kstack.json"), `${JSON.stringify({ vcs: { backend: "jj" } })}\n`);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const sha = "a".repeat(40);
			const ghCalls: string[][] = [];
			const controller = new AbortController();
			const notifications: Array<{ message: string; level: string }> = [];
			let cancelResolution = false;
			let commandHandler: ((text: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
			const messages: Array<{ customType: string; content: string; details: { status: string } }> = [];
			const pi = {
				on: () => {},
				registerShortcut: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (_name: string, command: { handler: typeof commandHandler }) => {
					commandHandler = command.handler;
				},
				sendMessage: (message: { customType: string; content: string; details: { status: string } }) =>
					messages.push(message),
				exec: async (program: string, args: string[]) => {
					if (program === "jj") {
						const command = args.join(" ");
						if (command === "--version") return { code: 0, stdout: "jj 0.44.0\n", stderr: "" };
						if (command === "workspace root") return { code: 0, stdout: `${root}\n`, stderr: "" };
						if (command === "git root") return { code: 0, stdout: "/backing/repo/.git\n", stderr: "" };
						if (command.startsWith("config get ")) return { code: 0, stdout: "configured\n", stderr: "" };
						if (command === "git remote list --no-pager --color=never") {
							if (cancelResolution) {
								controller.abort();
								return { code: 130, stdout: "", stderr: "aborted" };
							}
							return { code: 0, stdout: "origin git@github.com:acme/widgets.git\n", stderr: "" };
						}
						if (command.startsWith("--no-pager bookmark list -r @")) {
							return { code: 0, stdout: "feature\n", stderr: "" };
						}
						return { code: 1, stdout: "", stderr: `unexpected jj command: ${command}` };
					}
					if (program !== "gh") return { code: 1, stdout: "", stderr: `unexpected command: ${program}` };
					ghCalls.push([...args]);
					if ((args[0] === "pr" || args[0] === "run") && !args.includes("--repo")) {
						return { code: 1, stdout: "", stderr: "ambient Git discovery is unavailable" };
					}
					if (args[0] === "pr" && args[1] === "list") {
						return {
							code: 0,
							stdout: JSON.stringify([{ number: 7, headRefName: "feature" }]),
							stderr: "",
						};
					}
					if (args[0] === "pr" && args[1] === "view") {
						return {
							code: 0,
							stdout: JSON.stringify({
								number: 7,
								url: "https://github.com/acme/widgets/pull/7",
								title: "Scoped jj land",
								state: "OPEN",
								isDraft: false,
								headRefName: "feature",
								baseRefName: "main",
								headRefOid: sha,
								mergeable: "MERGEABLE",
								mergeStateStatus: "CLEAN",
								mergedAt: null,
								mergeCommit: null,
							}),
							stderr: "",
						};
					}
					return { code: 1, stdout: "", stderr: `unexpected gh command: ${args.join(" ")}` };
				},
				events: { on: () => () => {}, emit: () => {} },
			};
			landExtension(
				/* SAFETY: This fixture implements every Pi capability exercised by the command path. */ pi as never,
			);
			assert.ok(commandHandler);
			const ctx = /* SAFETY: This fixture supplies every context member exercised by the command path. */ {
				cwd: root,
				hasUI: true,
				signal: controller.signal,
				waitForIdle: async () => {},
				ui: {
					notify: (message: string, level: string) => notifications.push({ message, level }),
					setStatus: () => {},
					select: async () => "squash",
					confirm: async () => true,
				},
			} as never;

			await commandHandler("", ctx);
			await commandHandler("--pr 7", ctx);

			assert.ok(ghCalls.some((args) => args[0] === "pr" && args[1] === "list"));
			assert.ok(ghCalls.filter((args) => args[0] === "pr" && args[1] === "view").length >= 2);
			for (const args of ghCalls) {
				if (args[0] === "pr" || args[0] === "run") assert.deepEqual(args.slice(-2), ["--repo", "acme/widgets"]);
			}
			assert.equal(messages.length, 2);
			assert.ok(messages.every((message) => /jj-stacked-prs extension is unavailable/i.test(message.content)));

			cancelResolution = true;
			await commandHandler("--pr 7", ctx);
			assert.equal(messages.length, 2, "cancelled setup must not start a landing run");
			assert.deepEqual(notifications.at(-1), { message: "Landing was cancelled.", level: "info" });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits one result message for command and channel entry paths", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "kstack-land-index-"));
		writeFileSync(join(agentDir, "kstack.json"), `${JSON.stringify({ vcs: { backend: "git" } })}\n`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const SHA = "a".repeat(40);
			const listeners = new Map<string, Array<(value: never) => void>>();
			let commandHandler: ((text: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
			const messages: Array<{ customType: string; details: { status: string } }> = [];
			const pi = {
				on: () => {},
				registerShortcut: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (_name: string, command: { handler: typeof commandHandler }) => {
					commandHandler = command.handler;
				},
				sendMessage: (message: { customType: string; details: { status: string } }) => messages.push(message),
				exec: async (_command: string, args: string[]) => {
					if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
					if (args[0] === "repo") {
						return {
							code: 0,
							stdout: args.includes("-q")
								? "o/r\n"
								: JSON.stringify({
										nameWithOwner: "o/r",
										defaultBranchRef: { name: "main" },
										squashMergeAllowed: true,
										rebaseMergeAllowed: false,
									}),
							stderr: "",
						};
					}
					if (args[0] === "pr" && args[1] === "view") {
						return {
							code: 0,
							stdout: JSON.stringify({
								number: 7,
								url: "https://github.com/o/r/pull/7",
								title: "x",
								state: "OPEN",
								isDraft: false,
								headRefName: "feature",
								baseRefName: "main",
								headRefOid: SHA,
								mergeable: "MERGEABLE",
								mergeStateStatus: "CLEAN",
								mergedAt: null,
								mergeCommit: null,
							}),
							stderr: "",
						};
					}
					return { code: 0, stdout: "", stderr: "" };
				},
				events: {
					on: (name: string, listener: (value: never) => void) => {
						const current = listeners.get(name) ?? [];
						current.push(listener);
						listeners.set(name, current);
					},
					emit: (name: string, value: never) => {
						for (const listener of listeners.get(name) ?? []) listener(value);
					},
				},
			};
			landExtension(
				/* SAFETY: This fixture implements the Pi methods exercised by the registered paths. */ pi as never,
			);
			const ctx = /* SAFETY: The fixture supplies every context member exercised by command and channel handlers. */ {
				cwd: "/repo",
				hasUI: true,
				waitForIdle: async () => {},
				ui: {
					notify: () => {},
					setStatus: () => {},
					select: async () => "squash",
					confirm: async () => true,
				},
			} as never;
			assert.ok(commandHandler);
			await commandHandler("--pr 7 --method squash", ctx);
			await requestStackFrontierLand(/* SAFETY: This fixture implements the request event bus. */ pi as never, {
				options: { target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash", cwd: "/repo" },
				expectedHeadSha: SHA,
				ctx,
			});
			assert.deepEqual(
				messages.map((message) => [message.customType, message.details.status]),
				[
					["land", "blocked"],
					["land", "blocked"],
				],
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
