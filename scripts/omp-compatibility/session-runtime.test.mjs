import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRunRoot, ompRpcArgs, resolveOmpHost, runIsolated } from "./harness.mjs";
import { parseFrames, rpcInput, writeFixtureModel } from "./probes.mjs";

const ompCheckout = process.env.OMP_CHECKOUT;
const probeTest = ompCheckout ? test : test.skip;

probeTest("OMP public RPC names and replaces a disposable session", async () => {
	const host = await resolveOmpHost(ompCheckout);
	const runRoot = await createRunRoot("sessions");
	const cwd = join(runRoot, "workspace");
	const sessionDir = join(runRoot, "sessions");
	const extensionRoot = join(runRoot, "empty-extension");
	await writeFixtureModel(runRoot);
	await mkdir(extensionRoot, { recursive: true });
	await writeFile(join(extensionRoot, "index.ts"), "export default function () {}\n");
	const args = ompRpcArgs({ hostArgs: host.hostArgs, extensionPath: extensionRoot, cwd, sessionDir }).filter(
		(argument) => argument !== "--no-session",
	);
	const result = await runIsolated({
		command: host.command,
		args,
		runRoot,
		cwd,
		input: rpcInput([
			{ id: "name", type: "set_session_name", name: "compatibility-session" },
			{ id: "named-state", type: "get_state" },
			{ id: "replace", type: "new_session" },
			{ id: "replacement-state", type: "get_state" },
		]),
		label: "sessions",
		timeoutMs: 30_000,
	});
	assert.equal(result.code, 0, `diagnostics: ${runRoot}\n${result.stderr}`);
	const responses = new Map(
		parseFrames(result.stdout)
			.filter((frame) => frame.type === "response")
			.map((frame) => [frame.id, frame]),
	);
	assert.equal(responses.get("name")?.success, true);
	assert.equal(responses.get("named-state")?.data?.sessionName, "compatibility-session");
	assert.equal(responses.get("replace")?.success, true);
	assert.notEqual(responses.get("replacement-state")?.data?.sessionId, responses.get("named-state")?.data?.sessionId);
});

probeTest("OMP Bun runtime reports node:sqlite as unsupported without touching user data", async () => {
	const runRoot = await createRunRoot("sqlite");
	const cwd = join(runRoot, "workspace");
	const result = await runIsolated({
		command: process.env.BUN_EXECUTABLE || "bun",
		args: ["-e", "await import('node:sqlite')"],
		runRoot,
		cwd,
		label: "node-sqlite",
	});
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /node:sqlite|Could not resolve/);
});
