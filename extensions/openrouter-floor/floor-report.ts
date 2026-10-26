import type { FloorScopeLabel, LedgerEvent, ServiceTier, StatsRange, UnknownReason } from "./floor-ledger.ts";

export type { StatsRange } from "./floor-ledger.ts";

type StatsRangeParseResult = { ok: true; value: StatsRange } | { ok: false; error: string };

export function parseStatsRange(args: string): StatsRangeParseResult {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return { ok: true, value: "30d" };
	if (tokens.length !== 1) return { ok: false, error: "Usage: /openrouter-floor-stats [process|today|7d|30d]" };
	const value = tokens[0];
	if (value === "process" || value === "today" || value === "7d" || value === "30d") {
		return { ok: true, value };
	}
	return { ok: false, error: "Usage: /openrouter-floor-stats [process|today|7d|30d]" };
}

type TierCounts = Record<ServiceTier, number>;
function emptyTiers() {
	return { flex: 0, default: 0, priority: 0, ultrafast: 0, unknown: 0 } satisfies TierCounts;
}
function knownCount(tiers: TierCounts): number {
	return tiers.flex + tiers.default + tiers.priority + tiers.ultrafast;
}
function share(part: number, total: number): number | undefined {
	return total === 0 ? undefined : part / total;
}

export interface FloorReport {
	range: StatsRange;
	scopeLabel: FloorScopeLabel;
	rewrites: number;
	completedGenerations: number;
	tiers: Readonly<TierCounts>;
	rewritesByVariant: Record<"floor" | "nitro" | "unattributed", number>;
	generationsByVariant: Record<"floor" | "nitro" | "none" | "unattributed", TierCounts>;
	flexAmongFloorKnown: number | undefined;
	priorityAmongNitroKnown: number | undefined;
	unknownReasons: Readonly<Record<UnknownReason, number>>;
	metadataCoverage: number;
	flexAmongKnownTiers: number | undefined;
}

export interface AggregateFloorReportInput {
	range: StatsRange;
	scopeLabel: FloorScopeLabel;
	now: Date;
	processId?: string;
	onDiagnostic?: (diagnostic: string) => void;
}

type GenerationEvent = Extract<LedgerEvent, { kind: "generation" }>;
type GenerationGroup = {
	events: GenerationEvent[];
};

type GenerationOutcome = { tier: Exclude<ServiceTier, "unknown"> } | { tier: "unknown"; reason: UnknownReason };

function rangeStart(range: StatsRange, now: Date): number {
	if (range === "process") return Number.NEGATIVE_INFINITY;
	if (range === "today") {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		return start.getTime();
	}
	if (range === "7d") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
	return now.getTime() - 30 * 24 * 60 * 60 * 1000;
}

function isInRange(event: LedgerEvent, input: AggregateFloorReportInput): boolean {
	if (input.processId !== undefined && event.processId !== input.processId) return false;
	const at = Date.parse(event.at);
	return Number.isFinite(at) && at >= rangeStart(input.range, input.now) && at <= input.now.getTime();
}

function generationGroupKey(event: GenerationEvent): string {
	if (event.generationKeyHash !== undefined) return `identified:${event.generationKeyHash}`;
	return `anonymous:${event.eventId}`;
}

function latestEvent(events: readonly GenerationEvent[]): GenerationEvent | undefined {
	let latest: GenerationEvent | undefined;
	for (const event of events) {
		if (latest === undefined || Date.parse(event.at) >= Date.parse(latest.at)) latest = event;
	}
	return latest;
}

function generationOutcome(
	events: readonly GenerationEvent[],
	onDiagnostic: (diagnostic: string) => void,
): GenerationOutcome {
	const resolutions = events.filter((event) => event.state === "resolved");
	const knownResolutions = resolutions.filter((event) => event.tier !== "unknown");
	const knownTiers = new Set(knownResolutions.map((event) => event.tier));
	if (knownTiers.size > 1) onDiagnostic("conflicting generation tier resolutions");
	const known = latestEvent(knownResolutions);
	if (known !== undefined && known.tier !== "unknown") return { tier: known.tier };
	const unknown = latestEvent(resolutions);
	if (unknown !== undefined) return { tier: "unknown", reason: unknown.reason ?? "lookup-failed" };
	const observed = latestEvent(events);
	return { tier: "unknown", reason: observed?.reason ?? "pending" };
}

function percentage(part: number, total: number): string {
	if (total === 0) return "0.0%";
	return `${((part / total) * 100).toFixed(1)}%`;
}

export function aggregateFloorReport(events: readonly LedgerEvent[], input: AggregateFloorReportInput): FloorReport {
	const inRange = events.filter((event) => isInRange(event, input));
	const rewriteIds = new Set<string>();
	const rewritesByVariant = { floor: 0, nitro: 0, unattributed: 0 };
	const generationsByVariant = {
		floor: emptyTiers(),
		nitro: emptyTiers(),
		none: emptyTiers(),
		unattributed: emptyTiers(),
	};
	const groups = new Map<string, GenerationGroup>();

	for (const event of inRange) {
		if (event.kind === "rewrite") {
			if (!rewriteIds.has(event.eventId)) rewritesByVariant[event.variant ?? "unattributed"] += 1;
			rewriteIds.add(event.eventId);
			continue;
		}
		const key = generationGroupKey(event);
		const existing = groups.get(key);
		if (existing !== undefined) {
			existing.events.push(event);
			continue;
		}
		groups.set(key, { events: [event] });
	}

	const tiers = emptyTiers();
	const unknownReasons = {
		pending: 0,
		"no-response-id": 0,
		"lookup-failed": 0,
		"null-or-unrecognized-tier": 0,
		"invalid-response": 0,
	} satisfies Record<UnknownReason, number>;
	const onDiagnostic = (message: string): void => {
		try {
			input.onDiagnostic?.(message);
		} catch {
			// Diagnostics must never affect report generation.
		}
	};
	for (const group of groups.values()) {
		const outcome = generationOutcome(group.events, onDiagnostic);
		tiers[outcome.tier] += 1;
		const attributed = latestEvent(group.events.filter((event) => event.variant !== undefined));
		generationsByVariant[attributed?.variant ?? "unattributed"][outcome.tier] += 1;
		if (outcome.tier === "unknown") unknownReasons[outcome.reason] += 1;
	}
	const known = knownCount(tiers);
	const completedGenerations = known + tiers.unknown;
	return {
		range: input.range,
		scopeLabel: input.scopeLabel,
		rewrites: rewriteIds.size,
		completedGenerations,
		tiers,
		rewritesByVariant,
		generationsByVariant,
		flexAmongFloorKnown: share(generationsByVariant.floor.flex, knownCount(generationsByVariant.floor)),
		priorityAmongNitroKnown: share(generationsByVariant.nitro.priority, knownCount(generationsByVariant.nitro)),
		unknownReasons,
		metadataCoverage: completedGenerations === 0 ? 0 : known / completedGenerations,
		flexAmongKnownTiers: known === 0 ? undefined : tiers.flex / known,
	};
}

export function formatFloorReport(report: FloorReport): string {
	const known = knownCount(report.tiers);
	const variantLines = Object.entries(report.generationsByVariant).map(
		([variant, tiers]) =>
			`  ${variant}: flex ${tiers.flex}, default ${tiers.default}, priority ${tiers.priority}, ultrafast ${tiers.ultrafast}, unknown ${tiers.unknown}`,
	);
	const floorKnown = knownCount(report.generationsByVariant.floor);
	const nitroKnown = knownCount(report.generationsByVariant.nitro);
	const unknownReasonLabels: readonly (readonly [UnknownReason, string])[] = [
		["pending", "pending"],
		["no-response-id", "no response ID"],
		["lookup-failed", "lookup failed"],
		["null-or-unrecognized-tier", "unrecognized/null tier"],
		["invalid-response", "invalid response"],
	];
	const unknownReasonLines = unknownReasonLabels
		.filter(([reason]) => report.unknownReasons[reason] > 0)
		.map(([reason, label]) => `    ${label.padEnd(24)}${report.unknownReasons[reason].toString().padStart(4)}`);
	const lines = [
		`OpenRouter variant routing (scope: ${report.scopeLabel}, range: ${report.range})`,
		"",
		`Rewrites observed             ${report.rewrites}`,
		`  floor ${report.rewritesByVariant.floor}, nitro ${report.rewritesByVariant.nitro}, unattributed ${report.rewritesByVariant.unattributed}`,
		`Completed generations         ${report.completedGenerations}`,
		`  flex                       ${report.tiers.flex.toString().padStart(4)}  ${percentage(report.tiers.flex, report.completedGenerations)}`,
		`  default                    ${report.tiers.default.toString().padStart(4)}  ${percentage(report.tiers.default, report.completedGenerations)}`,
		`  priority                   ${report.tiers.priority.toString().padStart(4)}  ${percentage(report.tiers.priority, report.completedGenerations)}`,
		`  ultrafast                  ${report.tiers.ultrafast.toString().padStart(4)}  ${percentage(report.tiers.ultrafast, report.completedGenerations)}`,
		`  unknown                    ${report.tiers.unknown.toString().padStart(4)}  ${percentage(report.tiers.unknown, report.completedGenerations)}`,
		...unknownReasonLines,
		"Generations by inferred variant:",
		...variantLines,
		"",
		`Tier metadata coverage        ${percentage(known, report.completedGenerations)} (${known}/${report.completedGenerations})`,
		`Flex among known tiers        ${report.flexAmongKnownTiers === undefined ? "n/a" : percentage(report.tiers.flex, known)} (${report.tiers.flex}/${known})`,
		"",
		`Flex among floor known        ${report.flexAmongFloorKnown === undefined ? "n/a" : percentage(report.generationsByVariant.floor.flex, floorKnown)} (${report.generationsByVariant.floor.flex}/${floorKnown})`,
		`Priority among nitro known    ${report.priorityAmongNitroKnown === undefined ? "n/a" : percentage(report.generationsByVariant.nitro.priority, nitroKnown)} (${report.generationsByVariant.nitro.priority}/${nitroKnown})`,
		"Rewrite attempts and completed generations are separate populations.",
		"Generation variants are inferred from routing policy at completion. Older records, explicit model suffixes, and mismatched session models are unattributed.",
		"Unknown includes missing response IDs and failed or unavailable metadata lookups.",
	];
	return lines.join("\n");
}
