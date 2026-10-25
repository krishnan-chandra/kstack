import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { councilPaths, withCouncilLock } from "./store.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "kstack-council-store-"));
	roots.push(root);
	return root;
}

/** A pid that certainly has no process: a child that already exited. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number.parseInt(child.stdout, 10);
}

function seedLock(dir: string, pid: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		councilPaths(dir).lock,
		JSON.stringify({ pid, startedAt: new Date().toISOString(), repositoryPath: resolve(dir), ownerToken: "seeded" }),
	);
}

const CONTENDER = `
import { appendFileSync, existsSync } from "node:fs";
import { withCouncilLock } from ${JSON.stringify(join(import.meta.dirname, "store.ts"))};
const [dir, log, go] = process.argv.slice(2);
while (!existsSync(go)) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
const result = await withCouncilLock(dir, async () => {
	appendFileSync(log, "enter " + process.pid + "\\n");
	await new Promise((resolveHold) => setTimeout(resolveHold, 100));
	appendFileSync(log, "exit " + process.pid + "\\n");
});
process.stdout.write(result.ok ? "ok" : "busy");
`;

describe("withCouncilLock", () => {
	it("takes over a dead holder's lock, refuses a live one, and releases only its own lock", async () => {
		const dir = tempDir();
		seedLock(dir, deadPid());
		const taken = await withCouncilLock(dir, async () => JSON.parse(readFileSync(councilPaths(dir).lock, "utf8")).pid);
		assert.deepEqual(taken, { ok: true, value: process.pid });
		assert.equal(existsSync(councilPaths(dir).lock), false);

		seedLock(dir, process.pid);
		const refused = await withCouncilLock(dir, async () => "entered");
		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.error, new RegExp(`pid ${process.pid}\\) holds .*council\\.lock`));
		assert.equal(existsSync(councilPaths(dir).lock), true, "a refused contender leaves the holder's lock");
	});

	it("refuses a contender whose stale-lock decision races another contender's takeover", async () => {
		const dir = tempDir();
		const stale = deadPid();
		seedLock(dir, stale);
		let releaseInner: () => void = () => {};
		const gate = new Promise<void>((resolveGate) => {
			releaseInner = resolveGate;
		});
		const inside: string[] = [];
		let inner: ReturnType<typeof withCouncilLock<string>> | undefined;
		// While the outer contender judges the seeded holder dead, another contender
		// reclaims the same stale lock and enters the critical section.
		const outer = await withCouncilLock(
			dir,
			async () => {
				inside.push("outer");
				return "outer";
			},
			(pid) => {
				if (pid === stale && inner === undefined) {
					inner = withCouncilLock(
						dir,
						async () => {
							inside.push("inner");
							await gate;
							return "inner";
						},
						(candidate) => candidate !== stale,
					);
				}
				return pid !== stale;
			},
		);
		releaseInner();
		assert.equal(outer.ok, false, "the outer contender must not remove the replacement lock");
		assert.deepEqual(await inner, { ok: true, value: "inner" });
		assert.deepEqual(inside, ["inner"]);
		assert.equal(existsSync(councilPaths(dir).lock), false);
	});

	it("never lets concurrent processes share the critical section around a stale lock", {
		timeout: 30_000,
	}, async () => {
		const root = tempDir();
		const dir = join(root, "council");
		const log = join(root, "log");
		const go = join(root, "go");
		const script = join(root, "contender.mjs");
		writeFileSync(script, CONTENDER);
		writeFileSync(log, "");
		seedLock(dir, deadPid());
		const children = Array.from({ length: 6 }, () => {
			const child = spawn(process.execPath, [script, dir, log, go], { stdio: ["ignore", "pipe", "inherit"] });
			let stdout = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			return once(child, "exit").then(() => stdout);
		});
		await new Promise((resolveStart) => setTimeout(resolveStart, 500));
		writeFileSync(go, "");
		const outcomes = await Promise.all(children);
		assert.ok(outcomes.includes("ok"), outcomes.join(","));
		const events = readFileSync(log, "utf8").trim().split("\n");
		assert.equal(events.length, outcomes.filter((outcome) => outcome === "ok").length * 2);
		for (let index = 0; index < events.length; index += 2) {
			const [enter, exit] = [events[index]?.split(" "), events[index + 1]?.split(" ")];
			assert.deepEqual([enter?.[0], exit?.[0], enter?.[1]], ["enter", "exit", exit?.[1]], events.join(" | "));
		}
		assert.equal(existsSync(councilPaths(dir).lock), false);
	});
});
