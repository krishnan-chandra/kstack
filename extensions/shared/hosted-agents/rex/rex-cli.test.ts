import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BackendExec } from "../terminal-backend.ts";
import { createNodeRexExec, createRexCli, mapRexFailure, REX_OUTPUT_CAP_BYTES, resolveRexBinary } from "./rex-cli.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kstack-rex-cli-"));
	roots.push(dir);
	return dir;
}

describe("resolveRexBinary and mapRexFailure", () => {
	it("resolves rex from PATH before REX_BIN_DIR", () => {
		const dir = makeDir();
		const pathDir = join(dir, "path-bin");
		const fallbackDir = join(dir, "rex-bin");
		mkdirSync(pathDir);
		mkdirSync(fallbackDir);
		const fallbackRex = join(fallbackDir, "rex");
		writeFileSync(fallbackRex, "#!/bin/sh\n");
		chmodSync(fallbackRex, 0o755);
		assert.equal(resolveRexBinary({ PATH: pathDir, REX_BIN_DIR: fallbackDir }), fallbackRex);

		const pathRex = join(pathDir, "rex");
		writeFileSync(pathRex, "#!/bin/sh\n");
		chmodSync(pathRex, 0o755);
		assert.equal(resolveRexBinary({ PATH: pathDir, REX_BIN_DIR: fallbackDir }), pathRex);
	});

	it("maps Rex exit codes and stderr text onto backend error codes", () => {
		assert.equal(mapRexFailure(3, 'Error: block target "block:1" not found').code, "not_found");
		assert.equal(mapRexFailure(4, "Error: connecting to Rex server: dial unix").code, "unavailable");
		assert.equal(mapRexFailure(2, "Error: unknown flag: --bogus").code, "protocol_error");
		assert.equal(mapRexFailure(1, "Error: context deadline exceeded").code, "timeout");
	});

	it("never infers an absent target from message text", () => {
		assert.equal(mapRexFailure(4, "connecting to Rex server: socket not found").code, "unavailable");
		assert.equal(mapRexFailure(1, 'Error: block a901e5 has no method "x"; method not found').code, "protocol_error");
		assert.equal(mapRexFailure(1, "Method not found: program_status").code, "protocol_error");
	});
});

describe("createRexCli", () => {
	it("formats commands with -s session scoping and parses verified Rex JSON shapes", async () => {
		const calls: string[][] = [];
		const exec: BackendExec = async (args) => {
			calls.push(args);
			if (args[0] === "whoami") {
				return {
					code: 0,
					stdout: JSON.stringify({
						api_revision: 12,
						session_id: "session:1",
						window_id: "window:1",
						block_id: "block:caller",
						rex_version: "0.1.0-preview.14",
					}),
					stderr: "",
				};
			}
			if (args[0] === "window" && args[1] === "new") {
				return {
					code: 0,
					stdout: JSON.stringify({ window_id: "window:2", block_ids: ["block:root"] }),
					stderr: "",
				};
			}
			if (args[0] === "split") {
				return {
					code: 0,
					stdout: JSON.stringify({ anchor_id: "block:root", block_ids: ["block:split1"], split_ids: ["split:1"] }),
					stderr: "",
				};
			}
			if (args[0] === "block" && args[1] === "inspect") {
				return {
					code: 0,
					stdout: JSON.stringify({
						session_id: "session:1",
						block: { block_id: "block:root", window_id: "window:2", label: "seat-a" },
						api: { methods: { program_status: {}, modes: {}, process: {}, size: {} } },
					}),
					stderr: "",
				};
			}
			if (args[0] === "block" && args[1] === "ls") {
				return {
					code: 0,
					stdout: JSON.stringify({
						blocks: [{ block_id: "block:root", window_id: "window:2", label: "seat-a" }],
					}),
					stderr: "",
				};
			}
			if (args[0] === "block" && args[1] === "call" && args.at(-1) === "modes") {
				return {
					code: 0,
					stdout: JSON.stringify({
						screen: "alternate",
						modes: [{ name: "bracketed_paste", number: 2004, set: true }],
					}),
					stderr: "",
				};
			}
			if (args[0] === "block" && args[1] === "call" && args.at(-1) === "program_status") {
				return {
					code: 0,
					stdout: JSON.stringify({
						records: [
							{
								state: "idle",
								app: "pi",
								effective_app: "pi",
								updated_at: "2026-11-11T16:41:51.513935-05:00",
								owner: { pid: 9001, name: "node" },
							},
						],
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const cli = createRexCli(exec);
		const who = await cli.whoami({ timeoutMs: 5_000 });
		assert.deepEqual(who, {
			ok: true,
			value: {
				apiRevision: 12,
				sessionId: "session:1",
				blockId: "block:caller",
			},
		});

		const created = await cli.windowNew(
			{ sessionId: "session:1", label: "swarm: run", cwd: "/repo" },
			{ timeoutMs: 5_000 },
		);
		assert.deepEqual(created, { ok: true, value: { windowId: "window:2", rootBlockId: "block:root" } });

		const split = await cli.split(
			{
				sessionId: "session:1",
				blockId: "block:root",
				direction: "below",
				ratioPercent: 50,
				cwd: "/repo",
				label: "seat-b",
			},
			{ timeoutMs: 5_000 },
		);
		assert.deepEqual(split, { ok: true, value: { blockId: "block:split1" } });

		const inspected = await cli.blockInspect({ sessionId: "session:1", blockId: "block:root" }, { timeoutMs: 5_000 });
		assert.ok(inspected.ok);
		assert.equal(inspected.value.windowId, "window:2");
		assert.ok(inspected.value.methods.includes("program_status"));

		const modes = await cli.blockModes({ sessionId: "session:1", blockId: "block:root" }, { timeoutMs: 5_000 });
		assert.deepEqual(modes, { ok: true, value: { screen: "alternate", bracketedPaste: true } });

		const status = await cli.blockProgramStatus(
			{ sessionId: "session:1", blockId: "block:root" },
			{ timeoutMs: 5_000 },
		);
		assert.ok(status.ok);
		assert.equal(status.value.records[0]?.owner?.pid, 9001);

		await cli.send({ sessionId: "session:1", blockId: "block:root", text: "-leading-dash" }, { timeoutMs: 5_000 });
		assert.deepEqual(calls.at(-1), ["send", "-s", "session:1", "-b", "block:root", "--", "-leading-dash"]);
	});

	it("bounds oversized capture output from the tail and maps real subprocess timeout and ENOENT errors", async () => {
		const cli = createRexCli(async () => ({
			code: 0,
			stdout: `${"x".repeat(REX_OUTPUT_CAP_BYTES * 2)}\nBOTTOM_LINE\n`,
			stderr: "",
		}));
		const captured = await cli.capture({ sessionId: "s", blockId: "b", trim: true }, { timeoutMs: 1_000 });
		assert.ok(captured.ok);
		assert.ok(Buffer.byteLength(captured.value, "utf8") <= REX_OUTPUT_CAP_BYTES);
		assert.match(captured.value, /BOTTOM_LINE\n$/);

		const missingExec = createNodeRexExec({ PATH: "" }, "/nonexistent/rex-binary");
		const missingCli = createRexCli(missingExec);
		const missing = await missingCli.whoami({ timeoutMs: 1_000 });
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.code, "unavailable");

		const dir = makeDir();
		const slowRex = join(dir, "slow-rex");
		writeFileSync(slowRex, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
		const timeoutCli = createRexCli(createNodeRexExec({}, slowRex));
		const timedOut = await timeoutCli.whoami({ timeoutMs: 50 });
		assert.equal(timedOut.ok, false);
		if (!timedOut.ok) assert.equal(timedOut.code, "timeout");
	});
});
