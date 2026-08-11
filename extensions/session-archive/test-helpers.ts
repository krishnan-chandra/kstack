/** Shared fixtures for session-archive tests. */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_SESSION_ID = "019ff001-deb2-7696-997e-8684026835d1";

export function sessionJsonl(
	entries: Record<string, unknown>[],
	header: Record<string, unknown> = {},
): string {
	const head = {
		type: "session",
		version: 3,
		id: TEST_SESSION_ID,
		timestamp: "2026-08-11T08:48:02.226Z",
		cwd: "/Users/test/Code/project",
		...header,
	};
	return [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

export function messageEntry(
	id: string,
	parentId: string | null,
	message: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type: "message", id, parentId, timestamp: "2026-08-11T08:49:00.000Z", message, ...extra };
}

export function userMessage(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1786438183624 };
}

export function assistantMessage(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret chain of thought" },
			{ type: "text", text },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
		],
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1786438183625,
	};
}

/** Minimal realistic session covering every searchable entry kind. */
export function richSessionJsonl(header: Record<string, unknown> = {}): string {
	return sessionJsonl(
		[
			{ type: "model_change", id: "m0", parentId: null, timestamp: "2026-08-11T08:48:03.000Z", provider: "openai", modelId: "gpt-5.6-sol" },
			messageEntry("u1", "m0", userMessage("hello archive world")),
			messageEntry("a1", "u1", assistantMessage("hi there, archiving works")),
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp: "2026-08-11T08:49:10.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "total 42 files listed" }],
					isError: false,
					timestamp: 1786438183626,
				},
			},
			{
				type: "message",
				id: "b1",
				parentId: "t1",
				timestamp: "2026-08-11T08:49:20.000Z",
				message: {
					role: "bashExecution",
					command: "echo archive-marker",
					output: "archive-marker",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1786438183627,
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "b1",
				timestamp: "2026-08-11T08:50:00.000Z",
				summary: "user discussed archiving markers",
				firstKeptEntryId: "b1",
				tokensBefore: 12345,
			},
			{
				type: "branch_summary",
				id: "s1",
				parentId: "c1",
				timestamp: "2026-08-11T08:51:00.000Z",
				fromId: "u1",
				summary: "branch explored alternate archive layout",
			},
			{
				type: "custom_message",
				id: "x1",
				parentId: "s1",
				timestamp: "2026-08-11T08:52:00.000Z",
				customType: "my-ext",
				content: "injected archive context",
				display: true,
			},
			{
				type: "custom",
				id: "x2",
				parentId: "x1",
				timestamp: "2026-08-11T08:52:30.000Z",
				customType: "my-ext",
				data: { count: 1 },
			},
			{
				type: "message",
				id: "img1",
				parentId: "x2",
				timestamp: "2026-08-11T08:53:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "look at this screenshot" },
						{ type: "image", data: "aGVsbG8tYmFzZTY0LWltYWdlLWRhdGE=", mimeType: "image/png" },
					],
					timestamp: 1786438183628,
				},
			},
			{ type: "session_info", id: "n1", parentId: "img1", timestamp: "2026-08-11T08:54:00.000Z", name: "archive test session" },
			{ type: "label", id: "l1", parentId: "n1", timestamp: "2026-08-11T08:55:00.000Z", targetId: "u1", label: "checkpoint-one" },
		],
		header,
	);
}

export interface TempTree {
	root: string;
	agentDir: string;
	archiveRoot: string;
	sessionDir: string;
	dbPath: string;
	writeSession: (id: string, content: string, name?: string) => string;
}

/** Build an isolated agent dir: sessions/ for active files, archive/ for output. */
export function makeTempTree(): TempTree {
	const root = mkdtempSync(join(tmpdir(), "pi-archive-test-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(agentDir, "sessions", "--project--");
	const archiveRoot = join(agentDir, "archive");
	mkdirSync(sessionDir, { recursive: true });
	return {
		root,
		agentDir,
		archiveRoot,
		sessionDir,
		dbPath: join(archiveRoot, "archive.sqlite3"),
		writeSession(id: string, content: string, name = "2026-08-11T08-48-02-226Z") {
			const path = join(sessionDir, `${name}_${id}.jsonl`);
			writeFileSync(path, content);
			return path;
		},
	};
}
