const MAX_SESSION_NAME_LENGTH = 80;

export interface SessionNamingApi {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
}

/** Build a compact, deterministic session name from a workflow's user task. */
export function deriveSessionName(task: string): string {
	const firstContentLine = task
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? "Development task";
	const normalized = firstContentLine
		.replace(/^(?:#{1,6}|[-*+]|>)\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	const value = normalized || "Development task";
	if (value.length <= MAX_SESSION_NAME_LENGTH) return value;

	const candidate = value.slice(0, MAX_SESSION_NAME_LENGTH - 1).trimEnd();
	const lastSpace = candidate.lastIndexOf(" ");
	const shortened = lastSpace >= 40 ? candidate.slice(0, lastSpace) : candidate;
	return `${shortened.trimEnd()}…`;
}

/** Name a workflow session once, preserving any explicit or earlier name. */
export function nameSessionIfUnnamed(api: SessionNamingApi, task: string): string | undefined {
	if (api.getSessionName()?.trim()) return undefined;
	const name = deriveSessionName(task);
	api.setSessionName(name);
	return name;
}
