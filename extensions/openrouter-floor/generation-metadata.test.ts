import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthResult } from "@earendil-works/pi-ai";
import { lookupGenerationTier, type MetadataFetch, type MetadataResponse } from "./generation-metadata.ts";

function response(body: string, status = 200, headers?: Readonly<Record<string, string>>): MetadataResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers,
		text: async () => body,
	};
}

function auth(overrides: Partial<AuthResult["auth"]> = {}): AuthResult {
	return {
		auth: {
			apiKey: "secret-key",
			baseUrl: "https://router.example/api/v1",
			...overrides,
		},
	};
}

describe("lookupGenerationTier", () => {
	it("uses the authenticated configured origin and normalizes a known tier", async () => {
		let requestUrl = "";
		let requestHeaders: Readonly<Record<string, string>> | undefined;
		const fetcher: MetadataFetch = async (url, init) => {
			requestUrl = url;
			requestHeaders = init.headers;
			assert.equal(init.redirect, "error");
			return response('{"data":{"service_tier":"FLEX"}}');
		};

		const result = await lookupGenerationTier("gen/123", async () => auth(), { fetch: fetcher });
		assert.deepEqual(result, { kind: "known", tier: "flex" });
		assert.equal(requestUrl, "https://router.example/api/v1/generation?id=gen%2F123");
		assert.equal(requestHeaders?.Authorization, "Bearer secret-key");
	});

	it("preserves provider auth headers and makes null or future tiers unknown", async () => {
		let calls = 0;
		const fetcher: MetadataFetch = async (_url, init) => {
			calls += 1;
			assert.equal(init.headers["x-custom"], "value");
			assert.equal(init.headers.Authorization, undefined);
			return response('{"data":{"service_tier":null}}');
		};
		const result = await lookupGenerationTier(
			"gen-123",
			async () => auth({ apiKey: undefined, headers: { "x-custom": "value", authorization: null } }),
			{ fetch: fetcher },
		);
		assert.deepEqual(result, { kind: "unknown", reason: "null-or-unrecognized-tier" });
		assert.equal(calls, 1);
	});

	it("retries transient failures within the bounded attempt budget", async () => {
		let calls = 0;
		const fetcher: MetadataFetch = async () => {
			calls += 1;
			return calls === 1 ? response("busy", 503) : response('{"data":{"service_tier":"default"}}');
		};
		const result = await lookupGenerationTier("gen-123", async () => auth(), {
			fetch: fetcher,
			retryDelayMs: 0,
		});
		assert.deepEqual(result, { kind: "known", tier: "default" });
		assert.equal(calls, 2);
	});

	it("does not make a request without an authenticated header", async () => {
		let calls = 0;
		const fetcher: MetadataFetch = async () => {
			calls += 1;
			return response('{"data":{"service_tier":"flex"}}');
		};
		const result = await lookupGenerationTier("gen-123", async () => auth({ apiKey: undefined }), { fetch: fetcher });
		assert.deepEqual(result, { kind: "unknown", reason: "lookup-failed" });
		assert.equal(calls, 0);
	});

	it("rejects malformed provider responses", async () => {
		const result = await lookupGenerationTier("gen-123", async () => auth(), {
			fetch: async () => response("not-json"),
		});
		assert.deepEqual(result, { kind: "unknown", reason: "invalid-response" });
	});
});
