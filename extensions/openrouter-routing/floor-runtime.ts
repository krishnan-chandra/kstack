import { isRecord } from "../shared/narrow.ts";
import { type BoundaryValue, isString } from "../shared/validation.ts";
import {
	createFloorLedger,
	type FloorLedger,
	type GenerationKeyHash,
	hashGenerationId,
	type LedgerInput,
} from "./floor-ledger.ts";
import {
	type AggregateFloorReportInput,
	aggregateFloorReport,
	type FloorReport,
	type StatsRange,
} from "./floor-report.ts";
import { applyRewrite, type CurrentModel } from "./floor-rewrite.ts";
import { type AuthResolver, lookupGenerationTier, type MetadataTierResult } from "./generation-metadata.ts";
import type { ResolvedVariant, RoutingVariant } from "./routing-policy.ts";

interface CompletedOpenRouterMessage {
	readonly responseId: string | undefined;
	readonly model: string | undefined;
}

interface TierLookupOptions {
	signal: AbortSignal;
	onDiagnostic: (diagnostic: string) => void;
}

interface FloorRuntimeDependencies {
	ledger: FloorLedger;
	resolveVariant: (model: CurrentModel | undefined) => ResolvedVariant | undefined;
	clock?: { now(): Date };
	lookup?: (responseId: string, authResolver: AuthResolver, options: TierLookupOptions) => Promise<MetadataTierResult>;
	onDiagnostic?: (diagnostic: string) => void;
}

interface FloorRuntime {
	rewrite(
		payload: BoundaryValue,
		model: CurrentModel | undefined,
		scope: string,
	): Promise<ReturnType<typeof applyRewrite>>;
	observeCompletion(
		message: BoundaryValue,
		authResolver: AuthResolver,
		scope: string,
		current: CurrentModel | undefined,
	): Promise<void>;
	report(input: { range: StatsRange; scope: string }): Promise<FloorReport>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

const COMPLETED_STOP_REASONS = new Set(["stop", "length", "toolUse"]);
const MAX_RESPONSE_ID_LENGTH = 512;
const METADATA_INITIAL_DELAY_MS = 15_000;
const METADATA_RETRY_DELAY_MS = 5_000;
const METADATA_MAX_ATTEMPTS = 3;
const METADATA_TIMEOUT_MS = 30_000;

function diagnostic(onDiagnostic: (diagnostic: string) => void, message: string): void {
	try {
		onDiagnostic(message);
	} catch {
		// Diagnostics must never affect provider traffic or completion handling.
	}
}

export function parseCompletedOpenRouterMessage(value: BoundaryValue): CompletedOpenRouterMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.role !== "assistant" || value.provider !== "openrouter") return undefined;
	if (!isString(value.stopReason) || !COMPLETED_STOP_REASONS.has(value.stopReason)) return undefined;
	const model = isString(value.model) ? value.model : undefined;
	if (
		isString(value.responseId) &&
		value.responseId.length <= MAX_RESPONSE_ID_LENGTH &&
		value.responseId.trim().length > 0
	) {
		return { responseId: value.responseId, model };
	}
	return { responseId: undefined, model };
}

function tierInput(
	result: MetadataTierResult,
	responseIdHash: GenerationKeyHash,
	eventId: string,
	at: string,
	variant: RoutingVariant | undefined,
): LedgerInput {
	if (result.kind === "known") {
		return {
			kind: "generation",
			eventId,
			at,
			generationKeyHash: responseIdHash,
			state: "resolved",
			variant,
			tier: result.tier,
		};
	}
	return {
		kind: "generation",
		eventId,
		at,
		generationKeyHash: responseIdHash,
		state: "resolved",
		variant,
		tier: "unknown",
		reason: result.reason,
	};
}

export function createFloorRuntime(dependencies: FloorRuntimeDependencies): FloorRuntime {
	const clock = dependencies.clock ?? { now: () => new Date() };
	const onDiagnostic = dependencies.onDiagnostic ?? (() => {});
	const lookup =
		dependencies.lookup ??
		((responseId, authResolver, options) =>
			lookupGenerationTier(responseId, authResolver, {
				...options,
				initialDelayMs: METADATA_INITIAL_DELAY_MS,
				retryDelayMs: METADATA_RETRY_DELAY_MS,
				maxAttempts: METADATA_MAX_ATTEMPTS,
				timeoutMs: METADATA_TIMEOUT_MS,
			}));
	const shutdownController = new AbortController();
	const pendingLookups = new Set<Promise<void>>();
	let sequence = 0;

	function nextEventId(): string {
		sequence += 1;
		return `${dependencies.ledger.processId}:e${sequence}`;
	}

	async function append(scope: string, input: LedgerInput): Promise<void> {
		try {
			await dependencies.ledger.append(scope, input);
		} catch {
			diagnostic(onDiagnostic, `ledger append failed: ${input.kind}`);
		}
	}

	async function flushLedger(): Promise<void> {
		try {
			await dependencies.ledger.flush();
		} catch {
			diagnostic(onDiagnostic, "ledger flush failed");
		}
	}

	function trackLookup(task: Promise<void>): void {
		pendingLookups.add(task);
		const untrack = (): void => {
			pendingLookups.delete(task);
		};
		void task.then(untrack, untrack);
	}

	async function resolveTier(
		responseId: string,
		responseIdHash: GenerationKeyHash,
		eventId: string,
		authResolver: AuthResolver,
		scope: string,
		signal: AbortSignal,
		variant: RoutingVariant | undefined,
	): Promise<void> {
		let result: MetadataTierResult;
		try {
			result = await lookup(responseId, authResolver, { signal, onDiagnostic });
		} catch {
			result = { kind: "unknown", reason: "lookup-failed" };
			diagnostic(onDiagnostic, "generation lookup failed: adapter error");
		}
		// A known tier is real data even if shutdown raced the response. An unknown
		// result during abort is indistinguishable from cancellation, so leave the
		// generation pending instead of recording a failure the lookup never saw.
		if (signal.aborted && result.kind !== "known") return;
		await append(scope, tierInput(result, responseIdHash, eventId, clock.now().toISOString(), variant));
	}

	return {
		async rewrite(payload, model, scope) {
			const resolved = dependencies.resolveVariant(model);
			if (resolved === undefined || resolved.source === "model-suffix") return undefined;
			const replacement = applyRewrite(payload, model, resolved.variant);
			if (replacement !== undefined && resolved.variant !== "none") {
				// Persistence runs on the ledger queue; flush() drains it at shutdown.
				// Waiting here would put filesystem latency on every provider request.
				void append(scope, {
					kind: "rewrite",
					variant: resolved.variant,
					eventId: nextEventId(),
					at: clock.now().toISOString(),
				});
			}
			return replacement;
		},

		async observeCompletion(message, authResolver, scope, current) {
			const completion = parseCompletedOpenRouterMessage(message);
			if (completion === undefined) return;
			// Mirror the rewrite's provider/model guards. Virtual or mismatched model
			// completions have no evidence that this extension routed their request.
			let resolved: ResolvedVariant | undefined;
			if (current?.provider === "openrouter" && completion.model === current.id) {
				resolved = dependencies.resolveVariant(current);
			}
			const variant = resolved?.source === "model-suffix" ? undefined : resolved?.variant;
			const at = clock.now().toISOString();
			const eventId = nextEventId();
			const responseId = completion.responseId;
			const responseIdHash = responseId === undefined ? undefined : hashGenerationId(responseId);
			await append(scope, {
				kind: "generation",
				eventId,
				at,
				generationKeyHash: responseIdHash,
				state: "observed",
				variant,
				tier: "unknown",
				reason: responseId === undefined ? "no-response-id" : "pending",
			});
			if (responseId === undefined || responseIdHash === undefined || shutdownController.signal.aborted) return;

			// The lookup deliberately ignores the turn abort signal. It is background
			// telemetry with its own deadline, and cancelling it when the user presses
			// Esc would discard exactly the coverage this extension exists to measure.
			trackLookup(
				resolveTier(responseId, responseIdHash, eventId, authResolver, scope, shutdownController.signal, variant),
			);
		},

		async report(input) {
			await dependencies.ledger.flush();
			const readResult = await dependencies.ledger.read(input.scope);
			const aggregateInput: AggregateFloorReportInput = {
				range: input.range,
				scopeLabel: readResult.scopeLabel,
				now: clock.now(),
				processId: input.range === "process" ? dependencies.ledger.processId : undefined,
				onDiagnostic,
			};
			return aggregateFloorReport(readResult.events, aggregateInput);
		},

		flush: flushLedger,

		async shutdown() {
			shutdownController.abort();
			await Promise.allSettled(pendingLookups);
			await flushLedger();
		},
	};
}

export function createDefaultFloorRuntime(resolveVariant: FloorRuntimeDependencies["resolveVariant"]): FloorRuntime {
	return createFloorRuntime({ ledger: createFloorLedger(), resolveVariant });
}
