/**
 * End-to-end wiring harness for the panel-review live dashboard.
 *
 * Not a unit test: registers the real extension and runs /panel-review
 * against a temp Git fixture with a stubbed TUI context. Children are faked:
 * runReviewer always spawns the *current script* under node, so this file
 * doubles as the fake `pi` child — when invoked with `--mode json -p` it
 * streams deterministic JSONL events instead of running the harness.
 *
 * Asserts the dashboard widget mounted, saw queued/running/completed
 * transitions with maxConcurrency=1 keeping later reviewers visibly queued,
 * streamed only text_delta (never thinking_delta) previews, showed a lead
 * synthesis row, never leaked control bytes, and was cleared in the finally
 * path along with the footer status.
 *
 * Run: node extensions/panel-review/scripts/panel-review-dashboard-e2e.ts
 *
 * Requires the Pi runtime packages to be resolvable from the repository root
 * (they are when run inside a Pi extension host; otherwise symlink them in):
 *   mkdir -p node_modules/@earendil-works && cd node_modules/@earendil-works &&
 *   ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" pi-coding-agent &&
 *   ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" pi-tui &&
 *   ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core" pi-agent-core
 */

import assert from "node:assert/strict";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--mode")) {
	// ── Fake pi child ────────────────────────────────────────────────────
	const lines: object[] = [
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden reasoning" } },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/x/bundle.md" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reading the diff… " } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "read" },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "No findings." } },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "No findings." }],
				usage: { input: 100, output: 20, cost: { total: 0.001 } },
			},
		},
	];
	for (const line of lines) {
		process.stdout.write(JSON.stringify(line) + "\n");
		await sleep(120); // keep the child alive long enough for queue states to render
	}
	process.exit(0);
}

// ── Harness ──────────────────────────────────────────────────────────────
const { execFileSync } = await import("node:child_process");
const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const root = mkdtempSync(join(tmpdir(), "pr-dashboard-e2e-"));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
writeFileSync(join(repo, "a.ts"), "export const a = 2;\n"); // uncommitted change

// maxConcurrency=1 forces a visible queue; no real provider calls happen
// because the child is this same script.
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(
	join(agentDir, "kstack.json"),
	JSON.stringify({
		"panel-review": {
			reviewers: [
				{ label: "rev-a", model: "fake/model-a" },
				{ label: "rev-b", model: "fake/model-b" },
			],
			maxConcurrency: 1,
			timeoutMinutes: 1,
			maxRuntimeMinutes: 1,
			synthesis: { model: "fake/synth" },
		},
	}),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const widgets = new Map<string, unknown>();
let component: { render(w: number): string[]; dispose?(): void } | undefined;
let renders = 0;
const snapshots: string[][] = [];
const snapshot = () => component && snapshots.push(component.render(100));
const statuses = new Map<string, string | undefined>();
const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: repo,
	waitForIdle: async () => {},
	ui: {
		notify: () => {},
		confirm: async () => true,
		editor: async (_t: string, prefill: string) => prefill,
		setStatus: (key: string, v: string | undefined) => statuses.set(key, v),
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) {
				widgets.delete(key);
				component?.dispose?.();
				component = undefined;
				return;
			}
			widgets.set(key, content);
			component = (content as (tui: unknown, theme: unknown) => typeof component)(
				{ requestRender: () => { renders++; snapshot(); } },
				{ fg: (_c: string, t: string) => t },
			);
			snapshot();
		},
	},
	modelRegistry: {
		find: () => ({ provider: "fake" }),
		hasConfiguredAuth: () => true,
	},
	scopedModels: [],
	model: { provider: "fake", id: "model-x" },
};

let handler: ((args: string, c: unknown) => Promise<void>) | undefined;
let sentMessage: { content: string } | undefined;
const pi = {
	registerShortcut: () => {},
	registerMessageRenderer: () => {},
	events: { on: () => {} },
	on: () => {},
	registerCommand(_name: string, desc: { handler: (args: string, c: unknown) => Promise<void> }) {
		handler = desc.handler;
	},
	sendMessage: (m: { content: string }) => { sentMessage = m; },
};
const { default: register } = await import("../index.ts");
register(pi as never);
assert.ok(handler, "command registered");

await handler("--base HEAD --intent verify-dashboard", ctx);

// ── Assertions ───────────────────────────────────────────────────────────
assert.ok(renders > 5, `expected repeated re-renders, got ${renders}`);
assert.ok(!widgets.has("panel-review"), "widget cleared on completion");
assert.equal(component, undefined, "component disposed");
assert.equal(statuses.get("panel-review"), undefined, "footer status cleared");

const flat = snapshots.map((s) => s.join("\n"));
assert.ok(flat.some((s) => /rev-a — (queued|running)/.test(s)), "rev-a visible");
assert.ok(
	flat.some((s) => s.includes("rev-b — queued") && s.includes("rev-a — running")),
	"rev-b stays queued while rev-a runs (maxConcurrency=1)",
);
assert.ok(flat.some((s) => s.includes("No findings")), "live text_delta preview rendered");
assert.ok(!flat.some((s) => s.includes("hidden reasoning")), "thinking deltas never displayed");
assert.ok(
	flat.some((s) => s.includes("rev-a — completed") && s.includes("rev-b — running")),
	"rows update independently",
);

const leadLines = flat.filter((s) => s.includes("lead — "));
assert.ok(leadLines.some((s) => s.includes("lead — running (lead synthesis)")), "lead row visible during synthesis");
assert.ok(leadLines.some((s) => s.includes("lead — completed")), "lead row completes");

// Terminal-injection safety: no raw control bytes in any rendered snapshot.
for (const snap of snapshots) {
	for (const line of snap) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting stray control bytes is the point
		assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line), `control byte in ${JSON.stringify(line)}`);
	}
}

assert.ok(sentMessage, "verdict message sent");
console.log(`e2e ok: ${snapshots.length} snapshots, ${renders} renders, verdict "${sentMessage.content.slice(0, 40)}"`);
