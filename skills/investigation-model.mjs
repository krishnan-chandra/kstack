#!/usr/bin/env node
/** Resolve an allowlisted small/fast investigation model from kstack.json. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;
const HEAVY_MODEL_RE = /(?:^|[-_/])(sol|fable|opus)(?:$|[-_/.])/i;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_MODELS = [
	{ model: "openai/gpt-5.6-luna", thinking: "low" },
	{ model: "openai/gpt-5.6-terra", thinking: "low" },
	{ model: "openrouter/z-ai/glm-5.2" },
	{ model: "openrouter/moonshotai/kimi-k3", thinking: "low" },
	{ model: "openrouter/google/gemini-3.5-flash-lite", thinking: "low" },
	{ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "low" },
];

function agentDir(env = process.env) {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

export function validateInvestigationConfig(raw) {
	if (raw === undefined) return { ok: true, config: { allowedModels: DEFAULT_MODELS, defaultModel: DEFAULT_MODELS[0].model }, source: "built-in defaults" };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: '"investigation" must be an object.' };
	}
	const { allowedModels, defaultModel } = raw;
	if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
		return { ok: false, error: '"investigation.allowedModels" must be a non-empty array.' };
	}
	const models = [];
	const seen = new Set();
	for (const entry of allowedModels) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof entry.model !== "string" || !MODEL_ID_RE.test(entry.model)) {
			return { ok: false, error: 'Each "investigation.allowedModels" entry must be {"model":"provider/model", "thinking"?}.' };
		}
		if (HEAVY_MODEL_RE.test(entry.model)) {
			return { ok: false, error: `"investigation.allowedModels" cannot contain heavyweight model ${entry.model}.` };
		}
		if (entry.thinking !== undefined && (typeof entry.thinking !== "string" || !THINKING_LEVELS.has(entry.thinking))) {
			return { ok: false, error: '"investigation.allowedModels[].thinking" must be a valid Pi thinking level.' };
		}
		if (seen.has(entry.model)) return { ok: false, error: `"investigation.allowedModels" contains ${entry.model} more than once.` };
		seen.add(entry.model);
		models.push({ model: entry.model, ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }) });
	}
	const selected = defaultModel === undefined ? models[0].model : defaultModel;
	if (typeof selected !== "string" || !seen.has(selected)) {
		return { ok: false, error: '"investigation.defaultModel" must name a model in "investigation.allowedModels".' };
	}
	return { ok: true, config: { allowedModels: models, defaultModel: selected }, source: "kstack.json" };
}

export function loadInvestigationConfig(env = process.env) {
	const path = join(agentDir(env), "kstack.json");
	if (!existsSync(path)) return validateInvestigationConfig(undefined);
	try {
		const root = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root)) return { ok: false, error: "kstack.json must be a JSON object." };
		return validateInvestigationConfig(root.investigation);
	} catch (error) {
		return { ok: false, error: `Cannot read ${path}: ${error.message}` };
	}
}

export function resolveInvestigationModel(requested, env = process.env) {
	const loaded = loadInvestigationConfig(env);
	if (!loaded.ok) return loaded;
	const model = requested ?? loaded.config.defaultModel;
	const allowed = loaded.config.allowedModels.find((entry) => entry.model === model);
	if (!allowed) {
		return { ok: false, error: `${model} is not in investigation.allowedModels. These skills only run allowlisted fast models.` };
	}
	return { ok: true, model, thinking: allowed.thinking, spec: allowed.thinking ? `${model}:${allowed.thinking}` : model, source: loaded.source };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const index = args.indexOf("--model");
	const requested = index === -1 ? undefined : args[index + 1];
	if (index !== -1 && !requested) {
		console.error("--model requires a provider/model value.");
		process.exit(2);
	}
	const result = resolveInvestigationModel(requested);
	if (!result.ok) {
		console.error(`kstack investigation model error: ${result.error}`);
		process.exit(2);
	}
	console.log(result.spec);
}
