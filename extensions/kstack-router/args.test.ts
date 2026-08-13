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

	it("parses --single flag", () => {
		const r = parseArgs("--single Add feature X");
		assert.ok(r.ok);
		assert.equal(r.args.delivery, "single");
		assert.equal(r.args.task, "Add feature X");
	});

	it("parses --stack flag", () => {
		const r = parseArgs("--stack Split feature");
		assert.ok(r.ok);
		assert.equal(r.args.delivery, "stack");
		assert.equal(r.args.task, "Split feature");
	});

	it("parses --worktree and rejects stack composition", () => {
		const r = parseArgs("--route change --worktree Add isolated search");
		assert.ok(r.ok);
		assert.equal(r.args.worktree, true);
		assert.equal(r.args.delivery, "single");
		assert.ok(!parseArgs("--stack --worktree Add isolated search").ok);
		assert.ok(!parseArgs("--worktree --worktree Add isolated search").ok);
	});

	it("parses --route with --stack", () => {
		const r = parseArgs("--route change --stack Implement CI pipeline");
		assert.ok(r.ok);
		assert.equal(r.args.route, "change");
		assert.equal(r.args.delivery, "stack");
		assert.equal(r.args.task, "Implement CI pipeline");
	});

	it("parses an explicit change-kind override", () => {
		const r = parseArgs("--route change --change-kind refactor Simplify the loader");
		assert.ok(r.ok);
		assert.equal(r.args.changeKind, "refactor");
		assert.equal(r.args.task, "Simplify the loader");
	});

	it("rejects an invalid change-kind override", () => {
		assert.ok(!parseArgs("--change-kind rewrite Update the loader").ok);
	});

	it("uses -- to terminate flag parsing", () => {
		const r = parseArgs("--route change --single -- --task-with-dashes");
		assert.ok(r.ok);
		assert.equal(r.args.route, "change");
		assert.equal(r.args.delivery, "single");
		assert.equal(r.args.task, "--task-with-dashes");
	});

	it("rejects duplicate --route", () => {
		const r = parseArgs("--route investigate --route change");
		assert.ok(!r.ok);
	});

	it("rejects duplicate delivery flags", () => {
		const r = parseArgs("--single --stack");
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
		const r = parseArgs('--route change "Add feature X"');
		assert.ok(r.ok);
		assert.equal(r.args.route, "change");
		assert.equal(r.args.task, "Add feature X");
	});

	it("handles single-quoted values", () => {
		const r = parseArgs("--route change 'Add feature X'");
		assert.ok(r.ok);
		assert.equal(r.args.route, "change");
		assert.equal(r.args.task, "Add feature X");
	});
});