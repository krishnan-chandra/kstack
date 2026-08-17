import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { commandFallthroughResult, matchCommandFallthrough } from "./command-fallthrough.ts";

const commands = new Set(["fast-implement", "kstack"]);

describe("matchCommandFallthrough", () => {
	it("matches a newline after a guarded command name and preserves multiline arguments", () => {
		assert.deepEqual(matchCommandFallthrough("/fast-implement\n\n--worktree\nfix it", commands), {
			command: "fast-implement",
			args: "--worktree\nfix it",
		});
	});

	it("accepts CRLF input and trims horizontal whitespace before the newline", () => {
		assert.deepEqual(matchCommandFallthrough("/kstack \t\r\n--route fast-change task", commands), {
			command: "kstack",
			args: "--route fast-change task",
		});
	});

	it("does not claim unknown commands or normal command syntax", () => {
		assert.equal(matchCommandFallthrough("/unknown\ntask", commands), undefined);
		assert.equal(matchCommandFallthrough("/fast-implement task", commands), undefined);
	});
});

describe("commandFallthroughResult", () => {
	it("blocks guarded multiline commands with actionable feedback", () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const result = commandFallthroughResult(
			{ source: "interactive", text: "/fast-implement\n--worktree fix it" },
			commands,
			(message, level) => notifications.push({ message, level }),
		);

		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(notifications, [
			{
				message:
					"/fast-implement was not run because Pi dispatches extension commands only when the name is followed by a literal space. Retry as /fast-implement --worktree fix it",
				level: "error",
			},
		]);
	});

	it("passes extension-injected and unknown input through", () => {
		const notify = () => assert.fail("should not notify");
		assert.deepEqual(
			commandFallthroughResult({ source: "extension", text: "/fast-implement\ntask" }, commands, notify),
			{ action: "continue" },
		);
		assert.deepEqual(commandFallthroughResult({ source: "rpc", text: "/unknown\ntask" }, commands, notify), {
			action: "continue",
		});
	});

	it("blocks guarded RPC fallthrough instead of sending it to the model", () => {
		const notifications: string[] = [];
		assert.deepEqual(
			commandFallthroughResult({ source: "rpc", text: "/fast-implement\ntask" }, commands, (message) =>
				notifications.push(message),
			),
			{ action: "handled" },
		);
		assert.equal(notifications.length, 1);
	});
});

describe("guard registration", () => {
	it("covers every guarded session-archive command before its runtime gate", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "session-archive", "index.ts"), "utf8");
		const guard = source.search(
			/guardCommandFallthrough\s*\(\s*pi,\s*"session-archive",\s*"sessions",\s*"session-archive-other",\s*"session-archive-all",?\s*\)/,
		);
		assert.notEqual(guard, -1);
		assert.ok(guard < source.indexOf('await import("node:sqlite")'));
	});
});
