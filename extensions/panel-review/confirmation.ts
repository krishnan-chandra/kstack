import type { ResolvedReviewTarget } from "./review-target.ts";
import type { ScopeBundle } from "./types.ts";

interface PanelConfirmationInput {
	target: ResolvedReviewTarget;
	scope: ScopeBundle;
	reviewers: Array<{ label: string; model: string }>;
	synthesisModel: string;
	timeoutMinutes: number;
	maxRuntimeMinutes: number;
}

export function buildPanelConfirmation(input: PanelConfirmationInput): string {
	const { target, scope } = input;
	const prHeader =
		target.kind === "pr"
			? `PR: #${target.pr.number} ${target.pr.url} (state: ${target.pr.state})\nHead: ${target.pr.headSha.slice(0, 8)}\n`
			: "";
	const isolation =
		target.kind === "pr"
			? "The current working tree and refs are untouched; PR objects were fetched into the local object database. After confirmation, reviewers read an ephemeral snapshot that is removed when the run ends."
			: "The repository is never modified.";
	const stateWarning =
		target.kind === "pr" && target.pr.state !== "OPEN"
			? `\n\nWarning: PR #${target.pr.number} is ${target.pr.state}, not OPEN.`
			: "";
	const reviewerList = input.reviewers.map((reviewer) => `  ${reviewer.label}: ${reviewer.model}`).join("\n");
	return (
		prHeader +
		`Base: ${scope.baseRef} (${scope.baseSha.slice(0, 8)}, ${scope.baseStrategy})\n` +
		"Review lens: thermo-nuclear code quality\n" +
		`Changes: ${scope.fileCount} file(s), ${(scope.diffBytes / 1024).toFixed(0)} KiB diff${scope.untrackedCount > 0 ? `, ${scope.untrackedCount} untracked` : ""}${scope.truncated ? " — TRUNCATED bundle" : ""}\n` +
		`Reviewers:\n${reviewerList}\nSynthesis: ${input.synthesisModel}\n\n` +
		`Reviewers run in isolated read-only processes (read/grep/find/ls only, no bash, no extensions or skills). ${isolation} ` +
		`A child silent for ${input.timeoutMinutes} min is killed as stalled (hard cap ${input.maxRuntimeMinutes} min); press Ctrl+Shift+X to abort mid-run.` +
		stateWarning +
		(scope.contextFilesTouched
			? "\n\nThe changeset modifies AGENTS.md/CLAUDE.md, so children run with --no-context-files to keep the reviewed content out of their instructions."
			: "")
	);
}
