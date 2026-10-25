import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

const CLI = join(import.meta.dirname, "cli.mjs");

/**
 * Fake `herdr` with state in a JSON file. `agent prompt` reads the request
 * path and UUID from the pointer prompt and appends the canned reply for
 * `<round>/<phase>/<letter>` as a terminal assistant message to that seat's
 * session JSONL. The reply `HANG` blocks until the CLI kills the call.
 */
const FAKE_HERDR = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(' ');
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
// One file per pane and agent so concurrent herdr calls never lose updates.
const panes = path.join(process.env.FIXTURE_STATE, 'panes');
const agents = path.join(process.env.FIXTURE_STATE, 'agents');
const tabOf = (pane) => { try { return fs.readFileSync(path.join(panes, pane), 'utf8'); } catch { return undefined; } };
const agentOf = (name) => { try { return JSON.parse(fs.readFileSync(path.join(agents, name), 'utf8')); } catch { return undefined; } };
const ok = (result) => process.stdout.write(JSON.stringify({ id: 'x', result }));
const fail = (code, message) => { process.stderr.write(JSON.stringify({ id: 'x', error: { code, message } })); process.exit(1); };
const record = (name, agent) => ({ name, agent: 'pi', cwd: process.env.FIXTURE_CWD, agent_status: 'idle', pane_id: agent.pane,
  tab_id: tabOf(agent.pane) ?? '', agent_session: { kind: 'path', value: agent.session } });
if (command === 'status server') {
  process.stdout.write('running\\n');
} else if (command === 'pane layout') {
  const tab = tabOf(args[3]);
  if (!tab) fail('pane_not_found', 'pane not found');
  ok({ type: 'pane_layout', layout: { area: { width: 240, height: 60 }, tab_id: tab } });
} else if (command === 'pane split') {
  const tab = tabOf(args[2]);
  let pane;
  for (let n = 10; !pane; n++) {
    try { fs.writeFileSync(path.join(panes, 'w1:p' + n), tab, { flag: 'wx' }); pane = 'w1:p' + n; } catch {}
  }
  ok({ type: 'pane_info', pane: { pane_id: pane, tab_id: tab, agent_status: 'unknown' } });
} else if (command === 'pane close') {
  if (!tabOf(args[2])) fail('pane_not_found', 'pane not found');
  fs.rmSync(path.join(panes, args[2]));
  for (const name of fs.readdirSync(agents)) if (agentOf(name)?.pane === args[2]) fs.rmSync(path.join(agents, name));
  ok({ type: 'ok' });
} else if (command === 'agent start') {
  const name = args[2];
  const session = path.join(process.env.FIXTURE_SESSIONS, name + '.jsonl');
  const agent = { pane: args[6], session };
  try { fs.writeFileSync(path.join(agents, name), JSON.stringify(agent), { flag: 'wx' }); }
  catch { fail('agent_name_in_use', 'agent name ' + name + ' already in use'); }
  fs.writeFileSync(session, '');
  ok({ type: 'agent_started', agent: record(name, agent), argv: ['pi'] });
} else if (command === 'agent get' || command === 'agent wait') {
  const agent = agentOf(args[2]);
  if (!agent) fail('agent_not_found', 'agent target ' + args[2] + ' not found');
  ok({ type: 'agent_info', agent: record(args[2], agent) });
} else if (command === 'agent send-keys') {
  ok({ type: 'ok' });
} else if (command === 'agent prompt') {
  const name = args[2];
  const text = args[3];
  const request = /instructions in (\\S+)\\. /.exec(text)[1];
  const uuid = /KSTACK_RESPONSE (\\S+)/.exec(text)[1];
  const round = /round-(\\d+)/.exec(request)[1];
  const file = path.basename(request);
  const phase = file.startsWith('cross-exam') ? 'cross-exam' : 'review';
  const repair = file.includes('.repair.') ? '-repair' : '';
  const letter = name.slice(-1).toUpperCase();
  const replies = JSON.parse(fs.readFileSync(process.env.FIXTURE_REPLIES, 'utf8'));
  const reply = replies[round + '/' + phase + repair + '/' + letter] ?? replies['default/' + phase];
  if (reply === 'HANG') {
    fs.writeFileSync(process.env.FIXTURE_HANG, name);
    setInterval(() => {}, 1000);
  } else {
    const agent = agentOf(name);
    const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'KSTACK_RESPONSE ' + uuid + '\\n' + reply }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
    fs.appendFileSync(agent.session, JSON.stringify({ type: 'message', message }) + '\\n');
    ok({ type: 'agent_prompted', agent: record(name, agent) });
  }
} else {
  fail('unknown', 'no fake route for ' + command);
}
`;

const APPROVE = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kstack-council-cli-")));
	mkdirSync(join(root, "extensions"));
	mkdirSync(join(root, "sessions"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "extensions/herdr-agent-state.ts"), "");
	mkdirSync(join(root, "herdr-state", "panes"), { recursive: true });
	mkdirSync(join(root, "herdr-state", "agents"), { recursive: true });
	writeFileSync(join(root, "herdr-state", "panes", "w1:p1"), "w1:t1");
	writeFileSync(join(root, "bin/herdr"), FAKE_HERDR, { mode: 0o700 });
	writeFileSync(
		join(root, "kstack.json"),
		JSON.stringify({
			aliases: [
				{ label: "opus", model: "anthropic/claude-opus-5-5", thinking: "high" },
				{ label: "astra", model: "openai/gpt-6-astra", thinking: "high" },
				{ label: "argon", model: "google/gemini-4-argon", thinking: "high" },
			],
			council: { seats: ["opus", "astra", "argon"], maxRounds: 3 },
		}),
	);
	writeFileSync(join(root, "task.md"), "Add a widget.\n");
	writeFileSync(join(root, "plan.md"), "# Plan\n\n1. [STEP-1] Add the widget.\n");
	const files = {
		dir: join(root, "council"),
		log: join(root, "calls.jsonl"),
		replies: join(root, "replies.json"),
		hang: join(root, "hang"),
	};
	const env = {
		...process.env,
		PATH: `${join(root, "bin")}:${process.env.PATH}`,
		HERDR_ENV: "1",
		HERDR_WORKSPACE_ID: "w1",
		HERDR_PANE_ID: "w1:p1",
		PI_CODING_AGENT_DIR: root,
		FIXTURE_LOG: files.log,
		FIXTURE_STATE: join(root, "herdr-state"),
		FIXTURE_SESSIONS: join(root, "sessions"),
		FIXTURE_REPLIES: files.replies,
		FIXTURE_HANG: files.hang,
		FIXTURE_CWD: root,
	};
	const run = (args) => {
		const child = spawn(process.execPath, [CLI, "council", ...args], {
			cwd: root,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const done = once(child, "exit").then(([code]) => ({
			code,
			stdout,
			stderr,
			json: stdout ? JSON.parse(stdout) : undefined,
		}));
		return { child, done };
	};
	const calls = () =>
		readFileSync(files.log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const setReplies = (replies) => writeFileSync(files.replies, JSON.stringify(replies));
	return { root, files, run, calls, setReplies };
}

test("council open, a voting round, and an approving round run through the shipped CLI", {
	timeout: 30000,
}, async () => {
	const f = fixture();
	try {
		f.setReplies({
			"default/review": APPROVE,
			"1/review/A": "Verdict: revise\n\n## Blocking\n- [B-1] STEP-1 has no test\n\n## Suggestions\nNone.\n",
			"1/review/C":
				"Verdict: revise\n\n## Blocking\n- [B-1] The widget needs a feature flag\n\n## Suggestions\nNone.\n",
			"1/cross-exam/A": "## Votes\n- C/B-1: object — the task names no flag\n\n## Withdrawn\nNone.\n",
			"1/cross-exam/B":
				"## Votes\n- A/B-1: concur\n- C/B-1: object — flags are out of scope per task.md\n\n## Withdrawn\nNone.\n",
			"1/cross-exam/C": "## Votes\n- A/B-1: abstain\n\n## Withdrawn\nNone.\n",
			"2/review/A": `${APPROVE}\n## Resolved from previous round\n- B-1: STEP-1 now names the test\n`,
		});
		const open = await f.run(["open", "--dir", f.files.dir, "--slug", "widget", "--planner-model", "openai/gpt-6-sol"])
			.done;
		assert.equal(open.code, 0, open.stdout + open.stderr);
		assert.equal(open.json.status, "ready");
		assert.deepEqual(
			open.json.seats.map((seat) => [seat.letter, seat.model, seat.name]),
			[
				["A", "anthropic/claude-opus-5-5:high", "council-widget-a"],
				["B", "openai/gpt-6-astra:high", "council-widget-b"],
				["C", "google/gemini-4-argon:high", "council-widget-c"],
			],
		);
		assert.equal(f.calls().filter((args) => args[1] === "split" && args[2] === "w1:p1").length, 1);

		const plan = join(f.root, "plan.md");
		const round1 = await f.run(["round", "--dir", f.files.dir, "--plan", plan, "--task", join(f.root, "task.md")]).done;
		assert.equal(round1.code, 0, round1.stdout + round1.stderr);
		assert.equal(round1.json.decision, "revise");
		assert.deepEqual(round1.json.binding, ["A/B-1"]);
		const ledger = readFileSync(round1.json.ledgerFile, "utf8");
		assert.match(ledger, /## Up for a vote\n- A\/B-1: STEP-1 has no test\n- C\/B-1/);
		for (const model of ["claude-opus", "gpt-6-astra", "gemini-4-argon"]) assert.equal(ledger.includes(model), false);
		const decision = readFileSync(round1.json.decisionFile, "utf8");
		assert.match(decision, /C\/B-1 \[dismissed\]/);
		assert.match(decision, /B: object — flags are out of scope per task\.md/);

		writeFileSync(join(f.root, "response.md"), "## Responses\n- A/B-1: addressed — STEP-1 now names the test\n");
		writeFileSync(plan, "# Plan\n\n1. [STEP-1] Add the widget and its test.\n");
		const round2 = await f.run([
			"round",
			"--dir",
			f.files.dir,
			"--plan",
			plan,
			"--response",
			join(f.root, "response.md"),
		]).done;
		assert.equal(round2.code, 0, round2.stdout + round2.stderr);
		assert.equal(round2.json.decision, "approve");
		assert.equal(readFileSync(round2.json.approvedPlan, "utf8"), readFileSync(plan, "utf8"));
		const record = readFileSync(round2.json.recordFile, "utf8");
		assert.match(record, /- A: anthropic\/claude-opus-5-5:high/);
		assert.match(record, new RegExp(round2.json.approvedSha256));
		assert.match(record, /C\/B-1: The widget needs a feature flag/);
		assert.equal(f.calls().filter((args) => args[1] === "close").length, 0);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("SIGTERM leaves a round incomplete and a rerun asks only the unfinished seat", { timeout: 30000 }, async () => {
	const f = fixture();
	let child;
	try {
		f.setReplies({ "default/review": APPROVE, "1/review/B": "HANG" });
		const open = await f.run(["open", "--dir", f.files.dir, "--slug", "cancel", "--planner-model", "openai/gpt-6-sol"])
			.done;
		assert.equal(open.code, 0, open.stdout + open.stderr);
		const plan = join(f.root, "plan.md");
		const running = f.run(["round", "--dir", f.files.dir, "--plan", plan, "--task", join(f.root, "task.md")]);
		child = running.child;
		const statePath = join(f.files.dir, "state.json");
		const reviewed = () =>
			existsSync(statePath) ? Object.keys(JSON.parse(readFileSync(statePath, "utf8")).rounds[0]?.reviews ?? {}) : [];
		for (let n = 0; (!existsSync(f.files.hang) || reviewed().length < 2) && n < 500; n++) await setTimeout(10);
		assert.deepEqual(reviewed().sort(), ["A", "C"]);
		child.kill("SIGTERM");
		const cancelled = await running.done;
		assert.equal(cancelled.code, 1);
		assert.equal(cancelled.json.status, "incomplete");
		assert.equal(cancelled.json.cancelled, true);
		assert.deepEqual(
			cancelled.json.failures.map((failure) => failure.seat),
			["B"],
		);
		const afterCancel = f.calls();
		assert.ok(
			afterCancel.some((args) => args[1] === "send-keys" && args[2] === "council-cancel-b" && args[3] === "esc"),
		);
		assert.equal(afterCancel.filter((args) => args[1] === "send-keys" && args.includes("ctrl+c")).length, 0);
		assert.equal(afterCancel.filter((args) => args[1] === "close").length, 0);

		f.setReplies({ "default/review": APPROVE });
		const promptsBefore = afterCancel.filter((args) => args[1] === "prompt").length;
		const rerun = await f.run(["round", "--dir", f.files.dir, "--plan", plan]).done;
		assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
		assert.equal(rerun.json.resumed, true);
		assert.equal(rerun.json.decision, "approve");
		const prompts = f
			.calls()
			.filter((args) => args[1] === "prompt")
			.slice(promptsBefore);
		assert.deepEqual(
			prompts.map((args) => args[2]),
			["council-cancel-b"],
		);
	} finally {
		child?.kill("SIGKILL");
		rmSync(f.root, { recursive: true, force: true });
	}
});
