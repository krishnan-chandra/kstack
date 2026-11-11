import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import githubStackedPrs from "./extensions/github-stacked-prs/index.ts";
import graphiteStackedPrs from "./extensions/graphite-stacked-prs/index.ts";
import handoff from "./extensions/handoff/index.ts";
import jjStackedPrs from "./extensions/jj-stacked-prs/index.ts";
import land from "./extensions/land/index.ts";
import openrouterRouting from "./extensions/openrouter-routing/index.ts";
import parallelAgents from "./extensions/parallel-agents/index.ts";
import prAutopilot from "./extensions/pr-autopilot/index.ts";
import sessionArchive from "./extensions/session-archive/index.ts";
import { registerHostedAgentStateReporter } from "./extensions/shared/hosted-agents/state-reporter.ts";
import steeringSwap from "./extensions/steering-swap/index.ts";

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

const KSTACK_EXTENSIONS: ReadonlyArray<{ name: string; register: ExtensionFactory }> = [
	{ name: "graphite-stacked-prs", register: graphiteStackedPrs },
	{ name: "github-stacked-prs", register: githubStackedPrs },
	{ name: "handoff", register: handoff },
	{ name: "jj-stacked-prs", register: jjStackedPrs },
	{ name: "land", register: land },
	{ name: "openrouter-routing", register: openrouterRouting },
	{ name: "parallel-agents", register: parallelAgents },
	{ name: "pr-autopilot", register: prAutopilot },
	{ name: "session-archive", register: sessionArchive },
	{ name: "steering-swap", register: steeringSwap },
];

/** Register every Kstack extension factory in package order. */
export async function registerKstackExtensions(
	pi: ExtensionAPI,
	factories: ReadonlyArray<{ name: string; register: ExtensionFactory }> = KSTACK_EXTENSIONS,
): Promise<void> {
	for (const factory of factories) await factory.register(pi);
}

export default async function kstack(pi: ExtensionAPI): Promise<void> {
	registerHostedAgentStateReporter(pi);
	await registerKstackExtensions(pi);
}
