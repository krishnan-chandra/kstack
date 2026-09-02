import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CAPTURE_BYTES = 128 * 1024;
const SAFE_ENV_KEYS = ["LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TZ"];

export const COMPATIBILITY_ROOT = resolve("local/compatibility");

function isContained(root, candidate) {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

export async function assertDisposablePath(path, runRoot) {
	const resolvedRoot = resolve(runRoot);
	const resolvedPath = resolve(path);
	if (!isContained(resolvedRoot, resolvedPath)) {
		throw new Error(`Refusing writable path outside disposable run root: ${resolvedPath}`);
	}

	let existing = resolvedPath;
	for (;;) {
		try {
			existing = await realpath(existing);
			break;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
		}
	}
	const realRoot = await realpath(resolvedRoot);
	if (!isContained(realRoot, existing)) {
		throw new Error(`Refusing writable path through a symlink outside disposable run root: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function isolatedEnvironment({ runRoot, source = process.env, extra = {} }) {
	const env = {};
	for (const key of SAFE_ENV_KEYS) {
		if (source[key]) env[key] = source[key];
	}
	for (const [key, value] of Object.entries(extra)) {
		if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) {
			throw new Error(`Refusing credential-like environment override: ${key}`);
		}
		if (value !== undefined) env[key] = value;
	}
	const home = join(runRoot, "home");
	const agentDir = join(runRoot, "agent");
	return {
		...env,
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CACHE_HOME: join(runRoot, "cache"),
		XDG_CONFIG_HOME: join(runRoot, "config"),
		XDG_DATA_HOME: join(runRoot, "data"),
	};
}

function boundedAppend(current, chunk, limit) {
	if (current.length >= limit) return current;
	return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
}

async function terminateProcessGroup(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

export async function createRunRoot(label = "run") {
	const executionBase = join(tmpdir(), "kstack-omp-compatibility");
	await Promise.all([mkdir(COMPATIBILITY_ROOT, { recursive: true }), mkdir(executionBase, { recursive: true })]);
	const executionRoot = await mkdtemp(join(executionBase, `${label}-`));
	await Promise.all([mkdir(join(executionRoot, "workspace")), mkdir(join(executionRoot, "sessions"))]);
	const retainedPath = join(COMPATIBILITY_ROOT, basename(executionRoot));
	await symlink(executionRoot, retainedPath, "dir");
	return retainedPath;
}

async function installMutationSentinels(runRoot) {
	const binDir = join(runRoot, "sentinel-bin");
	const logPath = join(runRoot, "mutation-attempts.log");
	await mkdir(binDir, { recursive: true });
	for (const command of ["gh", "git", "jj", "gt"]) {
		const path = join(binDir, command);
		await writeFile(
			path,
			`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(command)} >> ${JSON.stringify(logPath)}\nexit 97\n`,
		);
		await chmod(path, 0o700);
	}
	return { binDir, logPath };
}

export async function runIsolated({
	command,
	args = [],
	runRoot,
	cwd,
	env,
	input,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	captureBytes = DEFAULT_CAPTURE_BYTES,
	label = basename(command),
}) {
	await assertDisposablePath(cwd, runRoot);
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(join(runRoot, "logs"), { recursive: true }),
		mkdir(join(runRoot, "home"), { recursive: true }),
		mkdir(join(runRoot, "agent"), { recursive: true }),
	]);
	const sentinels = await installMutationSentinels(runRoot);
	const safeLabel = label.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
	const stdoutPath = join(runRoot, "logs", `${safeLabel}.stdout.log`);
	const stderrPath = join(runRoot, "logs", `${safeLabel}.stderr.log`);
	const stdoutLog = createWriteStream(stdoutPath);
	const stderrLog = createWriteStream(stderrPath);
	const logsClosed = Promise.all([once(stdoutLog, "close"), once(stderrLog, "close")]);
	const startedAt = Date.now();
	const isolatedEnv = isolatedEnvironment({ runRoot, extra: env });
	isolatedEnv.PATH = `${sentinels.binDir}:${isolatedEnv.PATH ?? ""}`;
	const child = spawn(command, args, {
		cwd,
		env: isolatedEnv,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.pipe(stdoutLog);
	child.stderr.pipe(stderrLog);
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let stdoutPreview = Buffer.alloc(0);
	let stderrPreview = Buffer.alloc(0);
	child.stdout.on("data", (chunk) => {
		stdoutBytes += chunk.length;
		stdoutPreview = boundedAppend(stdoutPreview, chunk, captureBytes);
	});
	child.stderr.on("data", (chunk) => {
		stderrBytes += chunk.length;
		stderrPreview = boundedAppend(stderrPreview, chunk, captureBytes);
	});
	if (input !== undefined) child.stdin.end(input);
	else child.stdin.end();

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void terminateProcessGroup(child);
	}, timeoutMs);
	const result = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolvePromise({ code, signal }));
	});
	clearTimeout(timer);
	await logsClosed;
	return {
		...result,
		timedOut,
		durationMs: Date.now() - startedAt,
		stdout: stdoutPreview.toString("utf8"),
		stderr: stderrPreview.toString("utf8"),
		stdoutTruncated: stdoutBytes > stdoutPreview.length,
		stderrTruncated: stderrBytes > stderrPreview.length,
		stdoutPath,
		stderrPath,
		mutationLogPath: sentinels.logPath,
	};
}

export async function resolveOmpHost(ompCheckout, ompExecutable = process.env.OMP_EXECUTABLE) {
	if (!ompCheckout || !isAbsolute(ompCheckout)) {
		throw new Error("OMP checkout must be supplied as an absolute path");
	}
	const checkout = await realpath(ompCheckout);
	if (ompExecutable) {
		if (!isAbsolute(ompExecutable)) throw new Error("OMP executable must be supplied as an absolute path");
		const executable = await realpath(ompExecutable);
		return { checkout, command: executable, hostArgs: [] };
	}
	const cliPath = join(checkout, "packages", "coding-agent", "src", "cli.ts");
	await readFile(cliPath);
	return { checkout, command: process.env.BUN_EXECUTABLE || "bun", hostArgs: [cliPath] };
}

export function ompRpcArgs({ hostArgs, extensionPath, cwd, sessionDir }) {
	return [
		...hostArgs,
		"--mode",
		"rpc",
		"--cwd",
		realpathSync(cwd),
		"--session-dir",
		realpathSync(sessionDir),
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-tools",
		"--no-lsp",
		"--no-title",
		"--model",
		"compat/fixture-model",
		"--extension",
		extensionPath,
	];
}
