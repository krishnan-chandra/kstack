import { extractSlug } from "./slug.ts";

interface SessionNamingApi {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
}

/** Build the shared short slug from a workflow's user task. */
export function deriveSessionName(task: string): string {
	return extractSlug(task, "development-task");
}

/** Name a workflow session once, preserving any explicit or earlier name. */
export function nameSessionIfUnnamed(api: SessionNamingApi, task: string): string | undefined {
	if (api.getSessionName()?.trim()) return undefined;
	const name = deriveSessionName(task);
	api.setSessionName(name);
	return name;
}
