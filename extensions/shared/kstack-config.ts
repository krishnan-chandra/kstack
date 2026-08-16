/** Shared base for sections of $PI_CODING_AGENT_DIR/kstack.json.
 *
 * Unlike the standalone installer, extension callers historically expanded
 * only `~/`; this shared path helper also handles a bare `~` consistently.
 * Session-archive remains separate because it resolves filesystem roots.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	return resolve(configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
}

export function getKstackPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "kstack.json");
}

type RawSectionLoad =
	| { status: "found"; value: unknown; path: string; root: Record<string, unknown> }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

type RawRootLoad =
	| { status: "found"; path: string; root: Record<string, unknown> }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

/** Load the whole kstack.json object for cross-section consumers such as model aliases. */
export function loadKstackRoot(env: NodeJS.ProcessEnv = process.env): RawRootLoad {
	const path = getKstackPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { status: "invalid", path, error: "kstack.json must be a JSON object." };
		}
		return { status: "found", path, root: raw as Record<string, unknown> };
	} catch (error) {
		return { status: "invalid", path, error: `Unreadable config: ${(error as Error).message}` };
	}
}

export function loadKstackSection(section: string, env: NodeJS.ProcessEnv = process.env): RawSectionLoad {
	const load = loadKstackRoot(env);
	if (load.status !== "found") return load;
	if (load.root[section] === undefined) return { status: "missing", path: load.path };
	return { status: "found", value: load.root[section], path: load.path, root: load.root };
}
