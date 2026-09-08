import type { AuthResult } from "@earendil-works/pi-ai";
import { isRecord } from "../shared/narrow.ts";
import { type BoundaryValue, isString } from "../shared/validation.ts";
import type { ServiceTier, UnknownReason } from "./floor-ledger.ts";

export type MetadataTierResult =
	| { kind: "known"; tier: Exclude<ServiceTier, "unknown"> }
	| { kind: "unknown"; reason: Exclude<UnknownReason, "pending" | "no-response-id"> };

export interface MetadataResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	text(): Promise<string>;
}

interface MetadataRequestInit {
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: "error";
	readonly signal: AbortSignal;
}

export type MetadataFetch = (url: string, init: MetadataRequestInit) => Promise<MetadataResponse>;
export type AuthResolver = () => Promise<AuthResult | undefined>;

export interface MetadataLookupOptions {
	fetch?: MetadataFetch;
	timeoutMs?: number;
	maxAttempts?: number;
	retryDelayMs?: number;
	signal?: AbortSignal;
	sleep?: (milliseconds: number) => Promise<void>;
	onDiagnostic?: (diagnostic: string) => void;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RESPONSE_BYTES = 64 * 1024;

const defaultFetch: MetadataFetch = async (url, init) => {
	const response = await fetch(url, init);
	const contentLength = response.headers.get("content-length");
	const headers = contentLength === null ? undefined : { "content-length": contentLength };
	return {
		ok: response.ok,
		status: response.status,
		headers,
		text: () => response.text(),
	};
};

function diagnostic(onDiagnostic: (diagnostic: string) => void, message: string): void {
	try {
		onDiagnostic(message);
	} catch {
		// Diagnostics must never affect provider traffic or completion handling.
	}
}

function sleepFor(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
	return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function requestHeaders(auth: AuthResult): Readonly<Record<string, string>> | undefined {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
		if (value !== null) headers[name] = value;
	}
	if (!hasAuthorizationHeader(headers) && auth.auth.apiKey !== undefined && auth.auth.apiKey.length > 0) {
		headers.Authorization = `Bearer ${auth.auth.apiKey}`;
	}
	if (Object.keys(headers).length === 0) return undefined;
	return headers;
}

function generationUrl(auth: AuthResult, responseId: string): string | undefined {
	const baseUrl = auth.auth.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
	try {
		const url = new URL("generation", `${baseUrl.replace(/\/+$/, "")}/`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		if (url.username !== "" || url.password !== "") return undefined;
		url.searchParams.set("id", responseId);
		return url.toString();
	} catch {
		return undefined;
	}
}

function normalizeTier(value: BoundaryValue): MetadataTierResult {
	if (!isString(value)) return { kind: "unknown", reason: "null-or-unrecognized-tier" };
	const normalized = value.toLowerCase();
	if (normalized === "flex" || normalized === "default" || normalized === "priority") {
		return { kind: "known", tier: normalized };
	}
	return { kind: "unknown", reason: "null-or-unrecognized-tier" };
}

async function responseTier(response: MetadataResponse): Promise<MetadataTierResult> {
	const contentLength = response.headers?.["content-length"] ?? response.headers?.["Content-Length"];
	if (contentLength !== undefined && Number(contentLength) > MAX_RESPONSE_BYTES) {
		return { kind: "unknown", reason: "invalid-response" };
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { kind: "unknown", reason: "invalid-response" };
	}
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return { kind: "unknown", reason: "invalid-response" };

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "unknown", reason: "invalid-response" };
	}
	if (!isRecord(value) || !isRecord(value.data) || !("service_tier" in value.data)) {
		return { kind: "unknown", reason: "invalid-response" };
	}
	return normalizeTier(value.data.service_tier);
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export async function lookupGenerationTier(
	responseId: string,
	authResolver: AuthResolver,
	options: MetadataLookupOptions = {},
): Promise<MetadataTierResult> {
	const onDiagnostic = options.onDiagnostic ?? (() => {});
	let auth: AuthResult | undefined;
	try {
		auth = await authResolver();
	} catch {
		diagnostic(onDiagnostic, "generation lookup failed: auth resolution");
		return { kind: "unknown", reason: "lookup-failed" };
	}
	if (auth === undefined) return { kind: "unknown", reason: "lookup-failed" };
	const headers = requestHeaders(auth);
	const url = generationUrl(auth, responseId);
	if (headers === undefined || url === undefined) {
		diagnostic(onDiagnostic, "generation lookup failed: incomplete auth or origin");
		return { kind: "unknown", reason: "lookup-failed" };
	}

	const fetcher = options.fetch ?? defaultFetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? sleepFor;
	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	options.signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return { kind: "unknown", reason: "lookup-failed" };
			try {
				const response = await fetcher(url, { headers, redirect: "error", signal: controller.signal });
				if (response.ok) return await responseTier(response);
				if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
					diagnostic(onDiagnostic, `generation lookup failed: HTTP ${response.status}`);
					return { kind: "unknown", reason: "lookup-failed" };
				}
			} catch {
				if (controller.signal.aborted || attempt === maxAttempts) {
					diagnostic(onDiagnostic, "generation lookup failed: request");
					return { kind: "unknown", reason: "lookup-failed" };
				}
			}
			if (attempt < maxAttempts) await sleep(retryDelayMs);
		}
		return { kind: "unknown", reason: "lookup-failed" };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromParent);
	}
}
