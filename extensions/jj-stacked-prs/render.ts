/** Bounded tables and confirmation summaries. */

import { shortenId } from "./stack.ts";
import {
	CHANGE_ID_DISPLAY_CHARS,
	COMMIT_ID_DISPLAY_CHARS,
	type InspectModel,
	PLAN_ID_DISPLAY_CHARS,
	type PublicationPlan,
	type StackPublicationOutcome,
	TOOL_CONTENT_MAX_BYTES,
	TOOL_CONTENT_MAX_LINES,
} from "./types.ts";

export function renderInspect(model: InspectModel): string {
	const lines = [
		`Stack: ${model.trunk.revset} → ${model.top ?? "(none)"}`,
		`jj ${model.jjVersion} · ${model.stack.length} change(s)${model.truncated ? " · truncated" : ""}`,
		"",
		"  Bookmark           Change ID     Subject",
	];
	for (const commit of model.stack) {
		const bookmark = commit.bookmarks[0] ?? (commit.workingCopy ? "@" : "—");
		lines.push(
			`  ${pad(bookmark, 18)} ${pad(shortenId(commit.changeId, CHANGE_ID_DISPLAY_CHARS), 12)} ${commit.subject || "(no description)"}`,
		);
	}
	lines.push("", "Blockers:");
	if (model.blockers.length === 0) lines.push("- none");
	else for (const blocker of model.blockers) lines.push(`- [${blocker.code}] ${blocker.message}`);
	return boundText(lines.join("\n"));
}

export function renderPlan(plan: PublicationPlan): string {
	const lines = [
		`Plan ${shortenId(plan.planId, PLAN_ID_DISPLAY_CHARS)}`,
		`Repository: ${plan.repository.owner}/${plan.repository.repo}`,
		`Remote: ${plan.remote.name} (${plan.remote.redactedUrl})`,
		`Default branch: ${plan.defaultBranch}`,
		"",
		"Actions (base → top):",
	];
	if (plan.actions.length === 0) lines.push("- none; stack is already published.");
	for (const action of plan.actions) {
		if (action.kind === "push-bookmark") {
			lines.push(
				`- push ${action.bookmark} ${shortenId(action.localCommitId, COMMIT_ID_DISPLAY_CHARS)} (remote ${action.remoteCommitId ? shortenId(action.remoteCommitId, COMMIT_ID_DISPLAY_CHARS) : "missing"})`,
			);
		} else if (action.kind === "create-draft-pr") {
			lines.push(`- create draft PR ${action.bookmark} → ${action.targetBase}: ${action.provisionalTitle}`);
		} else {
			lines.push(`- repair PR #${action.prNumber} base ${action.currentBase} → ${action.targetBase}`);
		}
	}
	lines.push("", "Navigation comments will be reconciled after core publication.");
	if (plan.blockers.length > 0) {
		lines.push("", "Blockers:");
		for (const blocker of plan.blockers) lines.push(`- [${blocker.code}] ${blocker.message}`);
	}
	return boundText(lines.join("\n"));
}

export function renderConfirmation(plan: PublicationPlan): { ok: true; body: string } | { ok: false; reason: string } {
	const body = renderPlan(plan);
	if (
		plan.actions.some(
			(action) => !body.includes(action.kind === "repair-pr-base" ? `#${action.prNumber}` : action.bookmark),
		)
	) {
		return { ok: false, reason: "The confirmation cannot show every effect-bearing core action." };
	}
	return { ok: true, body };
}

export function renderOutcome(outcome: StackPublicationOutcome): string {
	switch (outcome.status) {
		case "completed":
			return boundText(
				[
					`Published ${outcome.publication.pullRequests.length} PR(s) on ${outcome.publication.remote}.`,
					...outcome.publication.pullRequests.map(
						(pr) => `#${pr.prNumber} ${pr.bookmark} → ${pr.baseBookmark ?? "trunk"} ${pr.url}`,
					),
					...(outcome.commentErrors?.length
						? ["", "Navigation comment errors:", ...outcome.commentErrors.map((error) => `- ${error}`)]
						: []),
				].join("\n"),
			);
		case "blocked":
			return boundText(
				["Publication blocked:", ...outcome.blockers.map((blocker) => `- [${blocker.code}] ${blocker.message}`)].join(
					"\n",
				),
			);
		case "stale":
			return `Plan ${shortenId(outcome.providedPlanId, PLAN_ID_DISPLAY_CHARS)} is stale; recomputed ${shortenId(outcome.recomputedPlanId, PLAN_ID_DISPLAY_CHARS)}. No mutation ran.`;
		case "partial":
			return boundText(
				[
					"Publication stopped after a conclusive failure.",
					...outcome.completedActions.map((action) => `- completed ${action.kind}`),
					`- failed ${outcome.failedAction.kind}: ${outcome.failedAction.error}`,
				].join("\n"),
			);
		case "indeterminate":
			return `Publication is indeterminate: ${outcome.inFlight.kind} ${outcome.inFlight.error}. Capture a fresh plan before retrying.`;
		case "declined":
			return "Publication declined.";
		case "busy":
			return outcome.message;
		case "cancelled":
			return "Publication cancelled before a later action started.";
		case "failed":
			return `Publication failed: ${outcome.error}`;
		default: {
			const _exhaustive: never = outcome;
			return _exhaustive;
		}
	}
}

export function boundText(text: string): string {
	const lines = text.split("\n");
	let truncated = false;
	let body = text;
	if (lines.length > TOOL_CONTENT_MAX_LINES) {
		body = lines.slice(0, TOOL_CONTENT_MAX_LINES).join("\n");
		truncated = true;
	}
	const bytes = Buffer.from(body, "utf8");
	if (bytes.length > TOOL_CONTENT_MAX_BYTES) {
		body = bytes.subarray(0, TOOL_CONTENT_MAX_BYTES).toString("utf8");
		while (Buffer.byteLength(body, "utf8") > TOOL_CONTENT_MAX_BYTES) body = body.slice(0, -1);
		truncated = true;
	}
	return truncated ? `${body}\n\n[truncated; omitted later lines or bytes.]` : body;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}
