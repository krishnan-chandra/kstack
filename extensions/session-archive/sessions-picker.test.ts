import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSessionToggle } from "./sessions-picker.ts";

describe("selectSessionToggle", () => {
	it("uses one RPC selection and returns a typed action", async () => {
		const row = {
			kind: "active" as const,
			id: "id",
			path: "/s",
			cwd: "/repo",
			modified: new Date(),
			created: new Date(),
			current: false,
			label: "Task",
		};
		const result = await selectSessionToggle(
			{
				hasUI: true,
				mode: "rpc",
				ui: { select: async (_title: string, options: string[]) => options[0], notify() {} },
			} as never,
			[row],
		);
		assert.equal(result, row);
	});

	it("uses a disambiguated RPC option when session labels collide", async () => {
		const rows = ["first", "second"].map((id) => ({
			kind: "active" as const,
			id,
			path: `/sessions/${id}.jsonl`,
			cwd: "/repo",
			modified: new Date("2026-01-01"),
			created: new Date("2026-01-01"),
			current: false,
			label: "Same label",
		}));
		const result = await selectSessionToggle(
			{
				hasUI: true,
				mode: "rpc",
				ui: { select: async (_title: string, options: string[]) => options[1], notify() {} },
			} as never,
			rows,
		);
		assert.equal(result, rows[1]);
	});
});
