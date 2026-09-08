import type { FloorScopeLabel, LedgerEvent, ServiceTier, StatsRange } from "./floor-ledger.ts";

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

export interface FloorReport {
	range: StatsRange;
	scopeLabel: FloorScopeLabel;
	rewrites: number;
	completedGenerations: number;
	tiers: Readonly<{
		flex: number;
		default: number;
		priority: number;
		unknown: number;
	}>;
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

type GenerationOutcome = {
	tier: ServiceTier;
};

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
	if (known !== undefined) return { tier: known.tier };
	const unknown = latestEvent(resolutions);
	if (unknown !== undefined) return { tier: "unknown" };
	return { tier: "unknown" };
}

function percentage(part: number, total: number): string {
	if (total === 0) return "0.0%";
	return `${((part / total) * 100).toFixed(1)}%`;
}

export function aggregateFloorReport(events: readonly LedgerEvent[], input: AggregateFloorReportInput): FloorReport {
	const inRange = events.filter((event) => isInRange(event, input));
	const rewriteIds = new Set<string>();
	const groups = new Map<string, GenerationGroup>();

	for (const event of inRange) {
		if (event.kind === "rewrite") {
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

	const tiers = { flex: 0, default: 0, priority: 0, unknown: 0 };
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
	}
	const completedGenerations = tiers.flex + tiers.default + tiers.priority + tiers.unknown;
	const known = tiers.flex + tiers.default + tiers.priority;
	return {
		range: input.range,
		scopeLabel: input.scopeLabel,
		rewrites: rewriteIds.size,
		completedGenerations,
		tiers,
		metadataCoverage: completedGenerations === 0 ? 0 : known / completedGenerations,
		flexAmongKnownTiers: known === 0 ? undefined : tiers.flex / known,
	};
}

export function formatFloorReport(report: FloorReport): string {
	const known = report.tiers.flex + report.tiers.default + report.tiers.priority;
	const lines = [
		`OpenRouter floor routing (scope: ${report.scopeLabel}, range: ${report.range})`,
		"",
		`Floor rewrites observed       ${report.rewrites}`,
		`Completed generations         ${report.completedGenerations}`,
		`  flex                       ${report.tiers.flex.toString().padStart(4)}  ${percentage(report.tiers.flex, report.completedGenerations)}`,
		`  default                    ${report.tiers.default.toString().padStart(4)}  ${percentage(report.tiers.default, report.completedGenerations)}`,
		`  priority                   ${report.tiers.priority.toString().padStart(4)}  ${percentage(report.tiers.priority, report.completedGenerations)}`,
		`  unknown                    ${report.tiers.unknown.toString().padStart(4)}  ${percentage(report.tiers.unknown, report.completedGenerations)}`,
		"",
		`Tier metadata coverage        ${percentage(known, report.completedGenerations)} (${known}/${report.completedGenerations})`,
		`Flex among known tiers        ${report.flexAmongKnownTiers === undefined ? "n/a" : percentage(report.tiers.flex, known)} (${report.tiers.flex}/${known})`,
		"",
		"Rewrite attempts and completed generations are separate populations.",
		"Unknown includes missing response IDs and failed or unavailable metadata lookups.",
	];
	return lines.join("\n");
}
