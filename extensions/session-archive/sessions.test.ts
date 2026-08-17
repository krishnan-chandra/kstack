import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionRows } from "./sessions.ts";

describe("buildSessionRows", () => {
	it("merges archive rows, identifies current active row, and sorts by last message", () => {
		const rows = buildSessionRows(
			[
				{
					id: "active",
					path: "/sessions/a.jsonl",
					cwd: "/a",
					firstMessage: "active first",
					created: new Date("2026-01-01"),
					modified: new Date("2026-01-03"),
				},
				{
					id: "shared",
					path: "/sessions/shared.jsonl",
					cwd: "/a",
					firstMessage: "active wins",
					created: new Date("2026-01-01"),
					modified: new Date("2026-01-04"),
				},
			],
			[
				{
					state: "archived" as const,
					sessionId: "archive",
					cwd: "/b",
					name: "Archived",
					firstUserText: "archive first",
					messageCount: 2,
					originalPath: "/sessions/b.jsonl",
					archivePath: "/archive/b.jsonl",
					lastError: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					lastMessageAt: "2026-01-05T00:00:00.000Z",
				},
				{
					state: "archived" as const,
					sessionId: "shared",
					cwd: "/b",
					name: null,
					firstUserText: null,
					messageCount: 1,
					originalPath: "/x",
					archivePath: "/y",
					lastError: null,
					createdAt: "2026-01-10T00:00:00.000Z",
					lastMessageAt: "2026-01-10T00:00:00.000Z",
				},
			],
			"/sessions/a.jsonl",
		);
		assert.deepEqual(
			rows.map((row) => row.id),
			["archive", "shared", "active"],
		);
		assert.equal(rows[2]?.kind, "active");
		assert.equal(rows[2]?.current, true);
		assert.equal(rows.filter((row) => row.id === "shared").length, 1);
	});

	it("surfaces error-state rows with actionable preserved-copy details", () => {
		const [row] = buildSessionRows(
			[],
			[
				{
					state: "error",
					sessionId: "broken-session",
					cwd: "/repo",
					name: "Broken restore",
					firstUserText: null,
					messageCount: 1,
					originalPath: "/sessions/broken.jsonl",
					archivePath: "/archive/broken.jsonl",
					lastError: "restore recovery failed: hash mismatch",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastMessageAt: null,
				},
			],
		);
		assert.equal(row?.kind, "error");
		if (row?.kind !== "error") assert.fail("expected error row");
		assert.match(row.detail, /broken-session/);
		assert.match(row.detail, /hash mismatch/);
		assert.match(row.detail, /\/sessions\/broken.jsonl/);
		assert.match(row.detail, /\/archive\/broken.jsonl/);
	});

	it("strips terminal control sequences from session labels and directories", () => {
		const [row] = buildSessionRows(
			[
				{
					id: "active",
					path: "/sessions/a.jsonl",
					cwd: "/repo/\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007",
					name: "safe\u001b[31m label\u0000",
					created: new Date("2026-01-01"),
					modified: new Date("2026-01-01"),
				},
			],
			[],
		);
		assert.equal(row?.label, "safe label");
		assert.equal(row?.cwd, "/repo/link");
	});
});
