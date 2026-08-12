/** Bounded parser for Pi's newline-delimited JSON event stream. */

import { StringDecoder } from "node:string_decoder";

export interface PiJsonEvent {
	type?: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	message?: {
		role?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: { type?: string; text?: string }[];
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
}

export interface JsonLineParserOptions {
	maxLineBytes?: number;
	onOverflow?: (maxLineBytes: number) => void;
}

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

export class JsonLineParser {
	private buffer = "";
	private bufferBytes = 0;
	private readonly decoder = new StringDecoder("utf8");
	private discardingOversizedLine = false;
	private readonly maxLineBytes: number;
	private readonly onEvent: (event: PiJsonEvent) => void;
	private readonly options: JsonLineParserOptions;

	constructor(onEvent: (event: PiJsonEvent) => void, options: JsonLineParserOptions = {}) {
		this.onEvent = onEvent;
		this.options = options;
		this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	}

	push(chunk: string | Buffer): void {
		const text = this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		let offset = 0;
		while (offset <= text.length) {
			const newline = text.indexOf("\n", offset);
			const complete = newline !== -1;
			this.append(text.slice(offset, complete ? newline : undefined));
			if (!complete) return;

			if (!this.discardingOversizedLine) this.process(this.buffer);
			this.buffer = "";
			this.bufferBytes = 0;
			this.discardingOversizedLine = false;
			offset = newline + 1;
			if (offset === text.length) return;
		}
	}

	flush(): void {
		const tail = this.decoder.end();
		if (tail) this.push(tail);
		if (!this.discardingOversizedLine && this.buffer.trim()) this.process(this.buffer);
		this.buffer = "";
		this.bufferBytes = 0;
		this.discardingOversizedLine = false;
	}

	private append(segment: string): void {
		if (this.discardingOversizedLine || !segment) return;
		const bytes = Buffer.byteLength(segment, "utf8");
		if (this.bufferBytes + bytes > this.maxLineBytes) {
			this.buffer = "";
			this.bufferBytes = 0;
			this.discardingOversizedLine = true;
			this.options.onOverflow?.(this.maxLineBytes);
			return;
		}
		this.buffer += segment;
		this.bufferBytes += bytes;
	}

	private process(line: string): void {
		if (!line.trim()) return;
		try {
			this.onEvent(JSON.parse(line) as PiJsonEvent);
		} catch {
			// Malformed child output is ignored; exit status and stderr provide diagnostics.
		}
	}
}
