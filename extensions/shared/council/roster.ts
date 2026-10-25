/** Resolve the council roster: aliases, planner exclusion, duplicates, and seat letters. */

import {
	type ConfiguredModel,
	type CouncilConfig,
	loadCouncilSection,
	MAX_COUNCIL_SEATS,
	validateCouncilConfig,
} from "../kstack-config.ts";
import { collectKstackModelAliases } from "../model-aliases.ts";
import { splitModelRef } from "../model-spec.ts";
import { modelWithoutThinking, resolveModelRef } from "../resolve-model.ts";

export const SEAT_LETTERS = ["A", "B", "C", "D", "E"] as const;
export type SeatLetter = (typeof SEAT_LETTERS)[number];

interface CouncilSeat {
	letter: SeatLetter;
	/** Resolved `provider/model[:thinking]` reference. */
	model: string;
}

export interface CouncilRoster {
	seats: CouncilSeat[];
	/** Resolved seat references dropped because they use the planner's model. */
	excluded: string[];
	maxRounds: number;
	timeoutMinutes: number;
	reviewTimeoutMinutes: number;
}

interface RosterRequest {
	env?: NodeJS.ProcessEnv;
	/** The planner's `provider/model`; a thinking suffix is ignored. */
	plannerModel: string;
	/** Explicit seat references or aliases that replace `council.seats`. */
	seatsOverride?: readonly string[];
	/** What a missing `council` section without an override means for the caller. */
	whenMissing: "skip" | "error";
	available?: (provider: string, modelId: string) => boolean;
}

type RosterResult = { ok: true; roster?: CouncilRoster } | { ok: false; error: string };

const MISSING_COUNCIL_ERROR = "No council is configured. Configure council.seats in kstack.json or pass --seats.";

function seatLetter(index: number): SeatLetter {
	const letter = SEAT_LETTERS[index];
	if (letter === undefined) throw new Error(`seat index ${index} exceeds ${MAX_COUNCIL_SEATS} seats`);
	return letter;
}

function defaultKnobs(): Omit<CouncilConfig, "seats"> {
	const defaults = validateCouncilConfig({});
	if (!defaults.ok) throw new Error(`built-in council defaults are invalid: ${defaults.error}`);
	const { seats: _seats, ...knobs } = defaults.config;
	return knobs;
}

/**
 * Resolve configured or explicit seats against the planner. Seats that share
 * the planner's provider/model sit out; the rest keep configured order and get
 * letters A, B, C, ... after exclusion.
 */
export function resolveCouncilRoster(request: RosterRequest): RosterResult {
	const loaded = loadCouncilSection(request.env);
	if (loaded.status === "invalid") return { ok: false, error: `Invalid ${loaded.path}: ${loaded.error}` };
	if (loaded.status === "missing" && request.seatsOverride === undefined) {
		return request.whenMissing === "skip" ? { ok: true } : { ok: false, error: MISSING_COUNCIL_ERROR };
	}
	const knobs = loaded.status === "found" ? loaded.config : defaultKnobs();
	const configured: readonly ConfiguredModel[] =
		request.seatsOverride ?? (loaded.status === "found" ? loaded.config.seats : []);
	if (configured.length < 1 || configured.length > MAX_COUNCIL_SEATS) {
		return { ok: false, error: `A council needs 1 to ${MAX_COUNCIL_SEATS} seats; got ${configured.length}.` };
	}
	const aliases = loaded.root ? collectKstackModelAliases(loaded.root) : [];
	const planner = modelWithoutThinking(request.plannerModel.trim());
	const seen = new Set<string>();
	const kept: string[] = [];
	const excluded: string[] = [];
	for (const entry of configured) {
		const resolved = resolveModelRef({ configured: entry, aliases, section: "council", key: "seats" });
		if (!resolved.ok) return resolved;
		const model = modelWithoutThinking(resolved.ref);
		if (seen.has(model)) return { ok: false, error: `Council seats repeat the model ${model}.` };
		seen.add(model);
		if (model === planner) {
			excluded.push(resolved.ref);
			continue;
		}
		const { provider, modelId } = splitModelRef(model);
		if (request.available && !request.available(provider, modelId)) {
			return { ok: false, error: `Council seat model is unavailable or unauthenticated: ${model}.` };
		}
		kept.push(resolved.ref);
	}
	if (kept.length === 0) {
		return {
			ok: false,
			error: `Every council seat uses the planner model ${planner}. Configure a seat with a different model.`,
		};
	}
	const seats = kept.map((model, index) => ({ letter: seatLetter(index), model }));
	return {
		ok: true,
		roster: {
			seats,
			excluded,
			maxRounds: knobs.maxRounds,
			timeoutMinutes: knobs.timeoutMinutes,
			reviewTimeoutMinutes: knobs.reviewTimeoutMinutes,
		},
	};
}
