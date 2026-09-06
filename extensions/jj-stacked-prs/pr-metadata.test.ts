import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectSliceEvidence,
	documentFromSliceEvidence,
	generateDeterministicPrMetadata,
	type PrMetadataRequest,
} from "./pr-metadata.ts";
import type { ProcessRunner } from "./process.ts";

const genericTemplate = {
	path: ".github/pull_request_template.md",
	source: "<!-- Keep this structure. -->\n\n## Change summary\n\n## Motivation\n\n## Verification",
	requiresConventionalTitle: false,
	minimumDescriptionWords: undefined,
};

const request: PrMetadataRequest = {
	cwd: "/repo",
	bookmark: "feature-two",
	baseRevset: 'bookmarks(exact:"feature-one")',
	subject: "Add profile editing",
};

const evidence = {
	log: "Add profile editing\nValidate profile updates\n",
	names: "src/profile.ts\n",
};
const run: ProcessRunner = async (argv) => {
	assert.ok(argv.includes("--name-only") || argv.includes("log"), "metadata must not collect full patches");
	return { kind: "ok", code: 0, stdout: argv.includes("--name-only") ? evidence.names : evidence.log, stderr: "" };
};

describe("PR metadata evidence", () => {
	it("collects only exact-slice descriptions and paths with bounded commands", async () => {
		const calls: Array<{ argv: string[]; timeoutMs?: number; stdoutCapBytes?: number }> = [];
		const collected = await collectSliceEvidence(async (argv, options) => {
			calls.push({ argv: [...argv], timeoutMs: options?.timeoutMs, stdoutCapBytes: options?.stdoutCapBytes });
			return run(argv, options);
		}, request);
		assert.deepEqual(collected, evidence);
		assert.deepEqual(
			calls.map((call) => call.argv),
			[
				[
					"jj",
					"--no-pager",
					"log",
					"-r",
					'(bookmarks(exact:"feature-one"))..bookmarks(exact:"feature-two")',
					"--no-graph",
					"-T",
					'description ++ "\\n"',
				],
				[
					"jj",
					"--no-pager",
					"diff",
					"--name-only",
					"-r",
					'(bookmarks(exact:"feature-one"))..bookmarks(exact:"feature-two")',
				],
			],
		);
		assert.ok(calls.every((call) => call.timeoutMs === 20_000));
		assert.deepEqual(
			calls.map((call) => call.stdoutCapBytes),
			[32 * 1024, 16 * 1024],
		);
	});

	it("fails instead of generating metadata from truncated evidence", async () => {
		await assert.rejects(
			collectSliceEvidence(
				async () => ({
					kind: "overflow",
					stream: "stdout",
					message: "stdout exceeded cap",
				}),
				request,
			),
			/stdout exceeded cap/,
		);
	});

	for (const [argument, label] of [
		["--name-only", "paths"],
		["log", "log"],
	]) {
		it(`fails on nonzero exit while collecting ${label}`, async () => {
			await assert.rejects(
				collectSliceEvidence(async (argv, options) => {
					if (argv.includes(argument))
						return { kind: "nonzero", code: 1, stdout: "", stderr: "revset error", message: "revset error" };
					return run(argv, options);
				}, request),
				new RegExp(`Could not collect the PR slice ${label}: revset error`),
			);
		});
	}

	it("rejects an empty diff even when the slice contains descriptions", async () => {
		await assert.rejects(
			collectSliceEvidence(async (argv, options) => {
				if (argv.includes("--name-only")) return { kind: "ok", code: 0, stdout: "\n", stderr: "" };
				return run(argv, options);
			}, request),
			/has an empty diff/,
		);
	});

	it("fails when evidence collection times out", async () => {
		await assert.rejects(
			collectSliceEvidence(
				async () => ({
					kind: "timeout",
					message: "process timed out after 20000ms",
					stdout: "",
					stderr: "",
				}),
				request,
			),
			/process timed out after 20000ms/,
		);
	});

	it("aborts a sibling command when evidence collection fails", async () => {
		let siblingAborted = false;
		await assert.rejects(
			collectSliceEvidence(async (argv, options) => {
				if (argv.includes("log"))
					return { kind: "nonzero", code: 1, stdout: "", stderr: "log failed", message: "log failed" };
				return new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							siblingAborted = true;
							resolve({ kind: "cancelled", message: "aborted", stdout: "", stderr: "" });
						},
						{ once: true },
					);
				});
			}, request),
			/log failed/,
		);
		assert.equal(siblingAborted, true);
	});
});

describe("deterministic PR metadata", () => {
	it("preserves the first word of multiline commit descriptions", () => {
		const doc = documentFromSliceEvidence(request, {
			log: "Add profile editing\n\nPreserve archived sessions.\nKeep exact byte offsets.\n",
			names: "src/profile.ts\n",
		});
		assert.deepEqual(doc.summaryBullets, [
			"Add profile editing",
			"Preserve archived sessions",
			"Keep exact byte offsets",
		]);
	});
	it("builds a write-pr document from subject, log, and changed paths", () => {
		const doc = documentFromSliceEvidence(request, {
			log: "Add JWT token verification\nCover verifier edge cases\n",
			names: "extensions/auth/jwt.ts\nextensions/auth/verifier.ts\nextensions/auth/jwt.test.ts\n",
		});
		assert.equal(doc.title, "Add profile editing");
		assert.ok(doc.summaryBullets.includes("Add JWT token verification"));
		assert.equal(doc.reviewSteps[0]?.label, "extensions/auth");
	});

	it("generates canonical markdown without a model or full patch", async () => {
		const metadata = await generateDeterministicPrMetadata(run, request);
		assert.equal(metadata.title, "Add profile editing");
		assert.match(metadata.body, /^## Summary\n\n- /);
		assert.match(metadata.body, /## Review guide\n\n1\. \*\*/);
	});

	it("generates deterministic metadata inside a repository template", async () => {
		const metadata = await generateDeterministicPrMetadata(run, { ...request, repositoryTemplate: genericTemplate });
		assert.match(metadata.body, /^<!-- Keep this structure\. -->/);
		assert.match(metadata.body, /## Change summary[\s\S]*\*\*Review guide\*\*/);
		assert.match(metadata.body, /## Motivation\n\n\S/);
		assert.match(metadata.body, /## Verification\n\n\S/);
	});
});
