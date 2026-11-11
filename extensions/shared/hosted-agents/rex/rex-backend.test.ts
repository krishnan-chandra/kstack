import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openAgentHost } from "../agent-host.ts";
import { writeHostedAgentState } from "../agent-state.ts";
import { virtualClock } from "../clock.ts";
import {
	createRexBackend,
	isUpdatedAfterBaseline,
	normalizeRexAgentStatus,
	rexSplitDirection,
	rexSplitRatioPercent,
} from "./rex-backend.ts";
import { FakeRex } from "./test-helpers.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kstack-rex-backend-"));
	roots.push(dir);
	return dir;
}

describe("Rex pure conversions and timestamp baseline checks", () => {
	it("maps keepFraction and direction to Rex split flags", () => {
		assert.equal(rexSplitRatioPercent(0.5), 50);
		assert.equal(rexSplitRatioPercent(1 / 3), 67);
		assert.equal(rexSplitRatioPercent(0.999), 1);
		assert.equal(rexSplitRatioPercent(0.001), 99);
		assert.equal(rexSplitDirection("right"), "right");
		assert.equal(rexSplitDirection("down"), "below");
	});

	it("normalizes program_status states", () => {
		assert.equal(normalizeRexAgentStatus("idle"), "idle");
		assert.equal(normalizeRexAgentStatus("working"), "working");
		assert.equal(normalizeRexAgentStatus("blocked"), "blocked");
		assert.equal(normalizeRexAgentStatus("done"), "done");
		assert.equal(normalizeRexAgentStatus("error"), "error");
		assert.equal(normalizeRexAgentStatus("future_state"), "unknown");
		assert.equal(normalizeRexAgentStatus(""), "unknown");
	});

	it("compares RFC3339Nano timestamps accurately across omitted trailing zeros and Z", () => {
		assert.equal(isUpdatedAfterBaseline("2026-11-11T21:41:52Z", "2026-11-11T21:41:52Z"), false);
		assert.equal(isUpdatedAfterBaseline("2026-11-11T21:41:52.1Z", "2026-11-11T21:41:52Z"), true);
		assert.equal(isUpdatedAfterBaseline("2026-11-11T21:41:52Z", "2026-11-11T21:41:52.1Z"), false);
		assert.equal(isUpdatedAfterBaseline("2026-11-11T16:41:52.20144-05:00", "2026-11-11T16:41:52.201100-05:00"), true);
	});
});

describe("createRexBackend", () => {
	it("validates preflight requirements and falls back to caller geometry for unowned windows", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		const backend = createRexBackend({
			exec: rex.exec,
			env: rex.env,
			clock: virtualClock(),
			resolvePiBinary: () => "/usr/local/bin/pi",
		});

		const ok = await backend.preflight();
		assert.deepEqual(ok, { ok: true, caller: { paneId: "block:caller", tabId: "window:caller" } });

		rex.apiRevision = 11;
		const oldApi = await backend.preflight();
		assert.equal(oldApi.ok, false);
		if (!oldApi.ok) assert.match(oldApi.error, /API revision 12/);
		rex.apiRevision = 12;

		const created = await backend.createTab({ cwd: dir, label: "swarm: run" });
		assert.ok(created.ok);
		const geom = await backend.paneGeometry(created.value.rootPaneId);
		assert.deepEqual(geom, {
			ok: true,
			value: { widthColumns: 240, heightRows: 60, tabId: created.value.tabId },
		});
	});

	it("returns pane_busy when the block is not at an idle shell and captures output when Pi exits on launch", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		rex.addShellBlock("block:busy", "window:caller", dir);
		const busyBlock = rex.blocks.get("block:busy")!;
		busyBlock.processName = "vim";

		const backend = createRexBackend({
			exec: rex.exec,
			env: rex.env,
			clock: virtualClock(),
			resolvePiBinary: () => "/usr/local/bin/pi",
		});

		const busy = await backend.launchAgent({
			name: "seat-a",
			paneId: "block:busy",
			cwd: dir,
			piArgs: ["--model", "p/m"],
			stateFile: join(dir, "busy.json"),
			timeoutMs: 5_000,
		});
		assert.equal(busy.ok, false);
		if (!busy.ok) assert.equal(busy.code, "pane_busy");

		// Now let the shell run the launcher, write initial stateFile, and exit immediately with an error trace.
		busyBlock.processName = "zsh";
		const crashStateFile = join(dir, "crash.json");
		rex.onSend = (blockId, text) => {
			assert.equal(blockId, "block:busy");
			const launcherPath = text.trim().replace(/^'|'$/g, "");
			assert.match(readFileSync(launcherPath, "utf8"), /KSTACK_HOSTED_AGENT_STATE=/);
			writeHostedAgentState(crashStateFile, {
				version: 1,
				name: "seat-a",
				pid: 7777,
				cwd: dir,
				updatedAt: "2026-11-11T16:00:01Z",
			});
			busyBlock.captureText = "zsh$ '/tmp/launch'\nError: unknown provider foo\nzsh$ \n";
		};
		rex.onEnter = () => {};
		const crashed = await backend.launchAgent({
			name: "seat-a",
			paneId: "block:busy",
			cwd: dir,
			piArgs: ["--model", "foo/bar"],
			stateFile: crashStateFile,
			timeoutMs: 5_000,
		});
		assert.equal(crashed.ok, false);
		if (!crashed.ok) {
			assert.equal(crashed.code, "protocol_error");
			assert.match(crashed.message, /unknown provider foo/);
		}
	});

	it("verifies sidecar pid identity, detects stalled prompts, and avoids double-pasting on retry", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		rex.addShellBlock("block:agent", "window:caller", dir);
		const block = rex.blocks.get("block:agent")!;
		const stateFile = join(dir, "agent.json");
		const sessionFile = join(dir, "session.jsonl");

		const backend = createRexBackend({
			exec: rex.exec,
			env: rex.env,
			clock: virtualClock(),
			resolvePiBinary: () => "/usr/local/bin/pi",
		});

		rex.onEnter = (_blockId, input) => {
			if (input.includes(".launch")) {
				block.pid = 5555;
				block.processName = "node";
				block.piPid = 5555;
				block.piState = "idle";
				block.updatedAt = "2026-11-11T16:01:00.000000-05:00";
				writeHostedAgentState(stateFile, {
					version: 1,
					name: "worker-1",
					pid: 5555,
					cwd: dir,
					sessionFile,
					sessionId: "s1",
					updatedAt: "2026-11-11T16:01:00.000Z",
				});
			}
		};

		const launched = await backend.launchAgent({
			name: "worker-1",
			paneId: "block:agent",
			cwd: dir,
			piArgs: ["--model", "p/m"],
			stateFile,
			timeoutMs: 5_000,
		});
		assert.ok(launched.ok);
		assert.equal(launched.value.sessionFile, sessionFile);

		// First prompt stalls (text landed in editor, Enter was lost -> no status change).
		rex.onSend = (_blockId, text) => {
			assert.ok(text.startsWith("\u001b[200~"));
			block.captureText = "Read and follow the instructions in /tmp/req.md.\nThe host saves your response.";
		};
		rex.onEnter = () => {};
		const ref = { name: "worker-1", paneId: "block:agent", stateFile };
		const promptText = "Read and follow the instructions in /tmp/req.md.\nThe host saves your response.";
		const stalled = await backend.prompt(ref, promptText, { timeoutMs: 60_000 });
		assert.equal(stalled.ok, false);
		if (!stalled.ok) assert.equal(stalled.code, "prompt_stalled");

		// Second attempt sees the prompt text in `capture` and sends ONLY Enter without pasting a second time!
		let sendCountOnRetry = 0;
		rex.onSend = () => {
			sendCountOnRetry++;
		};
		rex.onEnter = () => {
			block.piState = "done";
			block.updatedAt = "2026-11-11T16:01:02.000000-05:00";
		};
		const retried = await backend.prompt(ref, promptText, { timeoutMs: 60_000 });
		assert.ok(retried.ok);
		assert.equal(sendCountOnRetry, 0);

		// A foreign process replacing Pi in the same block is rejected by pid mismatch.
		block.pid = 9999;
		block.piPid = 9999;
		const foreign = await backend.getAgent(ref);
		assert.equal(foreign.ok, false);
		if (!foreign.ok) assert.equal(foreign.code, "identity_unverified");
	});

	it("distinguishes absent agents from live processes without identity evidence", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		rex.addShellBlock("block:agent", "window:caller", dir);
		const block = rex.blocks.get("block:agent")!;
		const ref = { name: "worker", paneId: "block:agent", stateFile: join(dir, "missing.json") };
		const backend = createRexBackend({ exec: rex.exec, env: rex.env });
		const shell = await backend.getAgent(ref);
		assert.equal(shell.ok, false);
		if (!shell.ok) assert.equal(shell.code, "not_found");
		block.processName = "node";
		const unidentified = await backend.getAgent(ref);
		assert.equal(unidentified.ok, false);
		if (!unidentified.ok) assert.equal(unidentified.code, "identity_unverified");
		rex.blocks.delete(ref.paneId);
		const absent = await backend.getAgent(ref);
		assert.equal(absent.ok, false);
		if (!absent.ok) assert.equal(absent.code, "not_found");
	});

	it("does not treat unknown states as settled after a prompt timestamp advances", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		rex.addShellBlock("block:agent", "window:caller", dir);
		const block = rex.blocks.get("block:agent")!;
		block.processName = "node";
		block.piState = "idle";
		block.updatedAt = "2026-11-11T21:00:00Z";
		const stateFile = join(dir, "agent.json");
		writeHostedAgentState(stateFile, {
			version: 1,
			name: "worker",
			pid: block.pid,
			cwd: dir,
			sessionFile: join(dir, "session.jsonl"),
			updatedAt: block.updatedAt,
		});
		const backend = createRexBackend({ exec: rex.exec, env: rex.env, clock: virtualClock() });
		const ref = { name: "worker", paneId: "block:agent", stateFile };
		rex.onEnter = () => {
			block.piState = "future_state";
			block.updatedAt = "2026-11-11T21:00:01Z";
		};
		const prompted = await backend.prompt(ref, "hello", { timeoutMs: 1_000 });
		assert.equal(prompted.ok, false);
		if (!prompted.ok) assert.equal(prompted.code, "timeout");
		const settled = await backend.waitSettled(ref, { timeoutMs: 1_000 });
		assert.equal(settled.ok, false);
		if (!settled.ok) assert.equal(settled.code, "timeout");
	});

	it("does not escalate owned aborts when Rex reports a settled error", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		const backend = createRexBackend({
			exec: rex.exec,
			env: rex.env,
			clock: virtualClock(),
			resolvePiBinary: () => "/usr/local/bin/pi",
		});
		const opened = await openAgentHost({ owner: "swarm", label: "test", cwd: dir, maxAgents: 1 }, { backend });
		assert.ok(opened.ok);
		try {
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: dir });
			assert.ok(started.ok);
			rex.blocks.get(started.agent.paneId)!.piState = "error";
			const before = rex.calls.length;
			await started.agent.abort();
			const calls = rex.calls.slice(before);
			assert.equal(calls.filter((call) => call[0] === "send-key").length, 1);
			assert.equal(
				calls.some((call) => call.includes("ctrl+c") || call[1] === "close"),
				false,
			);
		} finally {
			await opened.host.dispose({ closeTab: true });
		}
	});

	it("skips blocks that vanish mid-scan and never counts a failed probe as a name conflict", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		const blockId = rex.blockIdOf(rex.addAgentBlock("worker", { sidecar: false }));
		let failure: { code: number; stderr: string } | undefined;
		const backend = createRexBackend({
			env: rex.env,
			exec: async (args, options) => {
				if (failure && args[0] === "block" && args[1] === "call" && args.at(-1) === "process") {
					return { stdout: "", ...failure };
				}
				return rex.exec(args, options);
			},
		});
		assert.deepEqual(await backend.findAgentsNamed("worker"), {
			ok: true,
			value: [{ name: "worker", paneId: blockId, tabId: "window:caller", status: "idle", cwd: dir }],
		});

		failure = { code: 3, stderr: "Error: block target not found" };
		assert.deepEqual(await backend.findAgentsNamed("worker"), { ok: true, value: [] });

		failure = { code: 4, stderr: "Error: connecting to Rex server: socket not found" };
		const outage = await backend.findAgentsNamed("worker");
		assert.equal(outage.ok, false);
		if (!outage.ok) assert.equal(outage.code, "unavailable");
	});

	it("recognizes a stalled prompt that Pi's editor wrapped and sends only Enter on retry", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		const block = rex.addAgentBlock("worker");
		const ref = { name: "worker", paneId: rex.blockIdOf(block), stateFile: block.stateFile ?? "" };
		const backend = createRexBackend({ exec: rex.exec, env: rex.env, clock: virtualClock() });
		const promptText = "Read and follow the instructions in /tmp/a/rather/long/path/request.md. Return your answer.";
		rex.onEnter = () => {
			block.captureText =
				"> Read and follow the instructions in /tmp/a/rather/long/\n  path/request.md. Return your answer.";
		};
		const stalled = await backend.prompt(ref, promptText, { timeoutMs: 60_000 });
		assert.equal(stalled.ok, false);

		let pasted = 0;
		rex.onSend = () => {
			pasted++;
		};
		rex.onEnter = () => {
			block.piState = "done";
			block.updatedAt = rex.nextTimestamp();
		};
		const retried = await backend.prompt(ref, promptText, { timeoutMs: 60_000 });
		assert.ok(retried.ok);
		assert.equal(pasted, 0);
	});

	it("never sends keys to or closes the caller's own Rex block", async () => {
		const dir = makeDir();
		const rex = new FakeRex(dir);
		const backend = createRexBackend({ exec: rex.exec, env: rex.env, clock: virtualClock() });

		const sendCaller = await backend.sendKeys({ name: "caller", paneId: rex.callerBlock }, ["ctrl+c", "ctrl+c"]);
		assert.equal(sendCaller.ok, false);
		const closeCaller = await backend.closePane(rex.callerBlock);
		assert.equal(closeCaller.ok, false);
		assert.equal(rex.calls.length, 0);
	});
});
