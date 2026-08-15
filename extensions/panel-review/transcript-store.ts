/**
 * In-memory transcript store for panel-review child agents.
 *
 * Captures bounded, structured execution events per child: tool calls with
 * durations, final assistant text per turn, turn boundaries with usage,
 * and lifecycle notes.
 *
 * Ephemeral only — nothing here is written to the session or disk.
 */

import { type ChildEvent, type ChildUsage, truncateHeadUtf8, truncateTailUtf8 } from "../shared/child-agent-runner.ts";

type TranscriptEntry =
	| { kind: "note"; text: string; at: number }
	| { kind: "tool"; summary: string; durationMs?: number; at: number }
	| { kind: "text"; text: string; turn: number; at: number }
	| { kind: "turn"; turn: number; usage: ChildUsage; at: number };

export const MAX_CHILD_TRANSCRIPT_BYTES = 128 * 1024; // 128 KiB
export const MAX_CHILD_ENTRIES = 1000;
export const MAX_ENTRY_TEXT_BYTES = 8 * 1024; // 8 KiB
export const EVICTION_NOTICE = "… earlier transcript dropped (cap 128 KiB)";

function getEntryByteLength(entry: TranscriptEntry): number {
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
	id: string;
	entries: TranscriptEntry[];
	liveTail: string | undefined;
	entriesBytes: number;
	evicted: boolean;
}

function childTotalBytes(state: ChildTranscriptState): number {
	const tailBytes = state.liveTail ? Buffer.byteLength(state.liveTail, "utf8") : 0;
	return state.entriesBytes + tailBytes;
}

export class PanelTranscriptStore {
	private readonly children = new Map<string, ChildTranscriptState>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly throttleMs: number;
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(now: () => number = () => Date.now(), throttleMs = 80) {
		this.now = now;
		this.throttleMs = throttleMs;
	}

	nowMs(): number {
		return this.now();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	/** Flush any pending throttled emission immediately. */
	flush(): void {
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
			this.emit();
		}
	}

	dispose(): void {
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.listeners.clear();
	}

	addChild(id: string): void {
		if (this.children.has(id)) return;
		this.children.set(id, {
			id,
			entries: [],
			liveTail: undefined,
			entriesBytes: 0,
			evicted: false,
		});
		this.flushAndEmit();
	}

	private flushAndEmit(): void {
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.emit();
	}

	private enforceLimits(state: ChildTranscriptState): void {
		while (
			state.entries.length > 0 &&
			(childTotalBytes(state) > MAX_CHILD_TRANSCRIPT_BYTES || state.entries.length > MAX_CHILD_ENTRIES)
		) {
			const removed = state.entries.shift()!;
			state.entriesBytes -= getEntryByteLength(removed);
			state.evicted = true;
		}
	}

	private addEntry(state: ChildTranscriptState, entry: TranscriptEntry): void {
		state.entries.push(entry);
		state.entriesBytes += getEntryByteLength(entry);
		this.enforceLimits(state);
	}

	note(id: string, text: string): void {
		const state = this.children.get(id);
		if (!state) return;
		const entry: TranscriptEntry = {
			kind: "note",
			text: truncateHeadUtf8(text, MAX_ENTRY_TEXT_BYTES),
			at: this.now(),
		};
		this.addEntry(state, entry);
		this.flushAndEmit();
	}

	push(id: string, event: ChildEvent): void {
		const state = this.children.get(id);
		if (!state) return;

		switch (event.kind) {
			case "text_delta": {
				const current = state.liveTail ?? "";
				state.liveTail = truncateTailUtf8(current + event.delta, MAX_ENTRY_TEXT_BYTES);
				this.enforceLimits(state);
				if (this.throttleMs <= 0) {
					this.emit();
				} else if (!this.throttleTimer) {
					this.throttleTimer = setTimeout(() => {
						this.throttleTimer = undefined;
						this.emit();
					}, this.throttleMs);
					this.throttleTimer.unref?.();
				}
				break;
			}
			case "tool_start": {
				const entry: TranscriptEntry = {
					kind: "tool",
					summary: event.summary,
					at: event.at,
				};
				this.addEntry(state, entry);
				this.flushAndEmit();
				break;
			}
			case "tool_end": {
				const last = state.entries.at(-1);
				if (last && last.kind === "tool" && last.durationMs === undefined) {
					last.durationMs = event.durationMs;
					this.flushAndEmit();
				}
				break;
			}
			case "turn_end": {
				const safeText = event.text ? truncateHeadUtf8(event.text, MAX_ENTRY_TEXT_BYTES) : "";
				if (safeText) {
					this.addEntry(state, {
						kind: "text",
						text: safeText,
						turn: event.turn,
						at: event.at,
					});
				}
				this.addEntry(state, {
					kind: "turn",
					turn: event.turn,
					usage: event.usage,
					at: event.at,
				});
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

	wasEvicted(id: string): boolean {
		return this.children.get(id)?.evicted ?? false;
	}
}
