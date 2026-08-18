import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeJjStackArgs, parseJjStackArgs } from "./args.ts";

describe("parseJjStackArgs", () => {
	it("parses inspect with optional top", () => {
		assert.deepEqual(parseJjStackArgs("inspect --top feat2 --trunk trunk() --max-stack 10"), {
			ok: true,
			command: { action: "inspect", top: "feat2", trunk: "trunk()", maxStack: 10 },
		});
	});

	it("requires top and defaults remote to origin for plan/publish/sync", () => {
		assert.deepEqual(parseJjStackArgs("plan --top feat"), {
			ok: true,
			command: { action: "plan", top: "feat", remote: "origin", trunk: "trunk()", maxStack: 50 },
		});
		assert.equal(parseJjStackArgs("publish --remote origin").ok, false);
		assert.deepEqual(parseJjStackArgs("sync --top feat --remote upstream"), {
			ok: true,
			command: { action: "sync", top: "feat", remote: "upstream", trunk: "trunk()", maxStack: 50 },
		});
	});

	it("requires merged and top for advance with optional remote", () => {
		assert.equal(parseJjStackArgs("advance --top feat").ok, false);
		assert.deepEqual(parseJjStackArgs("advance --merged feat1 --top feat2"), {
			ok: true,
			command: {
				action: "advance",
				merged: "feat1",
				top: "feat2",
				remote: "origin",
				trunk: "trunk()",
				maxStack: 50,
			},
		});
		assert.deepEqual(parseJjStackArgs("advance --merged feat1 --top feat2 --remote upstream"), {
			ok: true,
			command: {
				action: "advance",
				merged: "feat1",
				top: "feat2",
				remote: "upstream",
				trunk: "trunk()",
				maxStack: 50,
			},
		});
	});

	it("parses land with watch default and optional method/remote", () => {
		assert.deepEqual(parseJjStackArgs("land --top feat2"), {
			ok: true,
			command: {
				action: "land",
				top: "feat2",
				remote: "origin",
				trunk: "trunk()",
				maxStack: 50,
				method: undefined,
				readiness: "watch",
			},
		});
		assert.deepEqual(parseJjStackArgs("land --top feat2 --remote upstream --method squash --readiness check"), {
			ok: true,
			command: {
				action: "land",
				top: "feat2",
				remote: "upstream",
				trunk: "trunk()",
				maxStack: 50,
				method: "squash",
				readiness: "check",
			},
		});
		assert.equal(parseJjStackArgs("land --top feat2 --method merge").ok, false);
	});

	it("parses publish --ready as a boolean flag", () => {
		assert.deepEqual(parseJjStackArgs("publish --top feat2 --remote origin --ready"), {
			ok: true,
			command: { action: "publish", top: "feat2", remote: "origin", trunk: "trunk()", maxStack: 50, ready: true },
		});
		assert.deepEqual(parseJjStackArgs("publish --top feat2 --remote origin"), {
			ok: true,
			command: { action: "publish", top: "feat2", remote: "origin", trunk: "trunk()", maxStack: 50, ready: false },
		});
	});

	it("rejects unknown actions, unknown flags, and duplicates", () => {
		assert.equal(parseJjStackArgs("explode").ok, false);
		assert.equal(parseJjStackArgs("inspect --repo /tmp").ok, false);
		assert.equal(parseJjStackArgs("inspect --top a --top b").ok, false);
		assert.equal(parseJjStackArgs("inspect --max-stack 0").ok, false);
	});
});

describe("completeJjStackArgs", () => {
	it("completes actions and flags", () => {
		assert.ok(completeJjStackArgs("")?.some((item) => item.value === "inspect"));
		assert.ok(completeJjStackArgs("pub")?.some((item) => item.value === "publish"));
		assert.ok(completeJjStackArgs("plan --")?.some((item) => item.value === "plan --top"));
		assert.ok(completeJjStackArgs("")?.some((item) => item.value === "land"));
		assert.ok(completeJjStackArgs("land --")?.some((item) => item.value === "land --method"));
		assert.ok(completeJjStackArgs("publish --")?.some((item) => item.value === "publish --ready"));
	});

	it("preserves earlier tokens and completes finite land values", () => {
		assert.deepEqual(completeJjStackArgs("land --top feat --method "), [
			{ value: "land --top feat --method squash", label: "squash" },
			{ value: "land --top feat --method rebase", label: "rebase" },
		]);
		assert.deepEqual(completeJjStackArgs("land --readiness w"), [{ value: "land --readiness watch", label: "watch" }]);
	});

	it("does not guess bookmark or remote values", () => {
		assert.equal(completeJjStackArgs("plan --top "), null);
		assert.equal(completeJjStackArgs("plan --top fe"), null);
		assert.equal(completeJjStackArgs("sync --remote "), null);
	});
});
