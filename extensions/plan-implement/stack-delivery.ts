/** Backend-neutral seam for stack delivery orchestration. */

import { readFileSync } from "node:fs";
import type { JjStackCapabilities } from "../jj-stacked-prs/types.ts";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import type { StackBlocker, StackPublishOutcome } from "../shared/stack/outcome.ts";
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

function graphiteBlocker(message: string): StackBlocker {
	return { code: "graphite-publish", message };
}

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
	): Promise<StackPublishOutcome>;
}

interface StackAdapterDeps {
	exec: ExecFn;
	jjPolicy: string;
	requestJjCapabilities?(): Promise<{ handled: false } | { handled: true; outcome: JjStackCapabilities }>;
	requestJjPublication?(cwd: string): Promise<{ handled: false } | { handled: true; outcome: StackPublishOutcome }>;
}

class JjStackDeliveryAdapter implements StackDeliveryAdapter {
	readonly backendId = "jj" as const;
	private readonly deps: StackAdapterDeps;

	constructor(deps: StackAdapterDeps) {
		this.deps = deps;
	}

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

	async publish(cwd: string): Promise<StackPublishOutcome> {
		const response = await this.deps.requestJjPublication?.(cwd);
		return response?.handled
			? response.outcome
			: { status: "failed", error: "The jj-stacked-prs extension became unavailable." };
	}
}

class GraphiteStackDeliveryAdapter implements StackDeliveryAdapter {
	readonly backendId = "graphite" as const;
	private readonly deps: StackAdapterDeps;

	constructor(deps: StackAdapterDeps) {
		this.deps = deps;
	}

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
	): Promise<StackPublishOutcome> {
		if (!manifestPath) return { status: "failed", error: "Graphite stack manifest path is unavailable." };
		let raw: string;
		try {
			raw = readFileSync(manifestPath, "utf8");
		} catch (error) {
			return {
				status: "blocked",
				blockers: [
					graphiteBlocker(
						`Could not read the Graphite stack manifest: ${error instanceof Error ? error.message : String(error)}`,
					),
				],
			};
		}
		const parsed = parseGraphiteStackManifest(raw);
		if (!parsed.ok) return { status: "blocked", blockers: [graphiteBlocker(parsed.error)] };
		const verified = await verifyGraphiteStack(cwd, parsed.manifest, this.deps.exec);
		if (!verified.ok) return { status: "blocked", blockers: [graphiteBlocker(verified.error)] };
		const planned = await planGraphitePublication(verified.stack, this.deps.exec);
		if (!planned.ok) return { status: "blocked", blockers: [graphiteBlocker(planned.error)] };
		if (!(await confirm("Publish this Graphite stack?", planned.plan.preview))) return { status: "declined" };
		return submitGraphiteStack(planned.plan, this.deps.exec);
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
