import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "./validation.ts";
/** Shared base for sections of $PI_CODING_AGENT_DIR/kstack.json.
 *
 * Unlike the standalone installer, extension callers historically expanded
 * only `~/`; this shared path helper also handles a bare `~` consistently.
 * Session-archive remains separate because it resolves filesystem roots.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type { ModelThinkingLevel };
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];
/** Compile-time completeness check for Pi's model-thinking vocabulary. */
type MissingLevel = Exclude<ModelThinkingLevel, (typeof THINKING_LEVELS)[number]>;
type ThinkingLevelsComplete = [MissingLevel] extends [never] ? true : never;
const thinkingLevelsComplete: ThinkingLevelsComplete = true;
void thinkingLevelsComplete;
export const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;

export type PlanAdversaryModel = string | { model: string; thinking?: ModelThinkingLevel };

/* exported: shared configuration contract for plan-implement and the adversarial-planning CLI */
export interface PlanAdversaryConfig {
	adversary: PlanAdversaryModel;
	maxRounds: number;
	timeoutMinutes: number;
}

export function isThinkingLevel(value: BoundaryValue): value is ModelThinkingLevel {
	return (
		isString(value) &&
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
			THINKING_LEVELS as readonly string[]
		).includes(value)
	);
}

function validatePlanAdversaryModel(
	value: BoundaryValue,
): { ok: true; model: PlanAdversaryModel } | { ok: false; error: string } {
	if (isString(value)) {
		if (!/^[A-Za-z0-9_-]{1,16}$/.test(value)) {
			return {
				ok: false,
				error: "plan-adversary.adversary alias must use 1–16 letters, digits, underscores, or hyphens.",
			};
		}
		return { ok: true, model: value };
	}
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: "plan-adversary.adversary must be a model object or alias string." };
	}
	// SAFETY: the object guard above establishes a string-keyed config record.
	const record = value as JsonObject;
	if (!isString(record.model) || !MODEL_ID_RE.test(record.model)) {
		return { ok: false, error: "plan-adversary.adversary.model must be provider/model." };
	}
	if (record.thinking !== undefined && !isThinkingLevel(record.thinking)) {
		return { ok: false, error: "plan-adversary.adversary.thinking is not a supported thinking level." };
	}
	const model: Exclude<PlanAdversaryModel, string> = { model: record.model };
	if (isThinkingLevel(record.thinking)) model.thinking = record.thinking;
	return { ok: true, model };
}

/** Validate the shared adversarial-planning settings once for the skill CLI and plan-implement. */
export function validatePlanAdversaryConfig(
	value: BoundaryValue,
): { ok: true; config: PlanAdversaryConfig } | { ok: false; error: string } {
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: "plan-adversary must be an object." };
	}
	// SAFETY: the object guard above establishes a string-keyed config record.
	const record = value as JsonObject;
	const adversary = validatePlanAdversaryModel(record.adversary);
	if (!adversary.ok) return adversary;
	const maxRounds = record.maxRounds ?? 3;
	if (!isNumber(maxRounds) || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) {
		return { ok: false, error: "plan-adversary.maxRounds must be an integer from 1 to 5." };
	}
	const timeoutMinutes = record.timeoutMinutes ?? 15;
	if (!isNumber(timeoutMinutes) || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
		return { ok: false, error: "plan-adversary.timeoutMinutes must be an integer from 1 to 60." };
	}
	return { ok: true, config: { adversary: adversary.model, maxRounds, timeoutMinutes } };
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
	| { status: "found"; value: BoundaryValue; path: string; root: JsonObject }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export type ConfigLoad<T> =
	| { status: "loaded"; config: T; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

type RawRootLoad =
	| { status: "found"; path: string; root: JsonObject }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

/** Load the whole kstack.json object for cross-section consumers such as model aliases. */
export function loadKstackRoot(env: NodeJS.ProcessEnv = process.env): RawRootLoad {
	const path = getKstackPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const raw: BoundaryValue = JSON.parse(readFileSync(path, "utf8"));
		if (!isObject(raw) || raw === null || Array.isArray(raw)) {
			return { status: "invalid", path, error: "kstack.json must be a JSON object." };
		}
		return {
			status: "found",
			path,
			root: /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject,
		};
	} catch (error) {
		return {
			status: "invalid",
			path,
			error: `Unreadable config: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error).message}`,
		};
	}
}

export function loadKstackSection(section: string, env: NodeJS.ProcessEnv = process.env): RawSectionLoad {
	const load = loadKstackRoot(env);
	if (load.status !== "found") return load;
	if (load.root[section] === undefined) return { status: "missing", path: load.path };
	return { status: "found", value: load.root[section], path: load.path, root: load.root };
}

/** Load and validate one extension section from kstack.json. */
export function loadValidatedSection<T>(
	section: string,
	validate: (value: BoundaryValue) => { ok: true; config: T } | { ok: false; error: string },
	env: NodeJS.ProcessEnv = process.env,
): ConfigLoad<T> {
	const raw = loadKstackSection(section, env);
	if (raw.status !== "found") return raw;
	const result = validate(raw.value);
	return result.ok
		? { status: "loaded", config: result.config, path: raw.path }
		: { status: "invalid", path: raw.path, error: result.error };
}
