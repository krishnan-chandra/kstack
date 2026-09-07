import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHerdrCli, createNodeHerdrExec, HERDR_OUTPUT_CAP_BYTES, type HerdrExec } from "./herdr-cli.ts";

interface ExecCall {
	args: string[];
	timeoutMs: number;
	signal?: AbortSignal;
}

type ScriptedResponse = { code: number; stdout: string; stderr: string };
type ScriptedHandler = (call: ExecCall) => ScriptedResponse;

interface ScriptedExec {
	exec: HerdrExec;
	calls: ExecCall[];
}

function scriptExec(handler: ScriptedHandler): ScriptedExec {
	const calls: ExecCall[] = [];
	const exec: HerdrExec = async (args, options) => {
		const call: ExecCall = { args, timeoutMs: options.timeoutMs };
		if (options.signal) call.signal = options.signal;
		calls.push(call);
		return handler(call);
	};
	return { exec, calls };
}

describe("createHerdrCli", () => {
	it("parses a success envelope through the typed helper", async () => {
		const { exec, calls } = scriptExec(() => ({
			code: 0,
			stdout: '{"id":"x","result":{"type":"tab_created","tab":{"tab_id":"w5:t1"},"root_pane":{"pane_id":"w5:p1"}}}',
			stderr: "",
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabCreate({ workspaceId: "w5", cwd: "/repo", label: "owner: run" }, { timeoutMs: 9000 });
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.value, { tabId: "w5:t1", rootPaneId: "w5:p1" });
		assert.equal(calls[0]?.timeoutMs, 9000);
		assert.deepEqual(calls[0]?.args, [
			"tab",
			"create",
			"--workspace",
			"w5",
			"--cwd",
			"/repo",
			"--label",
			"owner: run",
			"--no-focus",
		]);
	});

	it("maps a stderr error envelope to its code and message", async () => {
		const { exec } = scriptExec(() => ({
			code: 1,
			stdout: "",
			stderr: '{"id":"x","error":{"code":"agent_blocked","message":"the agent is blocked"}}',
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.agentPrompt({ name: "a", text: "hi", timeoutMs: 1000 }, { timeoutMs: 2000 });
		assert.deepEqual(outcome, { ok: false, code: "agent_blocked", message: "the agent is blocked" });
	});

	it("maps exit code 2 to syntax_error", async () => {
		const { exec } = scriptExec(() => ({
			code: 2,
			stdout: "",
			stderr: "error: unexpected argument '--bogus' found",
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabClose({ tabId: "w5:t1" }, { timeoutMs: 1000 });
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.code, "syntax_error");
			assert.match(outcome.message, /unexpected argument/);
		}
	});

	it("maps non-JSON stdout to protocol_error", async () => {
		const { exec } = scriptExec(() => ({ code: 0, stdout: "panic: something broke", stderr: "" }));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabClose({ tabId: "w5:t1" }, { timeoutMs: 1000 });
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.code, "protocol_error");
			assert.match(outcome.message, /non-JSON stdout/);
		}
	});

	it("maps a non-envelope JSON stdout to protocol_error", async () => {
		const { exec } = scriptExec(() => ({ code: 0, stdout: '{"unexpected":true}', stderr: "" }));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabClose({ tabId: "w5:t1" }, { timeoutMs: 1000 });
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.equal(outcome.code, "protocol_error");
	});

	it("caps oversized protocol errors so a broken CLI cannot flood memory", async () => {
		const { exec } = scriptExec(() => ({ code: 0, stdout: "x".repeat(HERDR_OUTPUT_CAP_BYTES * 4), stderr: "" }));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabClose({ tabId: "w5:t1" }, { timeoutMs: 1000 });
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.ok(Buffer.byteLength(outcome.message, "utf8") < HERDR_OUTPUT_CAP_BYTES * 2);
	});

	it("maps a stderr error with an unexpected result shape to protocol_error", async () => {
		const { exec } = scriptExec(() => ({
			code: 0,
			stdout: '{"id":"x","result":{"type":"something_else"}}',
			stderr: "",
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.tabClose({ tabId: "w5:t1" }, { timeoutMs: 1000 });
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.code, "protocol_error");
			assert.match(outcome.message, /unexpected result shape/);
		}
	});

	it("runText returns plain text without envelope parsing", async () => {
		const { exec } = scriptExec(() => ({ code: 0, stdout: "status: running\nversion: 0.8.2\n", stderr: "" }));
		const cli = createHerdrCli(exec);
		const outcome = await cli.runText(["status", "server"], { timeoutMs: 1000 });
		assert.ok(outcome.ok);
		assert.match(outcome.value, /status: running/);
	});

	it("agentRead passes through the plain-text output and maps failures", async () => {
		const { exec } = scriptExec(() => ({ code: 0, stdout: "DONE /tmp/x/out.md\n", stderr: "" }));
		const cli = createHerdrCli(exec);
		const ok = await cli.agentRead({ name: "agent", lines: 200 }, { timeoutMs: 1000 });
		assert.ok(ok.ok);
		assert.equal(ok.value, "DONE /tmp/x/out.md\n");
		const failing = scriptExec(() => ({
			code: 1,
			stdout: "",
			stderr: '{"id":"x","error":{"code":"agent_not_found","message":"agent target nope not found"}}',
		}));
		const bad = await createHerdrCli(failing.exec).agentRead({ name: "nope", lines: 5 }, { timeoutMs: 1000 });
		assert.deepEqual(bad, { ok: false, code: "agent_not_found", message: "agent target nope not found" });
	});

	it("agentStart and agentPrompt validate their result types", async () => {
		const { exec } = scriptExec(() => ({
			code: 0,
			stdout:
				'{"id":"x","result":{"type":"agent_started","agent":{"name":"owner-planner-ab12","agent_status":"idle","pane_id":"w5:p2","tab_id":"w5:t1","agent_session":{"kind":"path","value":"/sessions/a.jsonl"}},"argv":["pi"]}}',
			stderr: "",
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.agentStart(
			{ name: "owner-planner-ab12", paneId: "w5:p2", timeoutMs: 30000, args: ["pi"] },
			{ timeoutMs: 40000 },
		);
		assert.ok(outcome.ok);
		if (outcome.ok) {
			assert.equal(outcome.value.name, "owner-planner-ab12");
			assert.equal(outcome.value.sessionFile, "/sessions/a.jsonl");
			assert.equal(outcome.value.agentStatus, "idle");
		}
	});

	it("paneLayout parses the grid geometry", async () => {
		const { exec } = scriptExec(() => ({
			code: 0,
			stdout: '{"id":"x","result":{"type":"pane_layout","layout":{"area":{"height":60,"width":213},"panes":[]}}}',
			stderr: "",
		}));
		const cli = createHerdrCli(exec);
		const outcome = await cli.paneLayout({ paneId: "w5:p1" }, { timeoutMs: 1000 });
		assert.ok(outcome.ok);
		if (outcome.ok) assert.deepEqual(outcome.value, { widthColumns: 213, heightRows: 60 });
	});

	it("builds agent send-keys and wait commands with repeated --until flags", async () => {
		const { exec, calls } = scriptExec(() => ({
			code: 0,
			stdout: '{"id":"x","result":{"type":"ok"}}',
			stderr: "",
		}));
		const cli = createHerdrCli(exec);
		await cli.agentSendKeys({ name: "a", key: "esc" }, { timeoutMs: 1000 });
		await cli.agentWait({ name: "a", timeoutMs: 2000, until: ["idle", "done"] }, { timeoutMs: 3000 });
		assert.deepEqual(calls[0]?.args, ["agent", "send-keys", "a", "esc"]);
		assert.deepEqual(calls[1]?.args, ["agent", "wait", "a", "--until", "idle", "--until", "done", "--timeout", "2000"]);
	});
});

describe("createNodeHerdrExec", () => {
	it("maps an exec timeout to the typed timeout error", async () => {
		const cli = createHerdrCli(createNodeHerdrExec(process.execPath));
		const outcome = await cli.runText(["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 25 });
		assert.deepEqual(outcome, {
			ok: false,
			code: "timeout",
			message: "herdr command timed out after 25 ms",
		});
	});

	it("reports output overflow as overflow rather than a timeout", async () => {
		const cli = createHerdrCli(createNodeHerdrExec(process.execPath));
		const outcome = await cli.runText(["-e", `process.stdout.write("x".repeat(${HERDR_OUTPUT_CAP_BYTES + 1024}))`], {
			timeoutMs: 5_000,
		});
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.code, "output_overflow");
			assert.match(outcome.message, /exceeded/);
		}
	});

	it("passes AbortSignal through to the child process", async () => {
		const controller = new AbortController();
		const cli = createHerdrCli(createNodeHerdrExec(process.execPath));
		const pending = cli.runText(["-e", "setTimeout(() => {}, 10_000)"], {
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		controller.abort();
		const outcome = await pending;
		assert.deepEqual(outcome, { ok: false, code: "aborted", message: "herdr command was aborted" });
	});
});
