import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "./args.ts";

describe("kstack-router args parser", () => {
	it("accepts empty input", () => {
		const r = parseArgs("");
		assert.ok(r.ok);
		assert.equal(r.args.task, "");
		assert.equal(r.args.route, undefined);
	});

	it("parses task without flags", () => {
		const r = parseArgs("Refactor the config loader");
		assert.ok(r.ok);
		assert.equal(r.args.task, "Refactor the config loader");
		assert.equal(r.args.route, undefined);
	});

	it("parses --route flag", () => {
		const r = parseArgs("--route investigate What is the archive strategy?");
		assert.ok(r.ok);
		assert.equal(r.args.route, "investigate");
		assert.equal(r.args.task, "What is the archive strategy?");
	});

	it("accepts the review route", () => {
		const r = parseArgs("--route review Review the latest changes");
		assert.ok(r.ok);
		if (r.ok) {
			assert.equal(r.args.route, "review");
			assert.equal(r.args.task, "Review the latest changes");
		}
	});

	it("rejects removed implementation flags", () => {
		assert.ok(!parseArgs("--single Add feature X").ok);
		assert.ok(!parseArgs("--stack Split feature").ok);
		assert.ok(!parseArgs("--worktree Add isolated search").ok);
		assert.ok(!parseArgs("--change-kind refactor Simplify the loader").ok);
		assert.ok(!parseArgs("--no-adversary Draft the migration").ok);
		assert.ok(!parseArgs("--plan-only Draft the migration").ok);
	});

	it("uses -- to terminate flag parsing", () => {
		const r = parseArgs("--route land --pr 7 -- --task-with-dashes");
		assert.ok(r.ok);
		assert.equal(r.args.route, "land");
		assert.equal(r.args.prNumber, 7);
		assert.equal(r.args.task, "--task-with-dashes");
	});

	it("rejects duplicate --route", () => {
		const r = parseArgs("--route investigate --route land");
		assert.ok(!r.ok);
	});

	it("rejects unknown flags", () => {
		const r = parseArgs("--unknown flag");
		assert.ok(!r.ok);
	});

	it("rejects invalid route", () => {
		const r = parseArgs("--route invalid");
		assert.ok(!r.ok);
	});

	it("rejects oversized tasks", () => {
		const large = "x".repeat(33 * 1024);
		const r = parseArgs(large);
		assert.ok(!r.ok);
	});

	it("handles multibyte characters in task", () => {
		const r = parseArgs("--route investigate 日本語のテスト");
		assert.ok(r.ok);
		assert.equal(r.args.route, "investigate");
		assert.equal(r.args.task, "日本語のテスト");
	});

	it("supports quoted values", () => {
		const r = parseArgs('--route review "Add feature X"');
		assert.ok(r.ok);
		assert.equal(r.args.route, "review");
		assert.equal(r.args.task, "Add feature X");
	});

	it("handles single-quoted values", () => {
		const r = parseArgs("--route review 'Add feature X'");
		assert.ok(r.ok);
		assert.equal(r.args.route, "review");
		assert.equal(r.args.task, "Add feature X");
	});

	it("parses post-PR flags in mixed order and keeps the task", () => {
		const r = parseArgs("--pr 42 --route pr-autopilot --mode drive Address review threads");
		assert.ok(r.ok);
		assert.equal(r.args.route, "pr-autopilot");
		assert.equal(r.args.autopilotMode, "drive");
		assert.equal(r.args.prNumber, 42);
		assert.equal(r.args.task, "Address review threads");
	});

	it("parses land method and readiness flags", () => {
		const r = parseArgs("--route land --readiness watch --method squash --pr 7");
		assert.ok(r.ok);
		assert.equal(r.args.route, "land");
		assert.equal(r.args.readiness, "watch");
		assert.equal(r.args.landMethod, "squash");
		assert.equal(r.args.prNumber, 7);
		assert.equal(r.args.task, "");
	});

	it("rejects missing and invalid post-PR flag values", () => {
		assert.ok(!parseArgs("--mode").ok);
		assert.ok(!parseArgs("--mode turbo").ok);
		assert.ok(!parseArgs("--pr").ok);
		assert.ok(!parseArgs("--pr 0").ok);
		assert.ok(!parseArgs("--pr 1.5").ok);
		assert.ok(!parseArgs("--method merge").ok);
		assert.ok(!parseArgs("--readiness drive").ok);
	});

	it("rejects duplicate post-PR flags", () => {
		assert.ok(!parseArgs("--mode drive --mode check").ok);
		assert.ok(!parseArgs("--pr 1 --pr 2").ok);
		assert.ok(!parseArgs("--method squash --method rebase").ok);
		assert.ok(!parseArgs("--readiness check --readiness watch").ok);
	});
});
