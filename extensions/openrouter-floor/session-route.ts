import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRecord } from "../shared/narrow.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { isRoutingVariant, type ResolvedVariant, type RoutingVariant } from "./routing-policy.ts";

export const ROUTE_ENTRY_TYPE = "openrouter-floor/route";
const routeEntrySchema = Type.Object(
	{
		version: Type.Literal(1),
		override: Type.Union([Type.Literal("floor"), Type.Literal("nitro"), Type.Literal("none"), Type.Null()]),
	},
	{ additionalProperties: false },
);
type RouteEntryData = Static<typeof routeEntrySchema>;
function isRouteEntryData(value: BoundaryValue): value is RouteEntryData {
	return Check(routeEntrySchema, value);
}
type RouteCommand = { kind: "show" } | { kind: "set"; variant: RoutingVariant } | { kind: "reset" };
export function parseRouteCommand(args: string): { ok: true; command: RouteCommand } | { ok: false; error: string } {
	const value = args.trim();
	if (value === "") return { ok: true, command: { kind: "show" } };
	if (value === "reset") return { ok: true, command: { kind: "reset" } };
	if (isRoutingVariant(value)) return { ok: true, command: { kind: "set", variant: value } };
	return { ok: false, error: "Usage: /openrouter-route [floor|nitro|none|reset]" };
}

export function overrideFromBranch(entries: readonly BoundaryValue[]): RoutingVariant | undefined {
	let override: RoutingVariant | undefined;
	for (const entry of entries) {
		if (
			!isRecord(entry) ||
			entry.type !== "custom" ||
			entry.customType !== ROUTE_ENTRY_TYPE ||
			!isRouteEntryData(entry.data)
		)
			continue;
		override = entry.data.override ?? undefined;
	}
	return override;
}

export function formatRouteStatus(resolved: ResolvedVariant | undefined): string | undefined {
	if (resolved === undefined) return undefined;
	let source = "";
	if (resolved.source === "session-override") source = " (session)";
	else if (resolved.source === "config-model") source = " (model config)";
	else if (resolved.source === "model-suffix") source = " (suffix)";
	return `OR ${resolved.variant}${source}`;
}

export function formatRouteSummary(
	resolved: ResolvedVariant | undefined,
	override: RoutingVariant | undefined,
	configError?: string,
): string {
	const configWarning =
		configError === undefined
			? ""
			: ` Config invalid: ${configError} Config falls back to built-in floor. Session overrides and model suffixes still take precedence.`;
	const session = override === undefined ? "No session override." : `Session override: ${override}.`;
	if (resolved === undefined) return `${session} Routing applies once an OpenRouter model is selected.${configWarning}`;
	return `OpenRouter route: ${resolved.variant} (${resolved.source}). ${session}${configWarning}`;
}
