import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { emptyUsage, readUsageSince, usageOffset } from "./session-usage.ts";

function assistantMessage(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}): string {
	return `${JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost } },
		},
	})}\n`;
}

describe("session-usage", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "kstack-session-usage-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns zero usage for a missing file", () => {
		const result = readUsageSince(join(dir, "missing.jsonl"), 0);
		assert.deepEqual(result.usage, emptyUsage());
		assert.equal(result.nextOffset, 0);
	});

	it("sums assistant message usage and turns from complete lines", () => {
		const file = join(dir, "basic.jsonl");
		writeFileSync(
			file,
			`${assistantMessage({ input: 100, output: 10, cacheRead: 1, cacheWrite: 2, cost: 0.5 })}${assistantMessage({
				input: 200,
				output: 20,
				cacheRead: 3,
				cacheWrite: 4,
				cost: 0.25,
			})}`,
		);
		const result = readUsageSince(file, 0);
		assert.deepEqual(result.usage, {
			input: 300,
			output: 30,
			cacheRead: 4,
			cacheWrite: 6,
			cost: 0.75,
			turns: 2,
		});
		assert.equal(result.nextOffset, Buffer.byteLength(readFileSync(file, "utf8")));
	});

	it("parses only bytes appended after the recorded offset", () => {
		const file = join(dir, "append.jsonl");
		writeFileSync(file, assistantMessage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }));
		const first = readUsageSince(file, 0);
		assert.equal(first.usage.turns, 1);
		appendFileSync(file, assistantMessage({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 }));
		const second = readUsageSince(file, first.nextOffset);
		assert.deepEqual(second.usage, { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
	});

	it("skips malformed lines and non-assistant messages", () => {
		const file = join(dir, "mixed.jsonl");
		writeFileSync(
			file,
			`${[
				"not json at all",
				JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
				JSON.stringify({ type: "other" }),
				assistantMessage({ input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 }),
			].join("\n")}\n`,
		);
		const result = readUsageSince(file, 0);
		assert.deepEqual(result.usage, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 });
	});

	it("leaves a partial trailing line for the next read", () => {
		const file = join(dir, "partial.jsonl");
		const line = assistantMessage({ input: 9, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 });
		writeFileSync(file, line.slice(0, line.length - 10));
		const first = readUsageSince(file, 0);
		assert.deepEqual(first.usage, emptyUsage());
		assert.equal(first.nextOffset, 0);
		appendFileSync(file, line.slice(line.length - 10));
		const second = readUsageSince(file, first.nextOffset);
		assert.equal(second.usage.turns, 1);
		assert.equal(second.usage.input, 9);
	});

	it("reports the file size as the next offset when nothing new was appended", () => {
		const file = join(dir, "settled.jsonl");
		writeFileSync(file, assistantMessage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }));
		const offset = usageOffset(file);
		const result = readUsageSince(file, offset);
		assert.deepEqual(result.usage, emptyUsage());
		assert.equal(result.nextOffset, offset);
	});

	it("usageOffset is 0 for a file that does not exist yet", () => {
		assert.equal(usageOffset(join(dir, "nope.jsonl")), 0);
		assert.equal(existsSync(join(dir, "nope.jsonl")), false);
	});
});
