import type { GitHubGateway, GitHubRepository } from "../github.ts";
import type { CompletedPublicationAction } from "./outcome.ts";

type PrIdentity = { ref: string; prNumber?: number; url?: string; draft: boolean };

/** Keep successful mutations, caller-owned row updates, and completion accounting together. */
export function createPrTransitions(input: {
	repository: GitHubRepository;
	cwd: string;
	signal?: AbortSignal;
	gateway: Pick<GitHubGateway, "createDraftPr" | "markPrReady">;
	completed(action: CompletedPublicationAction): void;
}) {
	const { repository, cwd, signal, gateway, completed } = input;
	return {
		async create(request: { row: PrIdentity; base: string; title: string; body: string }) {
			const { row, base, title, body } = request;
			const created = await gateway.createDraftPr({ repo: repository, ref: row.ref, base, title, body, cwd, signal });
			row.prNumber = created.number;
			row.url = created.url;
			row.draft = created.draft;
			completed({ kind: "create-draft-pr", ref: row.ref, prNumber: created.number, url: created.url });
			return created;
		},
		async ready(row: PrIdentity): Promise<void> {
			const { prNumber, ref } = row;
			if (prNumber === undefined) throw new Error(`No proven PR number exists for ${JSON.stringify(ref)}.`);
			if (!row.draft) return;
			await gateway.markPrReady(repository, prNumber, cwd, signal);
			row.draft = false;
			completed({ kind: "mark-pr-ready", ref, prNumber });
		},
	};
}
