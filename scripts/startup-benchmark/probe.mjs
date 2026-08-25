import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const STARTUP_ARGUMENTS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
	"--no-approve",
	"--model",
	"startup-benchmark/probe",
];

const REQUEST_ID = "startup-benchmark-ready";
const MAX_CAPTURE_CHARS = 64 * 1024;
const MAX_EVENT_COUNT = 20;
const ERROR_TAIL_CHARS = 4 * 1024;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const TERMINATE_GRACE_MS = 250;
const KILL_GRACE_MS = 250;

function isNumber(value) {
	return Object.prototype.toString.call(value) === "[object Number]";
}

function isRecord(value) {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
	return Object.prototype.toString.call(value) === "[object String]";
}

function stripAnsi(value) {
	return value.replace(ANSI_ESCAPE, "");
}

function createTimingParser() {
	const groups = {};
	let currentGroup;

	return {
		consume(rawLine) {
			const line = stripAnsi(rawLine).replace(/\r$/, "");
			const heading = /^---\s*Startup Timings:\s*(.+?)\s*---\s*$/.exec(line.trim());
			if (heading) {
				currentGroup = heading[1];
				groups[currentGroup] ??= { labels: [] };
				return;
			}
			if (!currentGroup) return;

			const entry = /^\s*(.+?):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))ms\s*$/.exec(line);
			if (entry) {
				const label = entry[1].trim();
				const ms = Number(entry[2]);
				const group = groups[currentGroup];
				group.labels.push({ label, ms });
				if (label === "TOTAL") group.totalMs = ms;
				return;
			}

			if (/^-{3,}\s*$/.test(line.trim())) currentGroup = undefined;
		},
		result() {
			return groups;
		},
	};
}

function appendTail(existing, value, limit = MAX_CAPTURE_CHARS) {
	const combined = `${existing}${value}`;
	return combined.length <= limit ? combined : combined.slice(-limit);
}

function createLineFramer({ onLine, onOverflow, onText, processFinalRemainder }) {
	const decoder = new StringDecoder("utf8");
	let remainder = "";
	let finished = false;

	function consumeText(value) {
		const text = `${remainder}${value}`;
		let offset = 0;
		while (true) {
			const newline = text.indexOf("\n", offset);
			if (newline === -1) break;
			let line = text.slice(offset, newline);
			offset = newline + 1;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > MAX_CAPTURE_CHARS) onOverflow();
			else onLine(line);
		}

		remainder = text.slice(offset);
		if (remainder.length > MAX_CAPTURE_CHARS) {
			onOverflow();
			remainder = remainder.slice(-MAX_CAPTURE_CHARS);
		}
	}

	return {
		consume(chunk) {
			const text = decoder.write(chunk);
			onText?.(text);
			consumeText(text);
		},
		finish() {
			if (finished) return;
			finished = true;
			const text = decoder.end();
			onText?.(text);
			consumeText(text);
			if (processFinalRemainder && remainder.length > 0) onLine(remainder.replace(/\r$/, ""));
			remainder = "";
		},
	};
}

function createProbeCapture() {
	const timingParser = createTimingParser();
	let stdoutFramer;
	let stderrTail = "";
	let extensionLoadDiagnostic = false;
	let outputOverflow = false;
	const events = [];
	const stderrFramer = createLineFramer({
		onLine(line) {
			timingParser.consume(line);
			if (/Failed to load extension/i.test(line)) extensionLoadDiagnostic = true;
		},
		onText(text) {
			stderrTail = appendTail(stderrTail, text);
		},
		onOverflow() {
			outputOverflow = true;
		},
		processFinalRemainder: true,
	});

	function addEvent(event) {
		let detail;
		try {
			detail = JSON.stringify(event).slice(0, 1024);
		} catch {
			detail = "[unserializable RPC event]";
		}
		events.push({
			type: isString(event.type) ? event.type : undefined,
			id: isString(event.id) ? event.id : undefined,
			command: isString(event.command) ? event.command : undefined,
			detail,
		});
		if (events.length > MAX_EVENT_COUNT) events.shift();
	}

	return {
		consumeStdout(chunk, onLine) {
			stdoutFramer ??= createLineFramer({
				onLine,
				onOverflow() {
					outputOverflow = true;
				},
				processFinalRemainder: false,
			});
			stdoutFramer.consume(chunk);
		},
		consumeStderr(chunk) {
			stderrFramer.consume(chunk);
		},
		finish() {
			stdoutFramer?.finish();
			stderrFramer.finish();
		},
		addEvent,
		get extensionLoadDiagnostic() {
			return extensionLoadDiagnostic;
		},
		get outputOverflow() {
			return outputOverflow;
		},
		get stderrTail() {
			return stderrTail;
		},
		get events() {
			return [...events];
		},
		get timings() {
			return timingParser.result();
		},
	};
}

function describeExit(exit) {
	if (!exit) return "unknown";
	if (exit.signal) return `signal ${exit.signal}`;
	if (isNumber(exit.code)) return `status ${exit.code}`;
	return "unknown";
}

function validateCommandInventory(response, scenario) {
	if (!response.data || !Array.isArray(response.data.commands)) {
		throw new Error("Received a malformed correlated get_commands response.");
	}

	const names = new Set(
		response.data.commands
			.filter((command) => isRecord(command) && isString(command.name))
			.map((command) => command.name),
	);
	const missing = scenario.requiredCommands.filter((name) => !names.has(name));
	const unexpected = scenario.forbiddenCommands.filter((name) => names.has(name));
	if (missing.length === 0 && unexpected.length === 0) return [...names].sort();

	const problems = [];
	if (missing.length > 0) problems.push(`missing required commands: ${missing.join(", ")}`);
	if (unexpected.length > 0) problems.push(`unexpected package commands: ${unexpected.join(", ")}`);
	throw new Error(`Command inventory check failed: ${problems.join("; ")}.`);
}

function requireTimingGroups(timings, requirements) {
	for (const [groupName, required] of Object.entries(requirements)) {
		if (!required) continue;
		const group = timings[groupName];
		if (!group || !Number.isFinite(group.totalMs)) {
			throw new Error(`PI_TIMING output is missing Startup Timings: ${groupName} with a TOTAL value.`);
		}
	}
}

function createLifecycle(child) {
	let closed = false;
	let exit;
	let resolveClosed;
	const closedPromise = new Promise((resolve) => {
		resolveClosed = resolve;
	});

	child.once("close", (code, signal) => {
		closed = true;
		exit = { code, signal };
		resolveClosed(exit);
	});

	return {
		get closed() {
			return closed;
		},
		get exit() {
			return exit;
		},
		closedPromise,
	};
}

function waitForReadiness({ child, capture, scenario, timeoutMs, startedAt }) {
	return new Promise((resolveReadiness, rejectReadiness) => {
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback(value);
		};
		const handleRecord = (line) => {
			if (settled || line.length === 0) return;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				capture.addEvent({ type: "malformed" });
				return;
			}
			if (!isRecord(record)) return;
			if (record.id !== REQUEST_ID) {
				capture.addEvent(record);
				return;
			}
			if (record.type !== "response" || record.command !== "get_commands") {
				finish(rejectReadiness, new Error("Received a malformed correlated get_commands response."));
				return;
			}
			if (record.success !== true) {
				const detail = isString(record.error) ? `: ${record.error}` : "";
				finish(rejectReadiness, new Error(`get_commands reported failure${detail}`));
				return;
			}

			try {
				const commandNames = validateCommandInventory(record, scenario);
				const wallMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
				finish(resolveReadiness, { wallMs, commandNames });
			} catch (error) {
				finish(rejectReadiness, error);
			}
		};
		const timeout = setTimeout(() => {
			finish(rejectReadiness, new Error(`Timed out after ${timeoutMs}ms waiting for get_commands readiness.`));
		}, timeoutMs);

		if (!child.stdin || !child.stdout || !child.stderr) {
			finish(rejectReadiness, new Error("Pi probe did not expose stdin, stdout, and stderr streams."));
			return;
		}
		child.stdout.on("data", (chunk) => capture.consumeStdout(chunk, handleRecord));
		child.stderr.on("data", (chunk) => capture.consumeStderr(chunk));
		child.stdout.on("error", (error) => finish(rejectReadiness, error));
		child.stderr.on("error", (error) => finish(rejectReadiness, error));
		child.stdin.on("error", (error) => finish(rejectReadiness, error));
		child.once("error", (error) => finish(rejectReadiness, error));
		child.once("exit", (code, signal) => {
			if (settled) return;
			finish(rejectReadiness, new Error(`Exited before readiness with ${describeExit({ code, signal })}.`));
		});

		try {
			child.stdin.write(`${JSON.stringify({ id: REQUEST_ID, type: "get_commands" })}\n`);
		} catch (error) {
			finish(rejectReadiness, error);
		}
	});
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForClose(lifecycle, milliseconds) {
	if (lifecycle.closed) return lifecycle.exit;
	return Promise.race([lifecycle.closedPromise, delay(milliseconds).then(() => undefined)]);
}

async function terminateChild(child, lifecycle) {
	if (lifecycle.closed) return lifecycle.exit;
	if (child.stdin && !child.stdin.destroyed) child.stdin.end();

	try {
		child.kill("SIGTERM");
	} catch {
		// The close wait handles a child that exits between the state check and kill.
	}
	const afterTerminate = await waitForClose(lifecycle, TERMINATE_GRACE_MS);
	if (afterTerminate) return afterTerminate;

	try {
		child.kill("SIGKILL");
	} catch {
		// The second close wait reports a survivor if this kill cannot reach it.
	}
	const afterKill = await waitForClose(lifecycle, KILL_GRACE_MS);
	if (afterKill) return afterKill;

	throw new Error("Child did not exit after SIGTERM and SIGKILL.");
}

function decorateProbeError(error, { scenario, lifecycle, capture }) {
	const detail = error instanceof Error ? error.message : String(error);
	const lines = [`Startup probe "${scenario.id}" failed: ${detail}`, `Exit: ${describeExit(lifecycle?.exit)}`];
	if (capture.events.length > 0) lines.push(`Recent RPC events: ${JSON.stringify(capture.events)}`);
	const stderr = capture.stderrTail.trim();
	if (stderr) lines.push(`stderr tail:\n${stderr.slice(-ERROR_TAIL_CHARS)}`);
	return new Error(lines.join("\n"), { cause: error });
}

export async function runProbe({ scenario, piPath, cwd, env, timeoutMs }) {
	const capture = createProbeCapture();
	const startedAt = process.hrtime.bigint();
	let child;
	let lifecycle;
	let readiness;
	let primaryError;
	let cleanupError;

	try {
		child = spawn(piPath, STARTUP_ARGUMENTS, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		lifecycle = createLifecycle(child);
		readiness = await waitForReadiness({ child, capture, scenario, timeoutMs, startedAt });
	} catch (error) {
		primaryError = error;
	} finally {
		if (child && lifecycle) {
			try {
				await terminateChild(child, lifecycle);
			} catch (error) {
				cleanupError = error;
			}
		}
		capture.finish();
	}

	if (primaryError && cleanupError) {
		const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
		const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
		throw decorateProbeError(
			new Error(`${primaryMessage}\nCleanup failed: ${cleanupMessage}`, { cause: primaryError }),
			{
				scenario,
				lifecycle,
				capture,
			},
		);
	}
	if (primaryError) throw decorateProbeError(primaryError, { scenario, lifecycle, capture });
	if (cleanupError) throw decorateProbeError(cleanupError, { scenario, lifecycle, capture });
	if (capture.outputOverflow) {
		throw decorateProbeError(
			new Error(`RPC or timing output exceeded the ${MAX_CAPTURE_CHARS}-character record cap.`),
			{
				scenario,
				lifecycle,
				capture,
			},
		);
	}
	if (capture.extensionLoadDiagnostic) {
		throw decorateProbeError(new Error("Pi reported an extension-load diagnostic."), { scenario, lifecycle, capture });
	}

	try {
		requireTimingGroups(capture.timings, scenario.timingRequirements);
	} catch (error) {
		throw decorateProbeError(error, { scenario, lifecycle, capture });
	}

	return { ...readiness, timings: capture.timings };
}
