import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { councilPaths, initialCouncilState, writeManifest, writeState } from "../council/store.ts";
import { parseAskArgs, parseCouncilArgs, parseFanoutArgs, parseResolveModelArgs, parseSubcommand } from "./cli.mjs";

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
	assert.deepEqual(parseSubcommand(["council"]), { ok: true, subcommand: "council" });
	assert.equal(parseSubcommand([]).ok, false);
	assert.equal(parseSubcommand(["bogus"]).ok, false);
});

test("parseResolveModelArgs requires one section and key", () => {
	assert.deepEqual(parseResolveModelArgs(["--section", "swarm", "--key", "worker"]), {
		ok: true,
		section: "swarm",
		key: "worker",
		model: undefined,
	});
	assert.equal(parseResolveModelArgs(["--section", "swarm"]).ok, false);
	assert.equal(parseResolveModelArgs(["--bogus", "x"]).ok, false);
});

test("parseAskArgs requires an agent and absolute prompt and output paths", () => {
	assert.deepEqual(parseAskArgs(["--agent", "adversary-x", "--prompt", "/tmp/p.md", "--out", "/tmp/o.md"]), {
		ok: true,
		agent: "adversary-x",
		prompt: "/tmp/p.md",
		out: "/tmp/o.md",
	});
	const relative = parseAskArgs(["--agent", "adversary-x", "--prompt", "local/p.md", "--out", "/tmp/o.md"]);
	assert.equal(relative.ok, false);
	assert.match(relative.error, /--prompt must be an absolute path/);
	assert.equal(parseAskArgs(["--agent", "adversary-x", "--prompt", "/tmp/p.md"]).ok, false);
	assert.equal(parseAskArgs(["--agent", "a", "--agent", "b", "--prompt", "/p", "--out", "/o"]).ok, false);
	assert.equal(parseAskArgs(["--bogus", "x"]).ok, false);
});

test("the CLI exits 2 with usage on syntax errors", async () => {
	const none = await runCli([]);
	assert.equal(none.code, 2);
	assert.match(none.stderr, /usage:/);
	const unknown = await runCli(["bogus"]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /unknown subcommand: bogus/);
	const missing = await runCli(["resolve-model", "--section", "swarm"]);
	assert.equal(missing.code, 2);
	assert.match(missing.stderr, /--key is required/);
	const relativeAsk = await runCli(["ask", "--agent", "adversary-x", "--prompt", "p.md", "--out", "/tmp/o.md"]);
	assert.equal(relativeAsk.code, 2);
	assert.match(relativeAsk.stderr, /--prompt must be an absolute path/);
});

test("resolve-model loads aliases for a configured section model", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-resolve-"));
	try {
		writeFileSync(
			join(agentDir, "kstack.json"),
			JSON.stringify({
				aliases: [{ label: "fable", model: "anthropic/claude-fable-5-1", thinking: "high" }],
				swarm: { worker: "fable" },
			}),
		);
		const result = await runCli(["resolve-model", "--section", "swarm", "--key", "worker"], {
			PI_CODING_AGENT_DIR: agentDir,
		});
		assert.deepEqual(result, { code: 0, stdout: "anthropic/claude-fable-5-1:high\n", stderr: "" });
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("resolve-model accepts an explicit full model without config", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-explicit-"));
	const result = await runCli(
		["resolve-model", "--section", "swarm", "--key", "worker", "--model", "openai/gpt-5.6-astra:medium"],
		{ PI_CODING_AGENT_DIR: agentDir },
	);
	assert.deepEqual(result, { code: 0, stdout: "openai/gpt-5.6-astra:medium\n", stderr: "" });
});

test("resolve-model exits 1 with configuration guidance when no model exists", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kstack-cli-missing-"));
	const result = await runCli(["resolve-model", "--section", "swarm", "--key", "worker"], {
		PI_CODING_AGENT_DIR: agentDir,
	});
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Set it in kstack\.json or pass --model/);
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
	// Explicitly clear HERDR_ENV to ensure preflight fails
	const result = await runCli(["fanout", "--spec", specPath, "--out", join(dir, "out.json")], {
		HERDR_ENV: "",
	});
	assert.equal(result.code, 1);
	assert.match(result.stderr, /HERDR_ENV/);
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
