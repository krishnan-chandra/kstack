/** Route decision pipeline, isolated from Pi command and UI contexts. */

import type { ChangeKind } from "../shared/change-kind.ts";
import { getRouteLabel } from "./catalog.ts";
import { buildRouteAlternatives, formatRecommendation } from "./classification.ts";
import type { ClassifierRunResult } from "./classifier-runner.ts";
import type { ClassifierModelResolution } from "./config.ts";
import type { DeliveryRecommendation, RouteId, RouterArgs, RouterConfig } from "./types.ts";

export interface RouteResolutionEffects {
	notify(message: string, level: "info" | "warning" | "error"): void;
	selectRoute(title: string, options: Array<{ route: RouteId; label: string }>): Promise<RouteId | undefined>;
	selectOption(title: string, options: string[]): Promise<string | undefined>;
	runClassifier(input: {
		model: string;
		thinking?: string;
		task: string;
		timeoutSeconds?: number;
		signal: AbortSignal;
	}): Promise<ClassifierRunResult>;
	isSessionCurrent(): boolean;
	beginClassifier(): AbortController | undefined;
	endClassifier(): void;
	setStatus(text: string | undefined): void;
}

export interface ResolvedRoute {
	route: RouteId;
	delivery: DeliveryRecommendation;
	changeKind: ChangeKind;
	overrode: boolean;
	modelSource: string;
	confidence?: string;
}

export type RouteResolution = { resolved: ResolvedRoute } | { cancelled: true } | { failed: string };

export async function resolveRoute(
	input: {
		parsedArgs: RouterArgs;
		task: string;
		routerConfig: RouterConfig | null;
		classifierResolution: ClassifierModelResolution | { ok: false; error: string } | undefined;
	},
	fx: RouteResolutionEffects,
): Promise<RouteResolution> {
	const { parsedArgs } = input;
	let route = parsedArgs.route;
	const worktree = parsedArgs.worktree ?? false;
	let delivery: DeliveryRecommendation = parsedArgs.delivery ?? (worktree ? "single" : undefined);
	let changeKind: ChangeKind = parsedArgs.changeKind ?? "generic";
	let overrode = false;
	let modelSource = "explicit --route";
	let confidence: string | undefined;

	if (!route) {
		const classifierResolution = input.classifierResolution;
		if (!classifierResolution) {
			// No classifier was resolved; use the manual fallback below.
		} else if ("error" in classifierResolution) {
			fx.notify(classifierResolution.error, "warning");
		} else {
			modelSource =
				classifierResolution.source === "config"
					? "configured"
					: classifierResolution.source === "default"
						? "built-in default"
						: "active model (not ideal)";
			if (classifierResolution.warning) fx.notify(classifierResolution.warning, "warning");
			fx.notify(`Running classifier (${modelSource})…`, "info");

			const controller = fx.beginClassifier();
			if (!controller) return { failed: "A classifier or dispatch is already running." };
			fx.setStatus("kstack-router: classifying…");
			let classifierResult: ClassifierRunResult;
			try {
				classifierResult = await fx.runClassifier({
					model: classifierResolution.modelId,
					thinking: classifierResolution.thinking,
					task: input.task,
					signal: controller.signal,
					timeoutSeconds: input.routerConfig?.timeoutSeconds,
				});
			} finally {
				fx.endClassifier();
				fx.setStatus(undefined);
			}

			if (classifierResult.status === "aborted") {
				fx.notify("Classification aborted.", "info");
				return { cancelled: true };
			}
			if (classifierResult.status === "completed") {
				confidence = classifierResult.envelope.confidence;
				const recommendation = classifierResult.envelope;
				fx.notify(formatRecommendation(recommendation, modelSource), "info");
				const alternatives = buildRouteAlternatives(recommendation.route);
				const selected = await fx.selectRoute("Accept route or choose another?", [
					{ route: recommendation.route, label: `✓ Accept: ${getRouteLabel(recommendation.route)}` },
					...alternatives.map((alternative) => ({
						route: alternative.id,
						label: `${alternative.label}: ${alternative.description.slice(0, 60)}…`,
					})),
				]);
				if (!fx.isSessionCurrent()) return { cancelled: true };
				if (!selected) {
					fx.notify("Routing cancelled.", "info");
					return { cancelled: true };
				}
				route = selected;
				overrode = route !== recommendation.route;
				// Classifier delivery applies only to the full change route;
				// fast-change is always single-PR.
				if (!overrode && route === "change" && recommendation.delivery && !delivery) delivery = recommendation.delivery;
				if (!overrode && recommendation.changeKind && !parsedArgs.changeKind) changeKind = recommendation.changeKind;
			} else {
				fx.notify(
					`Classifier did not produce a valid route (${classifierResult.error}). Please pick a route manually.`,
					"warning",
				);
				route = await selectManualRoute("Select a route:", fx);
				if (!fx.isSessionCurrent() || !route) return { cancelled: true };
				overrode = true;
			}
		}

		if (!route) {
			route = await selectManualRoute("No classifier available. Select a route:", fx);
			if (!fx.isSessionCurrent() || !route) return { cancelled: true };
			overrode = true;
		}
	}

	if (parsedArgs.changeKind && route !== "change" && route !== "fast-change") {
		return { failed: "--change-kind is only valid with the change or fast-change routes." };
	}
	if (worktree && route !== "change" && route !== "fast-change") {
		return { failed: "--worktree is only valid with the change or fast-change routes." };
	}
	if (route === "fast-change") {
		if (delivery === "stack") return { failed: "fast-change supports only single-PR workstreams. Use --route change --stack." };
		delivery = "single";
	}
	if (route === "change" && !delivery) {
		if (!overrode) {
			const choice = await fx.selectOption("Delivery mode for change?", ["single (default)", "stack", "Cancel"]);
			if (!fx.isSessionCurrent() || !choice || choice === "Cancel") return { cancelled: true };
			delivery = choice === "stack" ? "stack" : "single";
		} else {
			delivery = "single";
		}
	}

	return { resolved: { route, delivery, changeKind, overrode, modelSource, confidence } };
}

async function selectManualRoute(title: string, fx: RouteResolutionEffects): Promise<RouteId | undefined> {
	return fx.selectRoute(
		title,
		buildRouteAlternatives().map((alternative) => ({
			route: alternative.id,
			label: `${alternative.label}: ${alternative.description.slice(0, 60)}…`,
		})),
	);
}
