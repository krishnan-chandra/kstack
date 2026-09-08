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
import { applyFloor, type CurrentModel } from "./floor-rewrite.ts";
import {
	type AuthResolver,
	lookupGenerationTier,
	type MetadataLookupOptions,
	type MetadataTierResult,
} from "./generation-metadata.ts";

interface CompletedOpenRouterMessage {
	readonly responseId: string | undefined;
}

interface FloorRuntimeDependencies {
	ledger: FloorLedger;
	clock?: { now(): Date };
	lookup?: (
		responseId: string,
		authResolver: AuthResolver,
		options: Pick<MetadataLookupOptions, "signal"> & { onDiagnostic?: (diagnostic: string) => void },
	) => Promise<MetadataTierResult>;
	onDiagnostic?: (diagnostic: string) => void;
}

interface FloorRuntime {
	rewrite(
		payload: BoundaryValue,
		model: CurrentModel | undefined,
		scope: string,
	): Promise<ReturnType<typeof applyFloor>>;
	observeCompletion(
		message: BoundaryValue,
		authResolver: AuthResolver,
		scope: string,
		signal?: AbortSignal,
	): Promise<void>;
	report(input: { range: StatsRange; scope: string }): Promise<FloorReport>;
	flush(): Promise<void>;
}

const COMPLETED_STOP_REASONS = new Set(["stop", "length", "toolUse"]);
const MAX_RESPONSE_ID_LENGTH = 512;

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
	if (
		isString(value.responseId) &&
		value.responseId.length <= MAX_RESPONSE_ID_LENGTH &&
		value.responseId.trim().length > 0
	) {
		return { responseId: value.responseId };
	}
	return { responseId: undefined };
}

function tierInput(
	result: MetadataTierResult,
	responseIdHash: GenerationKeyHash,
	eventId: string,
	at: string,
): LedgerInput {
	if (result.kind === "known") {
		return {
			kind: "generation",
			eventId,
			at,
			generationKeyHash: responseIdHash,
			state: "resolved",
			tier: result.tier,
		};
	}
	return {
		kind: "generation",
		eventId,
		at,
		generationKeyHash: responseIdHash,
		state: "resolved",
		tier: "unknown",
		reason: result.reason,
	};
}

export function createFloorRuntime(dependencies: FloorRuntimeDependencies): FloorRuntime {
	const clock = dependencies.clock ?? { now: () => new Date() };
	const onDiagnostic = dependencies.onDiagnostic ?? (() => {});
	const lookup =
		dependencies.lookup ??
		((responseId, authResolver, options) => lookupGenerationTier(responseId, authResolver, options));
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

	return {
		async rewrite(payload, model, scope) {
			const replacement = applyFloor(payload, model);
			if (replacement !== undefined) {
				// Persistence runs on the ledger queue; flush() drains it at shutdown.
				// Waiting here would put filesystem latency on every provider request.
				void append(scope, {
					kind: "rewrite",
					eventId: nextEventId(),
					at: clock.now().toISOString(),
				});
			}
			return replacement;
		},

		async observeCompletion(message, authResolver, scope, signal) {
			const completion = parseCompletedOpenRouterMessage(message);
			if (completion === undefined) return;
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
				tier: "unknown",
				reason: responseId === undefined ? "no-response-id" : "pending",
			});
			if (responseId === undefined || responseIdHash === undefined) return;

			let result: MetadataTierResult;
			try {
				result = await lookup(responseId, authResolver, { signal, onDiagnostic });
			} catch {
				result = { kind: "unknown", reason: "lookup-failed" };
				diagnostic(onDiagnostic, "generation lookup failed: adapter error");
			}
			await append(scope, tierInput(result, responseIdHash, eventId, clock.now().toISOString()));
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

		async flush() {
			try {
				await dependencies.ledger.flush();
			} catch {
				diagnostic(onDiagnostic, "ledger flush failed");
			}
		},
	};
}

export function createDefaultFloorRuntime(): FloorRuntime {
	return createFloorRuntime({ ledger: createFloorLedger() });
}
