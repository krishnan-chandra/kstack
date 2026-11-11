import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { councilPaths, initialCouncilState, writeManifest, writeState } from "../council/store.ts";
import { parseCouncilArgs, parseFanoutArgs, parseSubcommand } from "./cli.mjs";

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, "cli.mjs");

function cleanTerminalEnv(overrides = {}) {
	const base = { ...process.env };
	for (const key of Object.keys(base)) {
		if (key.startsWith("HERDR_") || key.startsWith("REX_")) delete base[key];
	}
	return { ...base, ...overrides };
}

function runCli(args, env = {}) {
	return execFileAsync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: cleanTerminalEnv(env),
	}).then(
		(result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
		(error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
	);
}

test("parseSubcommand accepts the documented subcommands", () => {
	assert.deepEqual(parseSubcommand(["preflight"]), { ok: true, subcommand: "preflight" });
	assert.deepEqual(parseSubcommand(["fanout"]), { ok: true, subcommand: "fanout" });
	assert.deepEqual(parseSubcommand(["council"]), { ok: true, subcommand: "council" });
	assert.equal(parseSubcommand(["resolve-model"]).ok, false);
	assert.equal(parseSubcommand(["ask"]).ok, false);
	assert.equal(parseSubcommand([]).ok, false);
	assert.equal(parseSubcommand(["bogus"]).ok, false);
});

test("the CLI exits 2 with usage on syntax errors", async () => {
	const none = await runCli([]);
	assert.equal(none.code, 2);
	assert.match(none.stderr, /usage:/);
	const unknown = await runCli(["bogus"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /unknown subcommand: bogus/);
});

test("parseFanoutArgs accepts documented flags and validates inputs", () => {
	assert.deepEqual(parseFanoutArgs(["--spec", "/path/spec.json", "--out", "/path/out.json"]), {
		ok: true,
		spec: "/path/spec.json",
		out: "/path/out.json",
		label: undefined,
		maxConcurrency: undefined,
	});
	assert.deepEqual(
		parseFanoutArgs([
			"--spec",
			"/path/spec.json",
			"--out",
			"/path/out.json",
			"--label",
			"test-run",
			"--max-concurrency",
			"3",
		]),
		{
			ok: true,
			spec: "/path/spec.json",
			out: "/path/out.json",
			label: "test-run",
			maxConcurrency: 3,
		},
	);
	assert.equal(parseFanoutArgs(["--out", "/path/out.json"]).ok, false);
	assert.equal(parseFanoutArgs(["--spec", "/path/spec.json"]).ok, false);
	assert.equal(parseFanoutArgs(["--spec", "/path/spec.json", "--out"]).ok, false);
	assert.equal(
		parseFanoutArgs(["--spec", "/path/spec.json", "--out", "/path/out.json", "--max-concurrency", "0"]).ok,
		false,
	);
	assert.equal(
		parseFanoutArgs(["--spec", "/path/spec.json", "--out", "/path/out.json", "--max-concurrency", "9"]).ok,
		false,
	);
	assert.equal(parseFanoutArgs(["--spec", "/path/spec.json", "--out", "/path/out.json", "--unknown", "x"]).ok, false);
});

test("fanout exits 2 with usage on syntax errors", async () => {
	const missing = await runCli(["fanout"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /--spec is required/);
	const missingOut = await runCli(["fanout", "--spec", "/tmp/s.json"]);
	assert.equal(missingOut.code, 2);
	assert.match(missingOut.stderr, /--out is required/);
});

test("fanout exits 1 when the spec file cannot be read or parsed", async () => {
	const result = await runCli(["fanout", "--spec", "/nonexistent/spec.json", "--out", "/tmp/out.json"]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Could not read spec file/);
});

test("fanout exits 1 when spec validation fails", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kstack-fanout-badspec-"));
	const specPath = join(dir, "bad-spec.json");
	writeFileSync(specPath, JSON.stringify({ owner: "arena", label: "x", cwd: "relative/path", tasks: [] }));
	const result = await runCli(["fanout", "--spec", specPath, "--out", join(dir, "out.json")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /fanout cwd must be absolute/);
});

test("fanout exits 1 when preflight fails outside Herdr", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kstack-fanout-preflight-"));
	const specPath = join(dir, "valid-spec.json");
	const promptPath = join(dir, "prompt.md");
	writeFileSync(promptPath, "do something\n");
	writeFileSync(
		specPath,
		JSON.stringify({
			owner: "arena",
			label: "test",
			cwd: dir,
			tasks: [
				{
					label: "terra",
					model: "openai/gpt-5.6-terra",
					cwd: dir,
					promptFile: promptPath,
					outputFile: join(dir, "out.md"),
					access: "read-only",
					noContextFiles: true,
					timeoutMinutes: 10,
				},
			],
		}),
	);
	const result = await runCli(["fanout", "--spec", specPath, "--out", join(dir, "out.json")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /HERDR_ENV/);
	assert.match(result.stderr, /REX_SESSION/);
});

test("preflight selects Herdr or Rex and refuses neither or both without spawning CLIs", async () => {
	const root = mkdtempSync(join(tmpdir(), "kstack-cli-preflight-"));
	try {
		const binDir = join(root, "bin");
		const logFile = join(root, "spawns.log");
		mkdirSync(binDir);
		mkdirSync(join(root, "extensions"));
		writeFileSync(join(root, "extensions", "herdr-agent-state.ts"), "");
		writeFileSync(
			join(binDir, "herdr"),
			`#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logFile)}, "herdr\\n");
if (process.argv[2] === "pane" && process.argv[3] === "layout") {
	process.stdout.write(JSON.stringify({ result: { type: "pane_layout", layout: { area: { width: 240, height: 60 }, tab_id: "w1:t1" } } }));
} else process.stdout.write("running\\n");
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(binDir, "rex"),
			`#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logFile)}, "rex:" + process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "whoami") {
  process.stdout.write(JSON.stringify({ api_revision: 12, session_id: "session:1", window_id: "window:1", block_id: "block:1" }));
} else if (args[0] === "block" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify({ block: { block_id: "block:1", window_id: "window:1", label: "shell" }, api: { methods: { program_status: {} } } }));
} else if (args[0] === "block" && args[1] === "call" && args.at(-1) === "program_status") {
  process.stdout.write(JSON.stringify({ records: [{ state: "working", app: "pi", updated_at: "2026-11-11T16:00:00Z", owner: { pid: 1, name: "node" } }] }));
}
`,
			{ mode: 0o755 },
		);

		const badFlag = await runCli(["preflight", "--bogus"]);
		assert.equal(badFlag.code, 2);

		const neither = await runCli(["preflight"], { PATH: `${binDir}:${process.env.PATH}` });
		assert.equal(neither.code, 1);
		const neitherJson = JSON.parse(neither.stdout);
		assert.equal(neitherJson.ok, false);
		assert.match(neitherJson.error, /HERDR_ENV/);
		assert.match(neitherJson.error, /REX_SESSION/);

		const both = await runCli(["preflight"], {
			PATH: `${binDir}:${process.env.PATH}`,
			HERDR_ENV: "1",
			REX_SESSION: "session:1",
		});
		assert.equal(both.code, 1);
		const bothJson = JSON.parse(both.stdout);
		assert.equal(bothJson.ok, false);
		assert.match(bothJson.error, /Both Herdr and Rex/);
		assert.equal(readFileSync(logFile, { flag: "a+", encoding: "utf8" }), "");

		const herdrOnly = await runCli(["preflight"], {
			PATH: `${binDir}:${process.env.PATH}`,
			HERDR_ENV: "1",
			HERDR_WORKSPACE_ID: "w1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_TAB_ID: "w1:tStale",
			PI_CODING_AGENT_DIR: root,
		});
		assert.equal(herdrOnly.code, 0, herdrOnly.stdout + herdrOnly.stderr);
		assert.deepEqual(JSON.parse(herdrOnly.stdout), {
			ok: true,
			backend: "herdr",
			caller: { paneId: "w1:p1", tabId: "w1:t1" },
		});

		const rexOnly = await runCli(["preflight"], {
			PATH: `${binDir}:${process.env.PATH}`,
			REX_SESSION: "session:1",
			REX_BLOCK: "block:1",
		});
		assert.equal(rexOnly.code, 0, rexOnly.stdout + rexOnly.stderr);
		assert.deepEqual(JSON.parse(rexOnly.stdout), {
			ok: true,
			backend: "rex",
			caller: { paneId: "block:1", tabId: "window:1" },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parseCouncilArgs parses each action and requires absolute paths", () => {
	const open = parseCouncilArgs([
		"open",
		"--dir",
		"/c",
		"--slug",
		"demo",
		"--planner-model",
		"anthropic/claude-opus-5-5",
		"--seats",
		"astra, argon",
	]);
	assert.equal(open.ok, true);
	assert.deepEqual([open.action, open.dir, open.slug, open.seats], ["open", "/c", "demo", ["astra", "argon"]]);
	const round = parseCouncilArgs(["round", "--dir", "/c", "--plan", "/p.md", "--response", "/r.md", "--verify"]);
	assert.equal(round.ok, true);
	assert.deepEqual([round.plan, round.response, round.verify, round.task], ["/p.md", "/r.md", true, undefined]);
	const override = parseCouncilArgs(["override", "--dir", "/c", "--finding", "A/B-1", "--reason", "accepted risk"]);
	assert.deepEqual([override.finding, override.reason], ["A/B-1", "accepted risk"]);
	assert.equal(parseCouncilArgs(["close", "--dir", "/c"]).ok, true);

	assert.match(parseCouncilArgs([]).error, /unknown council action/);
	assert.match(parseCouncilArgs(["vote"]).error, /unknown council action: vote/);
	assert.match(parseCouncilArgs(["round", "--dir", "/c"]).error, /--plan is required/);
	assert.match(parseCouncilArgs(["round", "--dir", "c", "--plan", "/p"]).error, /--dir must be an absolute path/);
	assert.match(parseCouncilArgs(["round", "--dir", "/c", "--plan", "p.md"]).error, /--plan must be an absolute path/);
	assert.match(parseCouncilArgs(["round", "--dir", "/c", "--plan", "/p", "--verify", "--verify"]).error, /only once/);
	assert.match(parseCouncilArgs(["close", "--dir", "/c", "--plan", "/p"]).error, /unknown council close option/);
	assert.match(
		parseCouncilArgs(["open", "--dir", "/c", "--slug", "x", "--planner-model", "a/b", "--seats", ","]).error,
		/at least one/,
	);
});

test("council exits 2 on syntax errors", async () => {
	const missing = await runCli(["council", "round", "--dir", "/c"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /--plan is required/);
	const unknown = await runCli(["council"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /usage:/);
});

test("council override records the reason and exits 1 on a non-binding finding", async () => {
	const root = mkdtempSync(join(tmpdir(), "kstack-cli-council-"));
	try {
		const dir = join(root, "council");
		const state = initialCouncilState(["A"], 3);
		state.budgetUsed = 1;
		state.ledger.findings.push({
			id: "A/B-1",
			seat: "A",
			text: "needs a test",
			status: "binding",
			raisedRound: 1,
			updatedRound: 1,
			rebuttals: 0,
			votes: [],
		});
		state.rounds.push({
			number: 1,
			kind: "budgeted",
			phase: "complete",
			planFile: join(root, "plan.md"),
			planSha256: "x",
			taskSha256: "y",
			reviews: {},
			ballots: {},
			decision: "revise",
			startedAt: "2026-10-25T12:00:00.000Z",
		});
		writeState(dir, state);
		mkdirSync(councilPaths(dir).round(1).dir, { recursive: true });
		writeFileSync(councilPaths(dir).round(1).plan, "# Plan\n");
		writeManifest(dir, {
			version: 1,
			slug: "demo",
			cwd: root,
			tabId: "w1:t1",
			callerPaneId: "w1:p1",
			plannerModel: "anthropic/claude-opus-5-5",
			excluded: [],
			timeoutMinutes: 15,
			seats: [
				{ letter: "A", model: "openai/gpt-6-astra:high", name: "council-demo-a", state: "ready", paneId: "w1:p2" },
			],
		});
		const bad = await runCli(["council", "override", "--dir", dir, "--finding", "A/B-9", "--reason", "x"]);
		assert.equal(bad.code, 1);
		assert.match(JSON.parse(bad.stdout).error, /No finding A\/B-9/);
		const good = await runCli(["council", "override", "--dir", dir, "--finding", "A/B-1", "--reason", "accepted risk"]);
		assert.equal(good.code, 0, good.stdout);
		const result = JSON.parse(good.stdout);
		assert.equal(result.decision, "approve");
		assert.equal(result.approvedPlan, councilPaths(dir).approvedPlan);
		assert.match(readFileSync(councilPaths(dir).record, "utf8"), /A\/B-1 \(round 1\): accepted risk/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
