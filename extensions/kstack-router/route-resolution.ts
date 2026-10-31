/** Route decision pipeline, isolated from Pi command and UI contexts. */

import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import { getRouteLabel } from "./catalog.ts";
import { buildRouteAlternatives, formatRecommendation } from "./classification.ts";
import type { ClassifierRunResult } from "./classifier-runner.ts";
import type { ClassifierModelResolution } from "./config.ts";
import type { RouteId, RouterArgs, RouterConfig } from "./types.ts";

export interface RouteResolutionEffects {
	notify(message: string, level: "info" | "warning" | "error"): void;
	selectRoute(title: string, options: Array<{ route: RouteId; label: string }>): Promise<RouteId | undefined>;
	selectOption(title: string, options: string[]): Promise<string | undefined>;
	runClassifier(input: {
		model: string;
		thinking?: ModelThinkingLevel;
		task: string;
		timeoutSeconds?: number;
		signal: AbortSignal;
	}): Promise<ClassifierRunResult>;
	isSessionCurrent(): boolean;
	beginClassifier(): AbortController | undefined;
	endClassifier(): void;
	setStatus(text: string | undefined): void;
}

interface ResolvedRoute {
	route: RouteId;
	overrode: boolean;
	modelSource: string;
	confidence?: string;
}

type RouteResolution = { resolved: ResolvedRoute } | { cancelled: true } | { failed: string };

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

	return { resolved: { route, overrode, modelSource, confidence } };
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
