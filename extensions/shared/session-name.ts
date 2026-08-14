const MAX_SESSION_NAME_LENGTH = 48;

interface SessionNamingApi {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
}

/** Build a short, deterministic slug from a workflow's user task. */
export function deriveSessionName(task: string): string {
	const firstContentLine =
		task
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "development-task";
	const slug = firstContentLine
		.replace(/^(?:#{1,6}|[-*+]|>)\s+/, "")
		.normalize("NFKD")
		.replace(/(\p{Script=Latin})\p{Mark}+/gu, "$1")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}\p{Mark}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.normalize("NFC");
	if (!slug) return "development-task";
	const characters = [...slug];
	if (characters.length <= MAX_SESSION_NAME_LENGTH) return slug;
	const candidate = characters.slice(0, MAX_SESSION_NAME_LENGTH).join("").replace(/-+$/g, "");
	const boundary = candidate.lastIndexOf("-");
	return boundary >= MAX_SESSION_NAME_LENGTH / 2 ? candidate.slice(0, boundary) : candidate;
}

/** Name a workflow session once, preserving any explicit or earlier name. */
export function nameSessionIfUnnamed(api: SessionNamingApi, task: string): string | undefined {
	if (api.getSessionName()?.trim()) return undefined;
	const name = deriveSessionName(task);
	api.setSessionName(name);
	return name;
}
