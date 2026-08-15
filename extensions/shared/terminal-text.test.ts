import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codePointWidth,
	fallbackTerminalText,
	sanitizeDisplayText,
	stripTerminalSequencesFallback,
} from "./terminal-text.ts";

const ESC = "\u001b";
const BEL = "\u0007";

describe("terminal text", () => {
	it("strips ANSI, OSC, APC, and control characters", () => {
		assert.equal(sanitizeDisplayText(`${ESC}[31mred${ESC}[0m`), "red");
		assert.equal(sanitizeDisplayText(`${ESC}]8;;http://evil${BEL}link${ESC}]8;;${BEL}`), "link");
		assert.equal(sanitizeDisplayText(`before ${ESC}_payload${ESC}\\ after`), "before after");
		assert.equal(sanitizeDisplayText("a\x01b\x07c\x08d\x1fe"), "a b c d e");
		assert.equal(stripTerminalSequencesFallback(`${ESC}[2Jtext`), "text");
	});

	it("collapses whitespace and preserves Unicode", () => {
		assert.equal(sanitizeDisplayText("héllo\n  語\t🤖"), "héllo 語 🤖");
	});

	it("truncates to terminal cell width", () => {
		assert.equal(codePointWidth("a".codePointAt(0) ?? 0), 1);
		assert.equal(codePointWidth("語".codePointAt(0) ?? 0), 2);
		assert.equal(fallbackTerminalText.truncateToWidth("a語b", 3), "a…");
	});
});
