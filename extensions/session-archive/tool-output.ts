export function splitUtf8Chunks(text: string, maxBytes: number): string[] {
	if (!Number.isInteger(maxBytes) || maxBytes < 4) {
		throw new Error("maxBytes must be an integer of at least 4");
	}
	if (text.length === 0) return [""];
	const chunks: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const character of text) {
		const bytes = Buffer.byteLength(character);
		if (currentBytes + bytes > maxBytes && current.length > 0) {
			chunks.push(current);
			current = "";
			currentBytes = 0;
		}
		current += character;
		currentBytes += bytes;
	}
	chunks.push(current);
	return chunks;
}
