import { type ChildEvent, type ChildUsage, truncateHeadUtf8, truncateTailUtf8 } from "./child-agent-runner.ts";

export type TranscriptEntry =
	| { kind: "note"; text: string; at: number }
	| { kind: "tool"; summary: string; durationMs?: number; at: number }
	| { kind: "text"; text: string; turn: number; at: number }
	| { kind: "turn"; turn: number; usage: ChildUsage; at: number };

export const MAX_CHILD_TRANSCRIPT_BYTES = 128 * 1024;
export const MAX_CHILD_ENTRIES = 1000;
export const MAX_ENTRY_TEXT_BYTES = 8 * 1024;
export const EVICTION_NOTICE = "… earlier transcript dropped (cap 128 KiB)";

function entryBytes(entry: TranscriptEntry): number {
	switch (entry.kind) {
		case "text":
		case "note":
			return Buffer.byteLength(entry.text, "utf8");
		case "tool":
			return Buffer.byteLength(entry.summary, "utf8");
		case "turn":
			return 64;
	}
}

interface ChildTranscriptState {
	entries: TranscriptEntry[];
	liveTail: string | undefined;
	entriesBytes: number;
	totalCost: number;
	evicted: boolean;
}

function totalBytes(state: ChildTranscriptState): number {
	return state.entriesBytes + (state.liveTail ? Buffer.byteLength(state.liveTail, "utf8") : 0);
}

/** Bounded ephemeral transcript storage shared by child-agent workflows. */
export class ChildTranscriptStore {
	private readonly children = new Map<string, ChildTranscriptState>();
	private readonly listeners = new Set<() => void>();
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly now: () => number;
	private readonly throttleMs: number;

	constructor(now: () => number = () => Date.now(), throttleMs = 80) {
		this.now = now;
		this.throttleMs = throttleMs;
	}

	nowMs(): number {
		return this.now();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	flush(): void {
		if (!this.throttleTimer) return;
		clearTimeout(this.throttleTimer);
		this.throttleTimer = undefined;
		this.emit();
	}

	dispose(): void {
		if (this.throttleTimer) clearTimeout(this.throttleTimer);
		this.throttleTimer = undefined;
		this.listeners.clear();
	}

	addChild(id: string): void {
		if (this.children.has(id)) return;
		this.children.set(id, { entries: [], liveTail: undefined, entriesBytes: 0, totalCost: 0, evicted: false });
		this.flushAndEmit();
	}

	private flushAndEmit(): void {
		if (this.throttleTimer) clearTimeout(this.throttleTimer);
		this.throttleTimer = undefined;
		this.emit();
	}

	private enforceLimits(state: ChildTranscriptState): void {
		// Preserve the live streaming tail and evict the oldest finalized entries first.
		while (
			state.entries.length > 0 &&
			(totalBytes(state) > MAX_CHILD_TRANSCRIPT_BYTES || state.entries.length > MAX_CHILD_ENTRIES)
		) {
			const removed = state.entries.shift();
			if (!removed) break;
			state.entriesBytes -= entryBytes(removed);
			state.evicted = true;
		}
	}

	private addEntry(state: ChildTranscriptState, entry: TranscriptEntry): void {
		state.entries.push(entry);
		state.entriesBytes += entryBytes(entry);
		this.enforceLimits(state);
	}

	note(id: string, text: string): void {
		const state = this.children.get(id);
		if (!state) return;
		this.addEntry(state, { kind: "note", text: truncateHeadUtf8(text, MAX_ENTRY_TEXT_BYTES), at: this.now() });
		this.flushAndEmit();
	}

	push(id: string, event: ChildEvent): void {
		const state = this.children.get(id);
		if (!state) return;
		switch (event.kind) {
			case "text_delta":
				state.liveTail = truncateTailUtf8((state.liveTail ?? "") + event.delta, MAX_ENTRY_TEXT_BYTES);
				this.enforceLimits(state);
				if (this.throttleMs <= 0) this.emit();
				else if (!this.throttleTimer) {
					this.throttleTimer = setTimeout(() => {
						this.throttleTimer = undefined;
						this.emit();
					}, this.throttleMs);
					this.throttleTimer.unref?.();
				}
				break;
			case "tool_start":
				this.addEntry(state, { kind: "tool", summary: event.summary, at: event.at });
				this.flushAndEmit();
				break;
			case "tool_end": {
				const last = state.entries.at(-1);
				if (last?.kind === "tool" && last.durationMs === undefined) {
					last.durationMs = event.durationMs;
					this.flushAndEmit();
				}
				break;
			}
			case "turn_end": {
				const text = event.text ? truncateHeadUtf8(event.text, MAX_ENTRY_TEXT_BYTES) : "";
				if (text) this.addEntry(state, { kind: "text", text, turn: event.turn, at: event.at });
				this.addEntry(state, { kind: "turn", turn: event.turn, usage: event.usage, at: event.at });
				state.totalCost += event.usage.cost;
				state.liveTail = undefined;
				this.flushAndEmit();
				break;
			}
		}
	}

	getEntries(id: string): readonly TranscriptEntry[] {
		return this.children.get(id)?.entries ?? [];
	}

	getLiveTail(id: string): string | undefined {
		return this.children.get(id)?.liveTail;
	}

	getTotalCost(id: string): number {
		return this.children.get(id)?.totalCost ?? 0;
	}

	wasEvicted(id: string): boolean {
		return this.children.get(id)?.evicted ?? false;
	}
}
