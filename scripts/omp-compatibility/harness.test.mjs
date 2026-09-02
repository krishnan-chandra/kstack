import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDisposablePath, createRunRoot, isolatedEnvironment, runIsolated } from "./harness.mjs";

test("isolated environment keeps only allowlisted process values and relocates user state", async () => {
	const runRoot = await createRunRoot("environment");
	const env = isolatedEnvironment({
		runRoot,
		source: { PATH: "/bin", HOME: "/real-home", OPENAI_API_KEY: "secret", PI_CODING_AGENT_DIR: "/real-agent" },
	});
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, join(runRoot, "home"));
	assert.equal(env.PI_CODING_AGENT_DIR, join(runRoot, "agent"));
	assert.equal(env.OPENAI_API_KEY, undefined);
});

test("writable paths must stay inside the disposable root, including through symlinks", async () => {
	const runRoot = await createRunRoot("containment");
	await mkdir(join(runRoot, "safe"));
	assert.equal(await assertDisposablePath(join(runRoot, "safe", "child"), runRoot), join(runRoot, "safe", "child"));
	await assert.rejects(() => assertDisposablePath(homedir(), runRoot), /outside disposable run root/);
	const escapePath = join(runRoot, "escape");
	await symlink(homedir(), escapePath);
	await assert.rejects(() => assertDisposablePath(join(escapePath, "file"), runRoot), /through a symlink/);
	await rm(escapePath);
});

test("runner strips credentials, bounds previews, and retains complete logs", async () => {
	const runRoot = await createRunRoot("capture");
	const cwd = join(runRoot, "workspace");
	const script = join(runRoot, "emit.mjs");
	await writeFile(
		script,
		`process.stdout.write("x".repeat(256)); process.stderr.write(String(process.env.OPENAI_API_KEY));`,
	);
	const result = await runIsolated({
		command: process.execPath,
		args: [script],
		runRoot,
		cwd,
		captureBytes: 32,
	});
	assert.equal(result.code, 0);
	assert.equal(result.stdout.length, 32);
	assert.equal(result.stdoutTruncated, true);
	assert.equal(result.stderr, "undefined");
	assert.equal((await readFile(result.stdoutPath, "utf8")).length, 256);
});

test("runner blocks external VCS and GitHub commands", async () => {
	const runRoot = await createRunRoot("mutation-sentinel");
	const cwd = join(runRoot, "workspace");
	const script = join(runRoot, "mutate.mjs");
	await writeFile(
		script,
		`import { spawnSync } from "node:child_process"; const result = spawnSync("gh", ["pr", "merge", "1"]); process.exit(result.status ?? 1);`,
	);
	const result = await runIsolated({ command: process.execPath, args: [script], runRoot, cwd });
	assert.equal(result.code, 97);
	assert.equal(await readFile(result.mutationLogPath, "utf8"), "gh\n");
});

test("runner times out and terminates the process group", async () => {
	const runRoot = await createRunRoot("timeout");
	const cwd = join(runRoot, "workspace");
	const marker = join(runRoot, "descendant-finished");
	const script = join(runRoot, "wait.mjs");
	await writeFile(
		script,
		`import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad"), 1000)`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);`,
	);
	const result = await runIsolated({ command: process.execPath, args: [script], runRoot, cwd, timeoutMs: 100 });
	assert.equal(result.timedOut, true);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
	await assert.rejects(() => access(marker));
});
