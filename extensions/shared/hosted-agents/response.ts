import { open } from "node:fs/promises";
import { truncateHeadUtf8 } from "../child-agent-runner.ts";
import { isObject, isString } from "../validation.ts";

const MAX_SESSION_TAIL_BYTES = 32 * 1024 * 1024;

/** Native Pi assistant text is the response channel, not permission to write a file. */
export function responseMarker(requestId: string): string {
	return `KSTACK_RESPONSE ${requestId}`;
}

/** Read only a bounded tail appended during this request. Never accept screen text or a partial file. */
export async function readResponse(file: string, offset: number, requestId: string, cap: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const size = (await handle.stat()).size;
		if (size < offset) throw new Error("Hosted session was truncated during the request.");
		const start = Math.max(offset, size - MAX_SESSION_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8", 0, bytesRead);
		if (start > offset) text = text.slice(text.indexOf("\n") + 1);
		if (!text.endsWith("\n")) throw new Error("Hosted session has an incomplete terminal entry.");
		let terminal: unknown;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const entry: unknown = JSON.parse(line);
			if (isObject(entry) && entry !== null && "type" in entry && entry.type === "message" && "message" in entry) {
				terminal = entry.message;
			}
		}
		if (
			!isObject(terminal) ||
			terminal === null ||
			!("role" in terminal) ||
			terminal.role !== "assistant" ||
			!("stopReason" in terminal) ||
			terminal.stopReason !== "stop"
		) {
			throw new Error("Hosted request has no successful terminal assistant response.");
		}
		if (!("content" in terminal) || !Array.isArray(terminal.content))
			throw new Error("Malformed hosted response content.");
		const parts: string[] = [];
		for (const block of terminal.content) {
			if (
				isObject(block) &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				isString(block.text)
			)
				parts.push(block.text);
		}
		const response = parts.join("");
		const prefix = `${responseMarker(requestId)}\n`;
		if (!response.startsWith(prefix) || !response.slice(prefix.length).trim())
			throw new Error("Hosted response is missing the request acknowledgement or answer.");
		return truncateHeadUtf8(response.slice(prefix.length), cap);
	} finally {
		await handle.close();
	}
}
