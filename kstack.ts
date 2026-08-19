import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fastImplement from "./extensions/fast-implement/index.ts";
import handoff from "./extensions/handoff/index.ts";
import jjStackedPrs from "./extensions/jj-stacked-prs/index.ts";
import kstackRouter from "./extensions/kstack-router/index.ts";
import land from "./extensions/land/index.ts";
import panelReview from "./extensions/panel-review/index.ts";
import parallelAgents from "./extensions/parallel-agents/index.ts";
import planImplement from "./extensions/plan-implement/index.ts";
import prAutopilot from "./extensions/pr-autopilot/index.ts";
import sessionArchive from "./extensions/session-archive/index.ts";
import { getAgentPaneHost } from "./extensions/shared/agent-pane.ts";
import steeringSwap from "./extensions/steering-swap/index.ts";

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

const KSTACK_EXTENSIONS: ReadonlyArray<{ name: string; register: ExtensionFactory }> = [
	{ name: "fast-implement", register: fastImplement },
	{ name: "handoff", register: handoff },
	{ name: "jj-stacked-prs", register: jjStackedPrs },
	{ name: "kstack-router", register: kstackRouter },
	{ name: "land", register: land },
	{ name: "panel-review", register: panelReview },
	{ name: "parallel-agents", register: parallelAgents },
	{ name: "plan-implement", register: planImplement },
	{ name: "pr-autopilot", register: prAutopilot },
	{ name: "session-archive", register: sessionArchive },
	{ name: "steering-swap", register: steeringSwap },
];

/** Register every Kstack extension factory in package order. */
export async function registerKstackExtensions(
	pi: ExtensionAPI,
	factories: ReadonlyArray<{ name: string; register: ExtensionFactory }> = KSTACK_EXTENSIONS,
): Promise<void> {
	getAgentPaneHost(pi);
	for (const factory of factories) await factory.register(pi);
}

export default async function kstack(pi: ExtensionAPI): Promise<void> {
	await registerKstackExtensions(pi);
}
