const MAX_SESSION_NAME_LENGTH = 48;

export interface SessionNamingApi {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
}

/** Build a short, deterministic slug from a workflow's user task. */
export function deriveSessionName(task: string): string {
	const firstContentLine = task
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? "development-task";
	const slug = firstContentLine
		.replace(/^(?:#{1,6}|[-*+]|>)\s+/, "")
		.normalize("NFKD")
		.toLowerCase()
		.replace(/\p{Mark}+/gu, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return "development-task";
	if (slug.length <= MAX_SESSION_NAME_LENGTH) return slug;
	const candidate = slug.slice(0, MAX_SESSION_NAME_LENGTH).replace(/-+$/g, "");
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
