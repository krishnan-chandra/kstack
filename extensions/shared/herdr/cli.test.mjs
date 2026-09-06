import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseResolveModelArgs, parseSubcommand } from "./cli.mjs";

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, "cli.mjs");

function runCli(args, env = {}) {
	return execFileAsync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	}).then(
		(result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
		(error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
	);
}

test("parseSubcommand accepts the documented subcommands", () => {
	assert.deepEqual(parseSubcommand(["resolve-model"]), { ok: true, subcommand: "resolve-model" });
	assert.deepEqual(parseSubcommand(["fanout"]), { ok: true, subcommand: "fanout" });
	assert.equal(parseSubcommand([]).ok, false);
	assert.equal(parseSubcommand(["bogus"]).ok, false);
});

test("parseResolveModelArgs requires one section and key", () => {
	assert.deepEqual(parseResolveModelArgs(["--section", "plan-adversary", "--key", "adversary"]), {
		ok: true,
		section: "plan-adversary",
		key: "adversary",
		model: undefined,
	});
	assert.equal(parseResolveModelArgs(["--section", "plan-adversary"]).ok, false);
	assert.equal(parseResolveModelArgs(["--bogus", "x"]).ok, false);
});

test("the CLI exits 2 with usage on syntax errors", async () => {
	const none = await runCli([]);
	assert.equal(none.code, 2);
	assert.match(none.stderr, /usage:/);
	const unknown = await runCli(["bogus"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /unknown subcommand: bogus/);
	const missing = await runCli(["resolve-model", "--section", "plan-adversary"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /--key is required/);
});

test("resolve-model loads aliases and the validated plan-adversary default", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-resolve-"));
	writeFileSync(
		join(agentDir, "kstack.json"),
		JSON.stringify({
			aliases: [{ label: "fable", model: "anthropic/claude-fable-5-1", thinking: "high" }],
			"plan-adversary": { adversary: "fable" },
		}),
	);
	const result = await runCli(["resolve-model", "--section", "plan-adversary", "--key", "adversary"], {
		PI_CODING_AGENT_DIR: agentDir,
	});
	assert.deepEqual(result, { code: 0, stdout: "anthropic/claude-fable-5-1:high\n", stderr: "" });
});

test("resolve-model accepts an explicit full model without config", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-explicit-"));
	const result = await runCli(
		["resolve-model", "--section", "plan-adversary", "--key", "adversary", "--model", "openai/gpt-5.6-astra:medium"],
		{ PI_CODING_AGENT_DIR: agentDir },
	);
	assert.deepEqual(result, { code: 0, stdout: "openai/gpt-5.6-astra:medium\n", stderr: "" });
});

test("resolve-model exits 1 with configuration guidance when no model exists", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-missing-"));
	const result = await runCli(["resolve-model", "--section", "plan-adversary", "--key", "adversary"], {
		PI_CODING_AGENT_DIR: agentDir,
	});
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Set it in kstack\.json or pass --model/);
});

test("fanout remains a declared slice-4 subcommand", async () => {
	const result = await runCli(["fanout"]);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /fanout is not implemented yet/);
});
