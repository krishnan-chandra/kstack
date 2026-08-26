/** Backend-neutral client for stack delivery orchestration. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	requestStackCapabilities,
	requestStackPreflight,
	requestStackPublication,
	type StackPreflight,
} from "../shared/stack/channel.ts";
import type { StackPublishOutcome } from "../shared/stack/outcome.ts";
import { type StackProviderId, stackProviderFor } from "../shared/stack/provider.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";

interface StackDeliveryClient {
	readonly provider: StackProviderId;
	preflight(cwd: string, manifestPath?: string): Promise<VcsResult<StackPreflight>>;
	publish(cwd: string, manifestPath?: string, signal?: AbortSignal): Promise<StackPublishOutcome>;
}

export function createStackDeliveryClient(
	pi: ExtensionAPI,
	backend: VcsBackendId,
	ctx: ExtensionCommandContext,
): StackDeliveryClient | undefined {
	const provider = stackProviderFor(backend);
	if (!provider) return undefined;
	return {
		provider,
		async preflight(cwd: string, manifestPath?: string): Promise<VcsResult<StackPreflight>> {
			const caps = await requestStackCapabilities(pi, provider);
			if (!caps.handled || !caps.outcome.publication) {
				return { ok: false, error: `Stack mode requires the ${provider}-stacked-prs extension to be loaded.` };
			}
			const response = await requestStackPreflight(pi, { provider, cwd, manifestPath });
			if (!response.handled) {
				return { ok: false, error: `The ${provider}-stacked-prs extension is unavailable.` };
			}
			return response.outcome;
		},
		async publish(cwd: string, manifestPath?: string, signal?: AbortSignal): Promise<StackPublishOutcome> {
			const response = await requestStackPublication(pi, {
				provider,
				input: { repositoryPath: cwd, manifestPath, signal },
				ctx,
			});
			return response.handled
				? response.outcome
				: { status: "failed", error: `The ${provider}-stacked-prs extension became unavailable.` };
		},
	};
}
