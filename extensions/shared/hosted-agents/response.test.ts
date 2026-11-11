import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readResponse, responseMarker } from "./response.ts";

test("response collection rejects nonterminal, malformed, and unacknowledged output", async () => {
	const root = mkdtempSync(join(tmpdir(), "kstack-response-"));
	const file = join(root, "session.jsonl");
	const message = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: `${responseMarker("current")}\ncomplete` }],
	};
	try {
		for (const stopReason of ["error", "aborted", "length", "pending", "toolUse"]) {
			writeFileSync(file, `${JSON.stringify({ type: "message", message: { ...message, stopReason } })}\n`);
			await assert.rejects(readResponse(file, 0, "current", 100), /successful terminal/);
		}
		const valid = `${JSON.stringify({ type: "message", message })}\n`;
		writeFileSync(file, valid);
		assert.equal(await readResponse(file, 0, "current", 100), "complete");
		await assert.rejects(readResponse(file, 0, "old-request", 100), /acknowledgement/);
		await assert.rejects(readResponse(file, Buffer.byteLength(valid), "current", 100), /incomplete terminal/);
		writeFileSync(file, `${valid}{"type":`);
		await assert.rejects(readResponse(file, 0, "current", 100), /incomplete terminal/);
		writeFileSync(
			file,
			`${valid}${JSON.stringify({ type: "message", message: { role: "user", content: "unrelated new task" } })}\n`,
		);
		await assert.rejects(readResponse(file, 0, "current", 100), /successful terminal/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
