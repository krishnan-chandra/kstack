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

	it("requires top and remote for plan/publish/sync", () => {
		assert.equal(parseJjStackArgs("plan --top feat").ok, false);
		assert.equal(parseJjStackArgs("publish --remote origin").ok, false);
		assert.deepEqual(parseJjStackArgs("sync --top feat --remote origin"), {
			ok: true,
			command: { action: "sync", top: "feat", remote: "origin", trunk: "trunk()", maxStack: 50 },
		});
	});

	it("requires merged, top, and remote for advance", () => {
		assert.equal(parseJjStackArgs("advance --top feat --remote origin").ok, false);
		assert.deepEqual(parseJjStackArgs("advance --merged feat1 --top feat2 --remote origin"), {
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
	});

	it("parses land with watch default and optional method", () => {
		assert.deepEqual(parseJjStackArgs("land --top feat2 --remote origin"), {
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
		assert.deepEqual(parseJjStackArgs("land --top feat2 --remote origin --method squash --readiness check"), {
			ok: true,
			command: {
				action: "land",
				top: "feat2",
				remote: "origin",
				trunk: "trunk()",
				maxStack: 50,
				method: "squash",
				readiness: "check",
			},
		});
		assert.equal(parseJjStackArgs("land --top feat2 --remote origin --method merge").ok, false);
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
		assert.ok(completeJjStackArgs("").some((item) => item.value === "inspect"));
		assert.ok(completeJjStackArgs("pub").some((item) => item.value === "publish"));
		assert.ok(completeJjStackArgs("plan --").some((item) => item.value === "--top"));
		assert.ok(completeJjStackArgs("").some((item) => item.value === "land"));
		assert.ok(completeJjStackArgs("land --").some((item) => item.value === "--method"));
		assert.ok(completeJjStackArgs("publish --").some((item) => item.value === "--ready"));
	});
});
