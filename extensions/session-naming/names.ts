const MAX_SESSION_NAME_CHARS = 80;

const BOILERPLATE_LINES = new Set([
	"continue work from the previous pi session.",
	"continue work from the previous pi session",
]);

/** Build a compact default name without making a model call. */
export function suggestSessionName(prompt: string, sessionId?: string): string {
	const lines = prompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	const goalHeading = lines.findIndex((line) => /^#{1,6}\s+goal\s*$/i.test(line));
	const ordered = goalHeading >= 0 ? [...lines.slice(goalHeading + 1), ...lines.slice(0, goalHeading)] : lines;
	const candidate = ordered.find((line) => {
		const plain = cleanLine(line);
		return plain.length > 0 && !BOILERPLATE_LINES.has(plain.toLowerCase()) && !/^instructions\s*$/i.test(plain);
	});
	const fallback = sessionId ? `Session ${sessionId.slice(0, 8)}` : "Untitled session";
	return truncateName(candidate ? cleanLine(candidate) : fallback);
}

/** Normalize a user-entered name before persisting it. */
export function normalizeSessionName(value: string): string {
	return truncateName(value.replace(/\s+/g, " ").trim());
}

/** Name a handoff from its goal, or from the named parent for a default continuation. */
export function handoffSessionName(goal: string, defaultGoal: string, parentName?: string, sessionId?: string): string {
	if (goal.trim() === defaultGoal.trim() && parentName) {
		return truncateName(`${normalizeSessionName(parentName)} — continued`);
	}
	return suggestSessionName(goal, sessionId);
}

function cleanLine(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateName(value: string): string {
	const chars = Array.from(value);
	if (chars.length <= MAX_SESSION_NAME_CHARS) return value;
	return `${chars.slice(0, MAX_SESSION_NAME_CHARS - 1).join("")}…`;
}
