#!/usr/bin/env node
/** Resolve an allowlisted small/fast investigation model from kstack.json. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;
const INVESTIGATION_THINKING_LEVELS = new Set(["medium", "high", "xhigh", "max"]);
const FAST_MODELS = [
	{ model: "openai/gpt-5.6-luna", thinking: "medium" },
	{ model: "openai/gpt-5.6-terra", thinking: "medium" },
	{ model: "openrouter/z-ai/glm-5.2", thinking: "medium" },
	{ model: "openrouter/deepseek/deepseek-v4-pro", thinking: "medium" },
	{ model: "openrouter/google/gemini-3.5-flash-lite", thinking: "medium" },
	{ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "medium" },
];
const FAST_MODEL_IDS = new Set(FAST_MODELS.map(({ model }) => model));

function agentDir(env = process.env) {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

export function validateInvestigationConfig(raw) {
	if (raw === undefined) return { ok: true, config: { allowedModels: FAST_MODELS, defaultModel: FAST_MODELS[0].model }, source: "built-in defaults" };
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
		if (!FAST_MODEL_IDS.has(entry.model)) {
			return { ok: false, error: `"investigation.allowedModels" can contain only kstack's fast investigation models; ${entry.model} is unsupported.` };
		}
		if (typeof entry.thinking !== "string" || !INVESTIGATION_THINKING_LEVELS.has(entry.thinking)) {
			return { ok: false, error: '"investigation.allowedModels[].thinking" must be medium, high, xhigh, or max.' };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
