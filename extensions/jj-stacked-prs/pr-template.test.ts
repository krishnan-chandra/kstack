import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	discoverRepositoryPrTemplate,
	renderRepositoryPrTemplate,
	validatePrMetadataAgainstTemplate,
} from "./pr-template.ts";

const genericTemplate = `<!-- Follow the repository title convention. -->

## Change summary
<!-- Explain the change. -->

## Motivation
<!-- Explain why the change is needed. -->

## Verification
<!-- List automated or manual checks. -->
`;

function fixture(source = genericTemplate) {
	const cwd = mkdtempSync(join(tmpdir(), "kstack-pr-template-"));
	mkdirSync(join(cwd, ".github"));
	writeFileSync(join(cwd, ".github", "pull_request_template.md"), source);
	return cwd;
}

function document(title = "Improve pull request validation") {
	return {
		title,
		summaryBullets: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [
			"Use the repository pull-request template.",
		] as [string],
		reviewSteps: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [
			{ label: "Publication", description: "Verify template conformance before mutation." },
		] as [{ label: string; description: string }],
	};
}

describe("repository PR templates", () => {
	it("discovers and canonicalizes a CRLF template", () => {
		const cwd = fixture(genericTemplate.replaceAll("\n", "\r\n"));
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			assert.equal(template.source.includes("\r"), false);
			const metadata = renderRepositoryPrTemplate(document(), template);
			validatePrMetadataAgainstTemplate(metadata, template);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("enforces recognizable repository title rules", () => {
		const cwd = fixture(
			`<!-- Use Conventional Commits. Require at least three words after the colon. -->\n\n## Change summary\n`,
		);
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			assert.equal(template.requiresConventionalTitle, true);
			assert.equal(template.minimumDescriptionWords, 3);
			const valid = renderRepositoryPrTemplate(document("fix(pr): preserve repository templates"), template);
			assert.throws(
				() => validatePrMetadataAgainstTemplate({ ...valid, title: "Preserve repository templates" }, template),
				/Conventional Commits/,
			);
			assert.throws(
				() => validatePrMetadataAgainstTemplate({ ...valid, title: "fix: templates" }, template),
				/at least 3 words/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("renders content into every recognized heading", () => {
		const cwd = fixture(`## Summary\n\n### What changed?\n\n## Motivation\n\n## Verification\n`);
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			const metadata = renderRepositoryPrTemplate(document(), template);
			assert.match(metadata.body, /## Summary\n\n\S/);
			assert.match(metadata.body, /### What changed\?\n\n\S/);
			validatePrMetadataAgainstTemplate(metadata, template);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("treats completed checklist items as substantive section content", () => {
		const cwd = fixture(`## Verification\n\n- [x] Unit tests pass\n`);
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			validatePrMetadataAgainstTemplate(
				{ title: "Verify templates", body: `## Verification\n\n- [x] Unit tests pass` },
				template,
			);
			const unchecked = { ...template, source: `## Verification\n\n- [ ] Unit tests pass\n` };
			assert.throws(
				() =>
					validatePrMetadataAgainstTemplate(
						{ title: "Verify templates", body: `## Verification\n\n- [ ] Unit tests pass` },
						unchecked,
					),
				/empty/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("classifies what-problem and motivation headings as rationale", () => {
		const cwd = fixture(
			`## Change summary\n\n## What problem does this solve?\n\n## What's the motivation?\n\n## Verification\n`,
		);
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			const metadata = renderRepositoryPrTemplate(document(), template);
			const summaryEnd = metadata.body.indexOf("## What problem");
			assert.equal(metadata.body.slice(summaryEnd).includes("**Review guide**"), false);
			assert.match(metadata.body, /## What problem does this solve\?\n\nThis PR keeps/);
			assert.match(metadata.body, /## What's the motivation\?\n\nThis PR keeps/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ignores template-looking headings inside fenced examples", () => {
		const cwd = fixture(`## Change summary\n\n\`\`\`markdown\n### Example heading\n\`\`\`\n\n## Verification\n`);
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			const body = `## Change summary\n\nA real change.\n\n## Verification\n\n- Unit tests.`;
			validatePrMetadataAgainstTemplate({ title: "Validate templates", body }, template);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unclosed HTML comments", () => {
		const cwd = fixture(`## Change summary\n<!-- never closed\n## Verification\n`);
		try {
			assert.throws(() => discoverRepositoryPrTemplate(cwd), /unclosed HTML comment/i);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("supports a symlinked default template", () => {
		const cwd = mkdtempSync(join(tmpdir(), "kstack-pr-template-"));
		try {
			mkdirSync(join(cwd, ".github"));
			writeFileSync(join(cwd, "shared-template.md"), genericTemplate);
			symlinkSync(join(cwd, "shared-template.md"), join(cwd, ".github", "pull_request_template.md"));
			assert.ok(discoverRepositoryPrTemplate(cwd));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects missing, reordered, and empty required template content", () => {
		const cwd = fixture();
		try {
			const template = discoverRepositoryPrTemplate(cwd);
			assert.ok(template);
			assert.throws(
				() => validatePrMetadataAgainstTemplate({ title: "Fix template", body: "## Change summary" }, template),
				/required template fragment/,
			);
			const valid = renderRepositoryPrTemplate(document(), template);
			const reordered = valid.body.replace(/(## Motivation[\s\S]*?)(## Verification[\s\S]*)$/, "$2\n\n$1");
			assert.throws(
				() => validatePrMetadataAgainstTemplate({ title: valid.title, body: reordered }, template),
				/in order/,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("refuses ambiguous selectable templates", () => {
		const cwd = fixture();
		try {
			mkdirSync(join(cwd, ".github", "PULL_REQUEST_TEMPLATE"));
			writeFileSync(join(cwd, ".github", "PULL_REQUEST_TEMPLATE", "bug.md"), "## Bug");
			assert.throws(() => discoverRepositoryPrTemplate(cwd), /Multiple pull-request templates/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
