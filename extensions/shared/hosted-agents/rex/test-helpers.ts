/** Stateful in-memory Rex server for backend, council, and contract tests. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../validation.ts";
import { KSTACK_HOSTED_AGENT_NAME_ENV, KSTACK_HOSTED_AGENT_STATE_ENV, writeHostedAgentState } from "../agent-state.ts";
import type { BackendExec, ExecResult } from "../terminal-backend.ts";

export interface FakeRexBlock {
	windowId: string;
	label: string;
	cwd: string;
	columns: number;
	rows: number;
	/** `null` mimics an unviewed background block. */
	owner: string | null;
	/** Foreground process. */
	pid: number;
	processName: string;
	bracketedPaste: boolean;
	captureText: string;
	piState?: string;
	updatedAt: string;
	/** Pi status owner pid; defaults to the foreground pid. */
	piPid?: number;
	pendingInput?: string;
	stateFile?: string;
	sessionFile?: string;
}

/** How the fake Pi behaves once the launcher runs: ready, or blocked at a startup dialog before `session_start`. */
type FakeLaunchBehavior = "ok" | "not-ready";

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const NOT_FOUND: ExecResult = { code: 3, stdout: "", stderr: "Error: block target not found" };

function json(value: JsonObject): ExecResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export class FakeRex {
	readonly calls: string[][] = [];
	readonly sessionId: string;
	readonly callerBlock = "block:caller";
	readonly root: string;
	readonly blocks = new Map<string, FakeRexBlock>();
	readonly closed: string[] = [];
	readonly keysByBlock = new Map<string, string[][]>();
	readonly launchBehavior = new Map<string, FakeLaunchBehavior>();
	apiRevision = 12;
	onSend: ((blockId: string, text: string) => void) | undefined;
	/** Replaces the default Enter handling (run a pending launcher). */
	onEnter: ((blockId: string, input: string, block: FakeRexBlock) => void) | undefined;
	onKeys: ((blockId: string, keys: string[], block: FakeRexBlock) => void) | undefined;
	private nextId = 10;
	private tick = 1;

	constructor(root: string, options: { sessionId?: string; callerWindow?: string } = {}) {
		this.root = root;
		this.sessionId = options.sessionId ?? "session:test";
		this.blocks.set(this.callerBlock, {
			windowId: options.callerWindow ?? "window:caller",
			label: "caller",
			cwd: root,
			columns: 240,
			rows: 60,
			owner: "client:1",
			pid: 100,
			processName: "node",
			bracketedPaste: true,
			captureText: "",
			piState: "working",
			updatedAt: this.nextTimestamp(),
		});
	}

	get env(): NodeJS.ProcessEnv {
		return { REX_SESSION: this.sessionId, REX_BLOCK: this.callerBlock };
	}

	nextTimestamp(): string {
		const tick = this.tick++;
		return `2026-11-11T17:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick % 60).padStart(2, "0")}.000000Z`;
	}

	block(blockId: string): FakeRexBlock {
		const found = this.blocks.get(blockId);
		if (!found) throw new Error(`FakeRex has no block ${blockId}`);
		return found;
	}

	addShellBlock(blockId: string, windowId: string, cwd = this.root, label = "shell"): FakeRexBlock {
		const block: FakeRexBlock = {
			windowId,
			label,
			cwd,
			columns: 80,
			rows: 24,
			owner: null,
			pid: 2000 + this.nextId++,
			processName: "zsh",
			bracketedPaste: true,
			captureText: "",
			updatedAt: this.nextTimestamp(),
		};
		this.blocks.set(blockId, block);
		return block;
	}

	/** A live Pi agent with a valid sidecar, as if launched by another host. */
	addAgentBlock(name: string, options: { blockId?: string; windowId?: string; sidecar?: boolean } = {}): FakeRexBlock {
		const blockId = options.blockId ?? `block:ext-${this.nextId++}`;
		const block = this.addShellBlock(blockId, options.windowId ?? "window:caller", this.root, name);
		block.processName = "node";
		block.piState = "idle";
		if (options.sidecar !== false) {
			block.stateFile = join(this.root, `${name}.state.json`);
			block.sessionFile = join(this.root, `${name}.jsonl`);
			writeFileSync(block.sessionFile, "");
			writeHostedAgentState(block.stateFile, {
				version: 1,
				name,
				pid: block.pid,
				cwd: block.cwd,
				sessionFile: block.sessionFile,
				sessionId: `sess-${block.pid}`,
				updatedAt: block.updatedAt,
			});
		}
		return block;
	}

	blockIdOf(block: FakeRexBlock): string {
		for (const [id, candidate] of this.blocks) if (candidate === block) return id;
		throw new Error("FakeRex block is not registered");
	}

	/** Run the launcher script the backend typed into `block`, as the pane's shell would. */
	runLauncher(block: FakeRexBlock, launcherPath: string): void {
		const script = readFileSync(launcherPath, "utf8");
		const stateFile = new RegExp(`${KSTACK_HOSTED_AGENT_STATE_ENV}='([^']+)'`).exec(script)?.[1] ?? "";
		const name = new RegExp(`${KSTACK_HOSTED_AGENT_NAME_ENV}='([^']+)'`).exec(script)?.[1] ?? "agent";
		const behavior = this.launchBehavior.get(name) ?? "ok";
		block.pid = 5000 + this.nextId++;
		block.processName = "node";
		block.stateFile = stateFile;
		block.updatedAt = this.nextTimestamp();
		block.piState = behavior === "ok" ? "idle" : "blocked";
		if (behavior === "ok") {
			block.sessionFile = join(this.root, `${name}.jsonl`);
			writeFileSync(block.sessionFile, "");
		}
		writeHostedAgentState(stateFile, {
			version: 1,
			name,
			pid: block.pid,
			cwd: block.cwd,
			...(block.sessionFile ? { sessionFile: block.sessionFile, sessionId: `sess-${block.pid}` } : undefined),
			updatedAt: block.updatedAt,
		});
	}

	keysSentTo(blockId: string): string[][] {
		return this.keysByBlock.get(blockId) ?? [];
	}

	readonly exec: BackendExec = async (args) => {
		this.calls.push(args);
		const [group, command] = args;
		if (group === "whoami") {
			return json({
				api_revision: this.apiRevision,
				session_id: this.sessionId,
				window_id: this.blocks.get(this.callerBlock)?.windowId,
				block_id: this.callerBlock,
			});
		}
		if (group === "window" && command === "new") {
			const windowId = `window:${this.nextId++}`;
			const blockId = `block:${this.nextId++}`;
			this.addShellBlock(blockId, windowId, flag(args, "-c") ?? this.root, args[4] ?? "shell");
			return json({ window_id: windowId, block_ids: [blockId] });
		}
		if (group === "window" && command === "close") {
			for (const [id, block] of this.blocks) if (block.windowId === args[4]) this.blocks.delete(id);
			return OK;
		}
		if (group === "split") {
			const anchorId = flag(args, "-b") ?? "";
			const anchor = this.blocks.get(anchorId);
			if (!anchor) return NOT_FOUND;
			const blockId = `block:${this.nextId++}`;
			this.addShellBlock(blockId, anchor.windowId, flag(args, "-c") ?? anchor.cwd, flag(args, "--label") ?? "shell");
			return json({ anchor_id: anchorId, block_ids: [blockId] });
		}
		if (group === "block" && command === "ls") {
			return json({
				blocks: [...this.blocks].map(([blockId, block]) => ({
					block_id: blockId,
					window_id: block.windowId,
					label: block.label,
				})),
			});
		}
		if (group === "block" && (command === "inspect" || command === "rename" || command === "close")) {
			const blockId = args[4] ?? "";
			const block = this.blocks.get(blockId);
			if (command === "close") this.closed.push(blockId);
			if (!block) return NOT_FOUND;
			if (command === "rename") block.label = args[5] ?? block.label;
			if (command === "close") this.blocks.delete(blockId);
			if (command !== "inspect") return OK;
			return json({
				session_id: this.sessionId,
				block: { block_id: blockId, window_id: block.windowId, label: block.label },
				api: { methods: { program_status: {}, modes: {}, process: {}, size: {} } },
			});
		}
		const blockId = flag(args, "-b") ?? "";
		const block = this.blocks.get(blockId);
		if (!block) return NOT_FOUND;
		if (group === "block" && command === "call") {
			return this.blockCall(block, args.at(-1) ?? "");
		}
		if (group === "send") {
			block.pendingInput = args.at(-1) ?? "";
			this.onSend?.(blockId, block.pendingInput);
			return OK;
		}
		if (group === "send-key") {
			const keys = args.slice(args.indexOf("-b") + 2);
			if (keys.length === 1 && keys[0] === "enter") {
				const input = block.pendingInput ?? "";
				block.pendingInput = undefined;
				if (this.onEnter) this.onEnter(blockId, input, block);
				else if (input.trim().endsWith(".launch'")) this.runLauncher(block, input.trim().slice(1, -1));
				return OK;
			}
			const sent = this.keysByBlock.get(blockId) ?? [];
			sent.push(keys);
			this.keysByBlock.set(blockId, sent);
			this.onKeys?.(blockId, keys, block);
			return OK;
		}
		if (group === "capture") return { code: 0, stdout: block.captureText, stderr: "" };
		throw new Error(`FakeRex has no route for ${args.join(" ")}`);
	};

	private blockCall(block: FakeRexBlock, method: string): ExecResult {
		if (method === "size") return json({ columns: block.columns, rows: block.rows, owner: block.owner });
		if (method === "modes") {
			return json({
				screen: "alternate",
				modes: [{ name: "bracketed_paste", number: 2004, set: block.bracketedPaste }],
			});
		}
		if (method === "process") {
			return json({
				last_exit: null,
				foreground: { pid: block.pid, name: block.processName, cwd: block.cwd },
				ancestors: [],
			});
		}
		if (method === "program_status") {
			const records = block.piState
				? [
						{
							state: block.piState,
							app: "pi",
							effective_app: "pi",
							updated_at: block.updatedAt,
							owner: { pid: block.piPid ?? block.pid, name: "node" },
						},
					]
				: [];
			return json({ records });
		}
		return { code: 1, stdout: "", stderr: `Error: block has no method "${method}"` };
	}
}
