/** Resolve route-specific post-PR options through deterministic UI, not the classifier. */

import type { MergeMethod, ReadinessMode } from "../land/types.ts";
import type { AutopilotMode } from "../pr-autopilot/types.ts";
import type { RouteId, RouterArgs } from "./types.ts";

export type PostPrRequest =
	| { route: "pr-autopilot"; mode: AutopilotMode; prNumber?: number }
	| { route: "land"; prNumber: number; readiness: ReadinessMode; method?: MergeMethod };

type PostPrResolution = { ok: true; request?: PostPrRequest } | { cancelled: true } | { failed: string };

export interface PostPrEffects {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	isSessionCurrent(): boolean;
}

const AUTOPILOT_MODE_CHOICES: ReadonlyArray<{ label: string; value: AutopilotMode }> = [
	{ label: "check — one status pass, no mutation", value: "check" },
	{ label: "threads — address review threads once", value: "threads" },
	{ label: "drive — loop until merge-ready (3 cycles)", value: "drive" },
	{ label: "watch — drive with longer CI waits", value: "watch" },
	{ label: "cleanup — remove a managed worktree", value: "cleanup" },
];

const READINESS_CHOICES: ReadonlyArray<{ label: string; value: ReadinessMode }> = [
	{ label: "check — one readiness pass, then confirm", value: "check" },
	{ label: "watch — let autopilot address blockers first", value: "watch" },
];

function lookupChoice<T extends string>(
	choices: ReadonlyArray<{ label: string; value: T }>,
	selected: string,
): T | undefined {
	return choices.find((choice) => choice.label === selected)?.value;
}

function inapplicableImplementationFlags(args: RouterArgs): string | undefined {
	if (args.delivery) return "--single/--stack is only valid with implementation routes.";
	if (args.worktree) return "--worktree is only valid with the change or fast-change routes.";
	if (args.changeKind) return "--change-kind is only valid with the change or fast-change routes.";
	return undefined;
}

function inapplicablePostPrFlags(args: RouterArgs): string | undefined {
	if (args.autopilotMode) return "--mode is only valid with the pr-autopilot route.";
	if (args.prNumber !== undefined) return "--pr is only valid with the pr-autopilot or land routes.";
	if (args.landMethod) return "--method is only valid with the land route.";
	if (args.readiness) return "--readiness is only valid with the land route.";
	return undefined;
}

function parsePositivePr(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) ? value : undefined;
}

async function live(fx: PostPrEffects): Promise<PostPrResolution | undefined> {
	return fx.isSessionCurrent() ? undefined : { cancelled: true };
}

export async function resolvePostPrOptions(
	route: RouteId,
	args: RouterArgs,
	fx: PostPrEffects,
): Promise<PostPrResolution> {
	if (route !== "pr-autopilot" && route !== "land") {
		const error = inapplicablePostPrFlags(args);
		return error ? { failed: error } : { ok: true };
	}

	const implementationError = inapplicableImplementationFlags(args);
	if (implementationError) return { failed: implementationError };
	if (route === "pr-autopilot" && (args.landMethod || args.readiness)) {
		return { failed: "--method and --readiness are only valid with the land route." };
	}
	if (route === "land" && args.autopilotMode) {
		return { failed: "--mode is only valid with the pr-autopilot route." };
	}

	const stale = await live(fx);
	if (stale) return stale;

	if (route === "pr-autopilot") return resolveAutopilot(args, fx);
	return resolveLand(args, fx);
}

async function resolveAutopilot(args: RouterArgs, fx: PostPrEffects): Promise<PostPrResolution> {
	let mode = args.autopilotMode;
	if (!mode) {
		const selected = await fx.select(
			"PR autopilot mode:",
			AUTOPILOT_MODE_CHOICES.map((choice) => choice.label),
		);
		const stale = await live(fx);
		if (stale) return stale;
		if (!selected) return { cancelled: true };
		mode = lookupChoice(AUTOPILOT_MODE_CHOICES, selected);
		if (!mode) return { failed: "Unrecognized autopilot mode selection." };
	}

	let prNumber = args.prNumber;
	if (prNumber === undefined) {
		const raw = await fx.input("PR number (blank = lowest unmerged):", "");
		const stale = await live(fx);
		if (stale) return stale;
		if (raw === undefined) return { cancelled: true };
		if (raw.trim() !== "") {
			prNumber = parsePositivePr(raw);
			if (prNumber === undefined) return { failed: "PR number must be a positive integer." };
		}
	}

	const stale = await live(fx);
	if (stale) return stale;
	return { ok: true, request: { route: "pr-autopilot", mode, prNumber } };
}

async function resolveLand(args: RouterArgs, fx: PostPrEffects): Promise<PostPrResolution> {
	let prNumber = args.prNumber;
	if (prNumber === undefined) {
		const raw = await fx.input("PR number to land:", "");
		const stale = await live(fx);
		if (stale) return stale;
		if (raw === undefined) return { cancelled: true };
		prNumber = parsePositivePr(raw);
		if (prNumber === undefined) return { failed: "Land requires a positive PR number." };
	}

	let readiness = args.readiness;
	if (!readiness) {
		const selected = await fx.select(
			"Land readiness:",
			READINESS_CHOICES.map((choice) => choice.label),
		);
		const stale = await live(fx);
		if (stale) return stale;
		if (!selected) return { cancelled: true };
		readiness = lookupChoice(READINESS_CHOICES, selected);
		if (!readiness) return { failed: "Unrecognized readiness selection." };
	}

	const stale = await live(fx);
	if (stale) return stale;
	return { ok: true, request: { route: "land", prNumber, readiness, method: args.landMethod } };
}
