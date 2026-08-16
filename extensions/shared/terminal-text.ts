/**
 * Terminal text helpers. In TUI mode callers inject pi-tui's
 * stripTerminalSequences/truncateToWidth; these fallbacks keep dashboard
 * modules importable and testable outside the Pi extension host.
 */
export interface TerminalText {
	stripTerminalSequences(text: string): string;
	truncateToWidth(text: string, width: number): string;
}

const ANSI_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const OSC_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
	/(?:\u001B[\]PX^_]|[\u0090\u0098\u009d-\u009f]).*?(?:\u0007|\u001B\\|\u009c|$)/gs;

export function stripTerminalSequencesFallback(input: string): string {
	return input.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

export function codePointWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (cp >= 0x0300 && cp <= 0x036f) return 0;
	if (cp < 0x1100) return 1;
	return cp <= 0x115f ||
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
		? 2
		: 1;
}

function fallbackTruncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let used = 0;
	for (const ch of text) {
		const charWidth = codePointWidth(ch.codePointAt(0) ?? 0);
		if (used + charWidth > width) {
			let output = "";
			let kept = 0;
			for (const candidate of text) {
				const candidateWidth = codePointWidth(candidate.codePointAt(0) ?? 0);
				if (kept + candidateWidth > width - 1) break;
				output += candidate;
				kept += candidateWidth;
			}
			return `${output}…`;
		}
		used += charWidth;
	}
	return text;
}

export const fallbackTerminalText: TerminalText = {
	stripTerminalSequences: stripTerminalSequencesFallback,
	truncateToWidth: fallbackTruncateToWidth,
};

export function sanitizeDisplayText(input: string, text: TerminalText = fallbackTerminalText): string {
	const stripped = text.stripTerminalSequences(input);
	return (
		stripped
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
			.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}
