/** Router configuration from kstack.json. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type RouterConfig } from "./types.ts";

export type ConfigLoad =
	| { status: "loaded"; config: RouterConfig; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

export function getKstackPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "kstack.json");
}

const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function validateRouterConfig(raw: unknown): { ok: true; config: RouterConfig } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "kstack-router config must be a JSON object." };
	}

	const obj = raw as Record<string, unknown>;
	const config: RouterConfig = {};

	if (obj.classifier !== undefined) {
		if (typeof obj.classifier !== "object" || obj.classifier === null || Array.isArray(obj.classifier)) {
			return { ok: false, error: '"kstack-router.classifier" must be an object {"model": "...", "thinking"?}.' };
		}
		const classifier = obj.classifier as Record<string, unknown>;
		if (typeof classifier.model !== "string" || !MODEL_ID_RE.test(classifier.model)) {
			return { ok: false, error: `"kstack-router.classifier.model" must be "provider/model", got ${JSON.stringify(classifier.model)}.` };
		}
		const thinking = classifier.thinking as string | undefined;
		if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
			return { ok: false, error: `"kstack-router.classifier.thinking" must be one of ${THINKING_LEVELS.join(", ")}.` };
		}
		config.classifier = { model: classifier.model, thinking };
	}

	if (obj.timeoutSeconds !== undefined) {
		if (typeof obj.timeoutSeconds !== "number" || !Number.isFinite(obj.timeoutSeconds) || obj.timeoutSeconds < 1 || obj.timeoutSeconds > 600) {
			return { ok: false, error: '"kstack-router.timeoutSeconds" must be a number between 1 and 600.' };
		}
		config.timeoutSeconds = obj.timeoutSeconds;
	}

	return { ok: true, config };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	const path = getKstackPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const root = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root)) {
			return { status: "invalid", path, error: "kstack.json must be a JSON object." };
		}
		const section = (root as Record<string, unknown>)["kstack-router"];
		if (section === undefined) return { status: "missing", path };
		const result = validateRouterConfig(section);
		return result.ok
			? { status: "loaded", config: result.config, path }
			: { status: "invalid", path, error: result.error };
	} catch (err) {
		return { status: "invalid", path, error: `Unreadable config: ${(err as Error).message}` };
	}
}

export interface ClassifierModelResolution {
	modelId: string;
	source: "config" | "default" | "active";
	/** Configured thinking level for the classifier child, if any. */
	thinking?: string;
	warning?: string;
}

export interface ResolveDeps {
	available: (provider: string, modelId: string) => boolean;
	activeModelId?: string;
}

export function resolveClassifierModel(
	config: RouterConfig | null,
	deps: ResolveDeps,
): ClassifierModelResolution | { ok: false; error: string } {
	if (config?.classifier) {
		const slash = config.classifier.model.indexOf("/");
		if (!deps.available(config.classifier.model.slice(0, slash), config.classifier.model.slice(slash + 1))) {
			return { ok: false, error: `Configured classifier model is unavailable: ${config.classifier.model}.` };
		}
		return { modelId: config.classifier.model, source: "config", thinking: config.classifier.thinking };
	}

	// Try default.
	const defaultModel = DEFAULTS.classifierModel;
	const slash = defaultModel.indexOf("/");
	if (deps.available(defaultModel.slice(0, slash), defaultModel.slice(slash + 1))) {
		return { modelId: defaultModel, source: "default", thinking: DEFAULTS.classifierThinking };
	}

	// Fall back to active model.
	if (deps.activeModelId) {
		return {
			modelId: deps.activeModelId,
			source: "active",
			warning: `Default classifier model (${defaultModel}) unavailable; using the active model instead. Classification latency and cost may be higher.`,
		};
	}

	return { ok: false, error: "No model available for routing classification." };
}
