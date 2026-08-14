/** Registration and rendering for the router's persistent decision card. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type ChangeKind, changeKindLabel } from "../plan-implement/change-kind.ts";
import type { DeliveryRecommendation, RouteId } from "./types.ts";

export interface RouteCardDetails {
	schemaVersion: 1;
	route: RouteId;
	routeLabel: string;
	delivery: DeliveryRecommendation;
	worktree?: boolean;
	changeKind?: ChangeKind;
	modelSource?: string;
	confidence?: string;
	overrode: boolean;
	dispatchStatus?: string;
}

export function registerRouteCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("kstack-route", (message, { expanded, outputPad }, theme) => {
		const details = message.details as RouteCardDetails | undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if (!expanded) {
			const header =
				theme.fg("accent", "◆ Kstack Router") +
				theme.fg("muted", ` — ${details?.routeLabel ?? "unknown route"}`) +
				(details?.overrode ? theme.fg("warning", " — overridden") : "") +
				(details?.dispatchStatus === "failed"
					? theme.fg("error", " — dispatch failed")
					: details?.dispatchStatus === "dispatched"
						? theme.fg("success", " — dispatched")
						: "") +
				theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			return box;
		}
		const lines: string[] = [
			theme.fg("accent", "◆ Kstack Router"),
			"",
			`Route: ${details?.routeLabel ?? "unknown"} (${details?.route ?? "?"})`,
			...(details?.delivery ? [`Delivery: ${details.delivery === "stack" ? "stacked PRs" : "single PR"}`] : []),
			...(details?.worktree ? ["Location: managed Git worktree"] : []),
			...(details?.changeKind ? [`Change kind: ${changeKindLabel(details.changeKind)}`] : []),
			...(details?.modelSource ? [`Classifier: ${details.modelSource}`] : []),
			...(details?.confidence ? [`Confidence: ${details.confidence}`] : []),
			...(details?.overrode ? [theme.fg("warning", "User overrode recommendation")] : []),
			...(details?.dispatchStatus ? [`Status: ${details.dispatchStatus}`] : []),
			"",
			typeof message.content === "string" ? message.content : "(structured content)",
		];
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}
