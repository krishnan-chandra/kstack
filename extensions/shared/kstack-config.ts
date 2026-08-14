/** Shared base for sections of $PI_CODING_AGENT_DIR/kstack.json.
 *
 * Unlike the standalone installer, extension callers historically expanded
 * only `~/`; this shared path helper also handles a bare `~` consistently.
 * Session-archive remains separate because it resolves filesystem roots.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

export function getKstackPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "kstack.json");
}

export type SectionLoad<T> =
	| { status: "loaded"; config: T; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export type RawSectionLoad =
	| { status: "found"; value: unknown; path: string; root: Record<string, unknown> }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export function loadKstackSection(section: string, env: NodeJS.ProcessEnv = process.env): RawSectionLoad {
	const path = getKstackPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { status: "invalid", path, error: "kstack.json must be a JSON object." };
		}
		const root = raw as Record<string, unknown>;
		if (root[section] === undefined) return { status: "missing", path };
		return { status: "found", value: root[section], path, root };
	} catch (error) {
		return { status: "invalid", path, error: `Unreadable config: ${(error as Error).message}` };
	}
}
