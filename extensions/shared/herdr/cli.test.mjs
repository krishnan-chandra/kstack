import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseSubcommand } from "./cli.mjs";

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, "cli.mjs");

function runCli(args) {
	return execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8" }).then(
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

test("the CLI exits 2 with usage for unknown or missing subcommands", async () => {
	const none = await runCli([]);
	assert.equal(none.code, 2);
	assert.match(none.stdout, /usage:/);
	const unknown = await runCli(["bogus"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stdout, /unknown subcommand: bogus/);
});

test("declared-but-unimplemented subcommands exit 2 with a stable path notice", async () => {
	for (const subcommand of ["resolve-model", "fanout"]) {
		const result = await runCli([subcommand]);
		assert.equal(result.code, 2);
		assert.match(result.stdout, new RegExp(`${subcommand} is not implemented yet`));
	}
});
