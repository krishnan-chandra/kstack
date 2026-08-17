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
					sessionId: "archive",
					cwd: "/b",
					name: "Archived",
					firstUserText: "archive first",
					messageCount: 2,
					originalPath: "/sessions/b.jsonl",
					archivePath: "/archive/b.jsonl",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastMessageAt: "2026-01-05T00:00:00.000Z",
				},
				{
					sessionId: "shared",
					cwd: "/b",
					name: null,
					firstUserText: null,
					messageCount: 1,
					originalPath: "/x",
					archivePath: "/y",
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
