import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CurrentRef } from "../shared/vcs/backend.ts";
import { resolveImplicitPr } from "./pr-resolution.ts";

function refs(kind: CurrentRef["kind"], extra: Partial<CurrentRef> = {}): CurrentRef {
	if (kind === "branch")
		return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			kind,
			name: "kstack/fix-thing",
			...extra,
		} as CurrentRef;
	if (kind === "bookmark")
		return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			kind,
			name: "kstack/fix-thing",
			...extra,
		} as CurrentRef;
	if (kind === "no-bookmark")
		return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			kind,
			changeId: "0123456789abcdef0123456789abcdef01234567",
			...extra,
		} as CurrentRef;
	return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		kind,
		...extra,
	} as CurrentRef;
}

describe("resolveImplicitPr", () => {
	it("returns the explicit PR without probing", async () => {
		let probed = false;
		const result = await resolveImplicitPr({
			explicitPr: 42,
			currentRef: async () => {
				probed = true;
				return { ok: true, ref: refs("branch") };
			},
			findByHead: async () => {
				probed = true;
				return 0;
			},
		});
		assert.deepEqual(result, { ok: true, prNumber: 42 });
		assert.equal(probed, false);
	});

	it("returns the PR found for a branch ref", async () => {
		const result = await resolveImplicitPr({
			currentRef: async () => ({ ok: true, ref: refs("branch") }),
			findByHead: async (ref) => {
				assert.equal(ref, "kstack/fix-thing");
				return 7;
			},
		});
		assert.deepEqual(result, { ok: true, prNumber: 7 });
	});

	it("returns the no-bookmark guidance for a jj change without a bookmark", async () => {
		const result = await resolveImplicitPr({
			currentRef: async () => ({ ok: true, ref: refs("no-bookmark") }),
			findByHead: async () => {
				throw new Error("must not be called");
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.message, /jj bookmark create/);
			assert.match(result.message, /0123456789ab/);
		}
	});

	it("returns the generic guidance for a detached ref", async () => {
		const result = await resolveImplicitPr({
			currentRef: async () => ({ ok: true, ref: refs("detached") }),
			findByHead: async () => {
				throw new Error("must not be called");
			},
		});
		assert.deepEqual(result, {
			ok: false,
			message: "The current VCS state has no branch or bookmark; pass --pr explicitly.",
		});
	});

	it("returns the thrown error text from findByHead", async () => {
		const result = await resolveImplicitPr({
			currentRef: async () => ({ ok: true, ref: refs("branch") }),
			findByHead: async () => {
				throw new Error("no open PR for this head");
			},
		});
		assert.deepEqual(result, { ok: false, message: "no open PR for this head" });
	});

	it("returns the currentRef error verbatim", async () => {
		const result = await resolveImplicitPr({
			currentRef: async () => ({ ok: false, error: "not a repository" }),
			findByHead: async () => {
				throw new Error("must not be called");
			},
		});
		assert.deepEqual(result, { ok: false, message: "not a repository" });
	});
});
