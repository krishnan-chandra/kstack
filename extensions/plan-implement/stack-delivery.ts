/** Backend-neutral seam for stack delivery orchestration. */

import { readFileSync } from "node:fs";
import type { StackPublicationOutcome as JjPublicationOutcome, JjStackCapabilities } from "../jj-stacked-prs/types.ts";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";
import { preflightStack } from "./delivery-mode.ts";
import {
	parseGraphiteStackManifest,
	planGraphitePublication,
	submitGraphiteStack,
	verifyGraphiteStack,
} from "./graphite-stack-delivery.ts";

type StackDeliveryBackendId = Extract<VcsBackendId, "jj" | "graphite">;

interface StackPublicationPullRequest {
	ref: string;
	baseRef: string | null;
	headSha?: string;
	prNumber: number;
	url: string;
	draft: boolean;
}

export interface StackPublicationMap {
	backend: StackDeliveryBackendId;
	topRef: string;
	pullRequests: readonly StackPublicationPullRequest[];
}

export type StackDeliveryOutcome =
	| { status: "completed"; publication: StackPublicationMap }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| { status: "blocked"; message: string }
	| { status: "stale"; message: string }
	| { status: "partial"; message: string; publication?: StackPublicationMap }
	| { status: "cancelled" }
	| { status: "indeterminate"; message: string }
	| { status: "failed"; message: string };

interface StackPreflight {
	workspaceRoot: string;
	trunkRef: string;
	trunkSha: string;
}

interface StackDeliveryAdapter {
	readonly backendId: StackDeliveryBackendId;
	preflight(cwd: string): Promise<VcsResult<StackPreflight>>;
	childPolicy(input: StackPreflight & { manifestPath?: string }): string;
	publish(
		cwd: string,
		manifestPath: string | undefined,
		confirm: (title: string, body: string) => Promise<boolean>,
	): Promise<StackDeliveryOutcome>;
}

interface StackAdapterDeps {
	exec: ExecFn;
	jjPolicy: string;
	requestJjCapabilities?(): Promise<{ handled: false } | { handled: true; outcome: JjStackCapabilities }>;
	requestJjPublication?(cwd: string): Promise<{ handled: false } | { handled: true; outcome: JjPublicationOutcome }>;
}

function mapJjOutcome(outcome: JjPublicationOutcome): StackDeliveryOutcome {
	switch (outcome.status) {
		case "completed":
			return {
				status: "completed",
				publication: {
					backend: "jj",
					topRef: outcome.publication.topBookmark,
					pullRequests: outcome.publication.pullRequests.map((pr) => ({
						ref: pr.bookmark,
						baseRef: pr.baseBookmark,
						prNumber: pr.prNumber,
						url: pr.url,
						draft: pr.draft,
					})),
				},
			};
		case "declined":
			return { status: "declined" };
		case "busy":
			return { status: "busy", message: outcome.message };
		case "blocked":
			return { status: "blocked", message: outcome.blockers.map((item) => item.message).join("; ") };
		case "stale":
			return { status: "stale", message: "The jj publication plan changed after confirmation." };
		case "partial":
			return { status: "partial", message: outcome.failedAction.error };
		case "cancelled":
			return { status: "cancelled" };
		case "indeterminate":
			return { status: "indeterminate", message: outcome.inFlight.error };
		case "failed":
			return { status: "failed", message: outcome.error };
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}

class JjStackDeliveryAdapter implements StackDeliveryAdapter {
	readonly backendId = "jj" as const;

	constructor(private readonly deps: StackAdapterDeps) {}

	async preflight(cwd: string): Promise<VcsResult<StackPreflight>> {
		if (!this.deps.requestJjCapabilities || !this.deps.requestJjPublication) {
			return { ok: false, error: "Stack mode requires the jj-stacked-prs extension to be loaded." };
		}
		const capabilities = await this.deps.requestJjCapabilities();
		if (!capabilities.handled || !capabilities.outcome.publication) {
			return { ok: false, error: "Stack mode requires the jj-stacked-prs extension to be loaded." };
		}
		const preflight = await preflightStack(cwd, this.deps.exec);
		return preflight.ok
			? { ok: true, workspaceRoot: preflight.workspaceRoot, trunkRef: "trunk()", trunkSha: preflight.trunkSha }
			: preflight;
	}

	childPolicy(): string {
		return this.deps.jjPolicy;
	}

	async publish(cwd: string): Promise<StackDeliveryOutcome> {
		const response = await this.deps.requestJjPublication?.(cwd);
		return response?.handled
			? mapJjOutcome(response.outcome)
			: { status: "failed", message: "The jj-stacked-prs extension became unavailable." };
	}
}

class GraphiteStackDeliveryAdapter implements StackDeliveryAdapter {
	readonly backendId = "graphite" as const;

	constructor(private readonly deps: StackAdapterDeps) {}

	async preflight(cwd: string): Promise<VcsResult<StackPreflight>> {
		const common = await preflightVcs(cwd, "graphite", this.deps.exec);
		if (!common.ok) return common;
		let trunk: ExecFnResult;
		try {
			trunk = await this.deps.exec("gt", ["--no-interactive", "trunk"], {
				cwd: common.workspaceRoot,
				timeout: 8_000,
			});
		} catch (error) {
			return {
				ok: false,
				error: `Could not resolve the Graphite trunk: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const trunkRef = trunk.stdout.trim();
		if (trunk.code !== 0 || !trunkRef) return { ok: false, error: "Could not resolve the Graphite trunk." };
		const head = await this.deps.exec("git", ["rev-parse", "--verify", `refs/heads/${trunkRef}^{commit}`], {
			cwd: common.workspaceRoot,
			timeout: 8_000,
		});
		const trunkSha = head.stdout.trim();
		return head.code === 0 && /^[0-9a-f]{40}$/.test(trunkSha)
			? { ok: true, workspaceRoot: common.workspaceRoot, trunkRef, trunkSha }
			: { ok: false, error: `Could not resolve Graphite trunk ${trunkRef}.` };
	}

	childPolicy(input: StackPreflight & { manifestPath?: string }): string {
		if (!input.manifestPath) throw new Error("Graphite stack mode requires a private manifest path.");
		return [
			"# Local Graphite stack policy",
			"Build a local stack with native gt only; the parent owns publication.",
			`Start from ${input.trunkRef} at immutable commit ${input.trunkSha}.`,
			"Create one kstack/<slice> branch per approved PR slice with gt create, and record changes with gt add/gt modify.",
			"Do not run gt submit, gt merge, gh mutations, git commit, git branch, git rebase, or git push.",
			`After every create, modify, or restack, atomically replace ${input.manifestPath} with schemaVersion 1 JSON containing trunkRef, trunkSha, and the ordered slices [{branch, baseBranch, headSha, subject}].`,
			"Leave a clean working tree with the manifest's top branch checked out. The manifest is evidence only; the parent revalidates every fact.",
		].join("\n\n");
	}

	async publish(
		cwd: string,
		manifestPath: string | undefined,
		confirm: (title: string, body: string) => Promise<boolean>,
	): Promise<StackDeliveryOutcome> {
		if (!manifestPath) return { status: "failed", message: "Graphite stack manifest path is unavailable." };
		let raw: string;
		try {
			raw = readFileSync(manifestPath, "utf8");
		} catch (error) {
			return {
				status: "blocked",
				message: `Could not read the Graphite stack manifest: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const parsed = parseGraphiteStackManifest(raw);
		if (!parsed.ok) return { status: "blocked", message: parsed.error };
		const verified = await verifyGraphiteStack(cwd, parsed.manifest, this.deps.exec);
		if (!verified.ok) return { status: "blocked", message: verified.error };
		const planned = await planGraphitePublication(verified.stack, this.deps.exec);
		if (!planned.ok) return { status: "blocked", message: planned.error };
		if (!(await confirm("Publish this Graphite stack?", planned.plan.preview))) return { status: "declined" };
		const result = await submitGraphiteStack(planned.plan, this.deps.exec);
		switch (result.status) {
			case "completed":
				return {
					status: "completed",
					publication: {
						backend: "graphite",
						topRef: result.pullRequests.at(-1)?.ref ?? "",
						pullRequests: result.pullRequests,
					},
				};
			case "blocked":
			case "busy":
			case "failed":
			case "indeterminate":
				return { status: result.status, message: result.error };
			case "stale":
				return { status: "stale", message: "The Graphite publication plan changed after confirmation." };
			case "partial":
				return {
					status: "partial",
					message: result.error,
					publication: {
						backend: "graphite",
						topRef: result.pullRequests.at(-1)?.ref ?? "",
						pullRequests: result.pullRequests,
					},
				};
			default: {
				const exhaustive: never = result;
				return exhaustive;
			}
		}
	}
}

/** Exhaustive capability factory: Git has no stack-delivery adapter. */
export function createStackDeliveryAdapter(
	backend: VcsBackendId,
	deps: StackAdapterDeps,
): StackDeliveryAdapter | undefined {
	switch (backend) {
		case "git":
			return undefined;
		case "jj":
			return new JjStackDeliveryAdapter(deps);
		case "graphite":
			return new GraphiteStackDeliveryAdapter(deps);
		default: {
			const exhaustive: never = backend;
			return exhaustive;
		}
	}
}
