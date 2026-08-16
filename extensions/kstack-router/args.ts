/** Pure argument parser for the /kstack command. */

import { isMergeMethod } from "../shared/github.ts";
import {
	type AutopilotModeFlag,
	type ChangeKind,
	DEFAULTS,
	type DeliveryRecommendation,
	isChangeKind,
	isRouteId,
	type LandMethodFlag,
	type LandReadinessFlag,
	type RouterArgs,
} from "./types.ts";

export type ArgsParse = { ok: true; args: RouterArgs } | { ok: false; error: string };

function isAutopilotMode(value: string): value is AutopilotModeFlag {
	return value === "check" || value === "threads" || value === "drive" || value === "watch" || value === "cleanup";
}

function isLandMethod(value: string): value is LandMethodFlag {
	return isMergeMethod(value);
}

function isReadiness(value: string): value is LandReadinessFlag {
	return value === "check" || value === "watch";
}
const VALID_ROUTES =
	"investigate, change, fast-change, arena, swarm, skill-authoring, session-pickup, review, pr-autopilot, land";
const SUPPORTED_FLAGS =
	"--route <id>, --single, --stack, --worktree, --change-kind <kind>, --mode <mode>, --pr <n>, --method <method>, --readiness <mode>";

/**
 * Parse /kstack leading options. Supports:
 *   /kstack --route investigate Refactor the widget
 *   /kstack --single Refactor the widget
 *   /kstack --route change --stack Implement CI pipeline
 *   /kstack --route change --change-kind feature "Add feature X"
 *   /kstack --route pr-autopilot --mode drive --pr 42
 *   /kstack --route land --pr 42 --readiness watch --method squash
 *   /kstack --route change --single -- "Add feature X"
 *   /kstack investigate (flag-less task with no leading --)
 *
 * Uses `--` to terminate flag parsing so tasks starting with dashes work.
 */
export function parseArgs(input: string): ArgsParse {
	const trimmed = input.trim();
	if (!trimmed) return { ok: true, args: { task: "" } };

	const tokens = tokenize(trimmed);
	if (typeof tokens === "string") return { ok: false, error: tokens };

	let route: string | undefined;
	let delivery: DeliveryRecommendation;
	let worktree = false;
	let changeKind: ChangeKind | undefined;
	let autopilotMode: AutopilotModeFlag | undefined;
	let prNumber: number | undefined;
	let landMethod: LandMethodFlag | undefined;
	let readiness: LandReadinessFlag | undefined;
	let i = 0;

	// Parse leading flags until we hit a non-flag or `--`.
	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			i++;
			break;
		}
		if (!token.startsWith("--")) break;

		if (token === "--route") {
			if (route !== undefined) return { ok: false, error: "Duplicate --route flag." };
			i++;
			route = tokens[i];
			if (!route || route.startsWith("--")) {
				return { ok: false, error: "--route requires a value (e.g. --route investigate)." };
			}
			continue;
		}

		if (token === "--single" || token === "--stack") {
			if (delivery) return { ok: false, error: "Specify at most one of --single or --stack." };
			delivery = token === "--stack" ? "stack" : "single";
			continue;
		}

		if (token === "--worktree") {
			if (worktree) return { ok: false, error: "Duplicate --worktree flag." };
			worktree = true;
			continue;
		}

		if (token === "--change-kind") {
			if (changeKind !== undefined) return { ok: false, error: "Duplicate --change-kind flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--") || !isChangeKind(value)) {
				return {
					ok: false,
					error: "--change-kind requires one of: bug-fix, feature, refactor, performance, prototype, generic.",
				};
			}
			changeKind = value;
			continue;
		}

		if (token === "--mode") {
			if (autopilotMode !== undefined) return { ok: false, error: "Duplicate --mode flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--") || !isAutopilotMode(value)) {
				return { ok: false, error: "--mode requires one of: check, threads, drive, watch, cleanup." };
			}
			autopilotMode = value;
			continue;
		}

		if (token === "--pr") {
			if (prNumber !== undefined) return { ok: false, error: "Duplicate --pr flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--")) return { ok: false, error: "--pr requires a positive integer." };
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed <= 0) {
				return { ok: false, error: "--pr requires a positive integer." };
			}
			prNumber = parsed;
			continue;
		}

		if (token === "--method") {
			if (landMethod !== undefined) return { ok: false, error: "Duplicate --method flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--") || !isLandMethod(value)) {
				return { ok: false, error: "--method requires one of: squash, rebase." };
			}
			landMethod = value;
			continue;
		}

		if (token === "--readiness") {
			if (readiness !== undefined) return { ok: false, error: "Duplicate --readiness flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--") || !isReadiness(value)) {
				return { ok: false, error: "--readiness requires one of: check, watch." };
			}
			readiness = value;
			continue;
		}

		return { ok: false, error: `Unknown flag: ${token}. Supported: ${SUPPORTED_FLAGS}.` };
	}

	if (delivery === "stack" && worktree) {
		return { ok: false, error: "--stack and --worktree cannot currently be combined." };
	}
	if (worktree && !delivery) delivery = "single";

	// Validate route if provided.
	if (route !== undefined && !isRouteId(route)) {
		return { ok: false, error: `Unknown route "${route}". Valid routes: ${VALID_ROUTES}.` };
	}

	// Remaining tokens form the task.
	const task = tokens.slice(i).join(" ");

	const taskBytes = Buffer.byteLength(task, "utf8");
	if (taskBytes > DEFAULTS.maxTaskBytes) {
		return {
			ok: false,
			error: `Task is ${taskBytes} bytes; the limit is ${DEFAULTS.maxTaskBytes} bytes.`,
		};
	}

	return {
		ok: true,
		args: {
			route: route ? (route as RouterArgs["route"]) : undefined,
			delivery,
			worktree,
			changeKind,
			autopilotMode,
			prNumber,
			landMethod,
			readiness,
			task: task.trim(),
		},
	};
}

/**
 * Simple tokenizer that splits on whitespace but preserves quoted strings.
 * Returns the token array or an error string on unterminated quotes.
 */
function tokenize(input: string): string[] | string {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasCurrent = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === "\\" && quote === '"' && i + 1 < input.length && input[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasCurrent = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasCurrent || current.length > 0) {
				tokens.push(current);
				current = "";
				hasCurrent = false;
			}
			continue;
		}
		current += ch;
	}
	if (quote) return `Unterminated ${quote} quote in arguments.`;
	if (hasCurrent || current.length > 0) tokens.push(current);
	return tokens;
}
