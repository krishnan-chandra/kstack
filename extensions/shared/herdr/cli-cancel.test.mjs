import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

for (const signal of ["SIGTERM", "SIGINT"]) {
	test(`fanout drains accepted work and saves partial results on ${signal}`, { timeout: 10000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-cli-cancel-"));
		let child;
		try {
			mkdirSync(join(root, "extensions"));
			writeFileSync(join(root, "extensions/herdr-agent-state.ts"), "");
			writeFileSync(join(root, "prompt.md"), "task");
			writeFileSync(
				join(root, "herdr"),
				`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), command = args.slice(0,2).join(' ');
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const agent = { name: args[2], pane_id: 'w1:p2', tab_id: 'w1:t2', agent_status: 'idle', cwd: process.env.PI_CODING_AGENT_DIR };
let result = { type: 'ok' };
if (command === 'tab create') result = { type: 'tab_created', tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } };
if (command === 'pane layout') result = { type: 'pane_layout', layout: { area: { width: 240, height: 60 } } };
if (command === 'agent start') result = { type: 'agent_started', agent };
if (command === 'agent get' || command === 'agent wait') result = { type: 'agent_info', agent };
if (command === 'agent prompt') {
  fs.writeFileSync(process.env.FIXTURE_ACCEPTED, 'accepted');
  setInterval(() => {}, 1000);
} else process.stdout.write(JSON.stringify({ result }));
`,
				{ mode: 0o700 },
			);
			const tasks = ["active", "queued"].map((label) => ({
				label,
				model: "p/m",
				cwd: root,
				promptFile: join(root, "prompt.md"),
				outputFile: join(root, `${label}.md`),
			}));
			writeFileSync(
				join(root, "spec.json"),
				JSON.stringify({ owner: "swarm", label: "cancel", cwd: root, maxConcurrency: 1, tasks }),
			);
			const log = join(root, "calls.jsonl");
			const accepted = join(root, "accepted");
			child = spawn(
				process.execPath,
				[
					join(import.meta.dirname, "cli.mjs"),
					"fanout",
					"--spec",
					join(root, "spec.json"),
					"--out",
					join(root, "result.json"),
				],
				{
					env: {
						...process.env,
						PATH: `${root}:${process.env.PATH}`,
						HERDR_ENV: "1",
						HERDR_WORKSPACE_ID: "w1",
						HERDR_PANE_ID: "w1:p1",
						PI_CODING_AGENT_DIR: root,
						FIXTURE_LOG: log,
						FIXTURE_ACCEPTED: accepted,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let diagnostic = "";
			child.stderr.on("data", (chunk) => {
				diagnostic += chunk;
			});
			const exit = once(child, "exit");
			for (let n = 0; !existsSync(accepted) && n < 400; n++) await setTimeout(10);
			assert.ok(
				existsSync(accepted),
				`fixture reached accepted prompt: ${diagnostic}; ${existsSync(log) ? readFileSync(log, "utf8") : "no commands"}; ${existsSync(join(root, "result.json")) ? readFileSync(join(root, "result.json"), "utf8") : "no result"}`,
			);
			child.kill(signal);
			assert.deepEqual(await exit, [1, null]);
			const calls = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.ok(calls.some((args) => args[1] === "send-keys"));
			assert.ok(calls.some((args) => args[1] === "wait"));
			assert.equal(calls.filter((args) => args[1] === "start").length, 1);
			const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
			assert.deepEqual(
				result.results.map((item) => item.status),
				["aborted", "aborted"],
			);
		} finally {
			child?.kill("SIGKILL");
			rmSync(root, { recursive: true, force: true });
		}
	});
}
