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

export type AdversaryModel = string | { model: string; thinking?: ModelThinkingLevel };

/* exported: shared configuration contract for plan-implement and the adversarial-planning CLI */
export interface AdversaryConfig {
	/** One or more adversaries, in configured order. */
	adversaries: AdversaryModel[];
	/** Planning debate rounds. */
	maxRounds: number;
	/** Wall-clock limit for one planning-round critique. */
	timeoutMinutes: number;
	/** Shared deadline for the implementation review fan-out. */
	reviewTimeoutMinutes: number;
}

/** Built-in adversary when the `adversary` section omits an explicit model. */
const DEFAULT_ADVERSARY: AdversaryModel = { model: "openai/gpt-6-astra", thinking: "xhigh" };

/** Maximum number of configured adversaries. */
const MAX_ADVERSARIES = 5;

export function isThinkingLevel(value: BoundaryValue): value is ModelThinkingLevel {
	return (
		isString(value) &&
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
			THINKING_LEVELS as readonly string[]
		).includes(value)
	);
}

function validateAdversaryModel(
	value: BoundaryValue,
	where: string,
): { ok: true; model: AdversaryModel } | { ok: false; error: string } {
	if (isString(value)) {
		if (!/^[A-Za-z0-9_-]{1,16}$/.test(value)) {
			return {
				ok: false,
				error: `${where} alias must use 1–16 letters, digits, underscores, or hyphens.`,
			};
		}
		return { ok: true, model: value };
	}
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: `${where} must be a model object or alias string.` };
	}
	// SAFETY: the object guard above establishes a string-keyed config record.
	const record = value as JsonObject;
	if (!isString(record.model) || !MODEL_ID_RE.test(record.model)) {
		return { ok: false, error: `${where}.model must be provider/model.` };
	}
	if (record.thinking !== undefined && !isThinkingLevel(record.thinking)) {
		return { ok: false, error: `${where}.thinking is not a supported thinking level.` };
	}
	const model: Exclude<AdversaryModel, string> = { model: record.model };
	if (isThinkingLevel(record.thinking)) model.thinking = record.thinking;
	return { ok: true, model };
}

/**
 * Validate the shared adversary settings once for the skill CLI and
 * plan-implement. `adversary` accepts one model or an array of models; an
 * omitted model falls back to {@link DEFAULT_ADVERSARY}.
 */
export function validateAdversaryConfig(
	value: BoundaryValue,
): { ok: true; config: AdversaryConfig } | { ok: false; error: string } {
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: "adversary must be an object." };
	}
	// SAFETY: the object guard above establishes a string-keyed config record.
	const record = value as JsonObject;
	const raw = record.adversary;
	const entries = raw === undefined ? [DEFAULT_ADVERSARY] : Array.isArray(raw) ? raw : [raw];
	if (entries.length < 1 || entries.length > MAX_ADVERSARIES) {
		return { ok: false, error: `adversary.adversary must contain 1 to ${MAX_ADVERSARIES} entries.` };
	}
	const adversaries: AdversaryModel[] = [];
	for (let index = 0; index < entries.length; index++) {
		const where = entries.length === 1 ? "adversary.adversary" : `adversary.adversary[${index}]`;
		const model = validateAdversaryModel(entries[index], where);
		if (!model.ok) return model;
		adversaries.push(model.model);
	}
	const maxRounds = record.maxRounds ?? 3;
	if (!isNumber(maxRounds) || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) {
		return { ok: false, error: "adversary.maxRounds must be an integer from 1 to 5." };
	}
	const timeoutMinutes = record.timeoutMinutes ?? 15;
	if (!isNumber(timeoutMinutes) || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
		return { ok: false, error: "adversary.timeoutMinutes must be an integer from 1 to 60." };
	}
	const reviewTimeoutMinutes = record.reviewTimeoutMinutes ?? 10;
	if (
		!isNumber(reviewTimeoutMinutes) ||
		!Number.isInteger(reviewTimeoutMinutes) ||
		reviewTimeoutMinutes < 1 ||
		reviewTimeoutMinutes > 60
	) {
		return { ok: false, error: "adversary.reviewTimeoutMinutes must be an integer from 1 to 60." };
	}
	return { ok: true, config: { adversaries, maxRounds, timeoutMinutes, reviewTimeoutMinutes } };
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
