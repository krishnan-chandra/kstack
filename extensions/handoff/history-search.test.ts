import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assistantMessage,
	messageEntry,
	sessionJsonl,
	toolCallMessage,
	toolResultMessage,
	userMessage,
} from "../session-archive/test-helpers.ts";
import type { JsonObject } from "../shared/validation.ts";
import { readHandoffHistory } from "./history-reader.ts";
import { searchHandoffHistory } from "./history-search.ts";
import { archiveAndRemoveActive, archiveOversized, useHandoffFixtures } from "./test-helpers.ts";

const fixture = useHandoffFixtures();

function chain(messages: JsonObject[]): string {
	return sessionJsonl(messages.map((message, i) => messageEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, message)));
}

function caseSearchFixture() {
	return fixture(
		chain([
			userMessage("SQLite records HEAD and API with a Mixed Case Phrase."),
			assistantMessage("Unicode marker: Überprüfung."),
			userMessage("Later SQLite and API result keeps OriginalCase."),
			assistantMessage("API-only tail marker."),
		]),
	);
}

function semanticsContent(): string {
	return chain([
		userMessage("Plan the handoff outline for extensions/handoff/index.ts using --archive when oversized."),
		toolCallMessage(
			[{ id: "c1", name: "edit", arguments: { path: "/Users/test/Code/project/src/only-in-args.ts", edits: [] } }],
			"Editing now.",
		),
		toolResultMessage("c1", "edit", "ok"),
		toolCallMessage([{ id: "c2", name: "read", arguments: { path: "big.log" } }]),
		toolResultMessage("c2", "read", `${"a".repeat(10_000)} needle-in-output ${"b".repeat(10_000)}`),
		...Array.from({ length: 6 }, (_, i) => userMessage(`repeat marker ${i}`)),
		assistantMessage("Keep the exact phrase alpha beta together."),
	]);
}

function ordinals(output: string): number[] {
	return [...output.matchAll(/^#(\d+) \[/gmu)].map((match) => Number(match[1]));
}

function searcher(content: string) {
	const { source, env } = fixture(content);
	return (query: string, limit?: number) => searchHandoffHistory(source, { query, limit }, env);
}

describe("searchHandoffHistory", () => {
	it("uses substring, path, punctuation, phrase, and newest-first semantics, identically after archival", () => {
		const { tree, content, source, env } = fixture(semanticsContent());
		const queries: [string, number?][] = [
			["hand"],
			["extensions/handoff/index.ts"],
			["--archive"],
			['"alpha beta"'],
			['"beta alpha"'],
			["repeat marker", 2],
			["only-in-args.ts"],
		];
		const run = () => queries.map(([query, limit]) => searchHandoffHistory(source, { query, limit }, env));
		const outputs = run();

		assert.deepEqual(ordinals(outputs[0]), [0]);
		assert.deepEqual(ordinals(outputs[1]), [0]);
		assert.deepEqual(ordinals(outputs[2]), [0]);
		assert.deepEqual(ordinals(outputs[3]), [11]);
		assert.match(outputs[4], /^No matches in active previous session/u);
		assert.deepEqual(ordinals(outputs[5]), [9, 10]);
		assert.match(outputs[5], /6 total; showing the newest 2 in session order/u);
		assert.deepEqual(ordinals(outputs[6]), [1]);
		assert.match(outputs[6], /^ {2}→ edit \/Users\/test\/Code\/project\/src\/only-in-args\.ts$/mu);

		archiveAndRemoveActive(tree, content, source);
		assert.deepEqual(
			run(),
			outputs.map((output) => output.replace("in active previous session", "in archived previous session")),
		);
	});

	it("bounds a hit in a large tool result to a snippet", () => {
		const output = searcher(semanticsContent())("needle-in-output");
		const hit = output.split("\n\n").at(-1) ?? "";
		assert.match(hit, /^#4 \[message\/toolResult\]/u);
		assert.match(hit, /…a+ needle-in-output b+…/u);
		assert.ok(Buffer.byteLength(hit) <= 1024, `hit is ${Buffer.byteLength(hit)} bytes`);
		assert.match(output, /read_handoff_history\(\{ view: "entries", offset: <#>, limit: 1 \}\)/u);
	});

	it("keeps the matched term in snippets with CJK and emoji context", () => {
		const content = chain([
			userMessage(`${"前".repeat(120)}needle${"後".repeat(120)}`),
			assistantMessage(`${"🙂".repeat(120)} needle ${"🎉".repeat(120)}`),
			toolCallMessage([{ id: "c1", name: "read", arguments: { path: `${"深".repeat(80)}/needle.ts` } }]),
		]);
		const output = searcher(content)("needle");
		assert.deepEqual(ordinals(output), [0, 1, 2]);
		const hits = output.split("\n\n").slice(1);
		assert.equal(hits.length, 3);
		for (const hit of hits) {
			assert.ok(Buffer.byteLength(hit) <= 1024, `hit is ${Buffer.byteLength(hit)} bytes`);
			const excerpts = hit.split("\n").slice(1);
			assert.ok(excerpts.length > 0);
			for (const excerpt of excerpts) assert.ok(excerpt.includes("needle"), excerpt);
			assert.ok(!hit.includes("\uFFFD"));
		}
		assert.match(hits[0], /^ {2}…前+needle後+…$/mu);
		assert.match(hits[1], /^ {2}…🙂+ needle 🎉+…$/mu);
		assert.match(hits[2], /^ {2}→ read …深+\/needle\.ts$/mu);
	});

	it("keeps the head of a match too large for the snippet budget", () => {
		const phrase = "x".repeat(400);
		const [, hit] = searcher(chain([userMessage(`before ${phrase} after`)]))(`"${phrase}"`).split("\n\n");
		const excerpt = hit.split("\n")[1];
		assert.match(excerpt, /^ {2}…x+…$/u);
		assert.ok(Buffer.byteLength(excerpt) <= 262);
	});

	it("matches technical identifiers and a quoted phrase regardless of query case before and after archival", () => {
		const { tree, content, source, env } = caseSearchFixture();
		const queries = [
			"SQLITE",
			"sqlite",
			"SqLiTe",
			"HEAD",
			"head",
			"HeAd",
			"API",
			"api",
			"aPi",
			'"MIXED CASE PHRASE"',
			'"mixed case phrase"',
			'"MiXeD CaSe PhRaSe"',
		];
		for (const query of queries) {
			assert.match(searchHandoffHistory(source, { query }, env), /Matches in active previous session/);
		}

		archiveAndRemoveActive(tree, content, source);
		for (const query of queries) {
			assert.match(searchHandoffHistory(source, { query }, env), /Matches in archived previous session/);
		}
	});

	it("matches non-ASCII upper and lower case without changing result text", () => {
		const { source, env } = caseSearchFixture();

		for (const query of ["ÜBERPRÜFUNG", "überprüfung"]) {
			const output = searchHandoffHistory(source, { query }, env);
			assert.match(output, /Unicode marker: Überprüfung\./);
		}
	});

	it("preserves AND, no-match, role, and tail-limit behavior", () => {
		const { source, env } = caseSearchFixture();

		const latestUserMatch = searchHandoffHistory(source, { query: "SQLITE api", role: "user", limit: 1 }, env);
		assert.match(latestUserMatch, /Later SQLite and API result keeps OriginalCase\./);
		assert.doesNotMatch(latestUserMatch, /Mixed Case Phrase/);

		const assistantMatch = searchHandoffHistory(source, { query: "api", role: "assistant" }, env);
		assert.match(assistantMatch, /API-only tail marker\./);
		assert.doesNotMatch(assistantMatch, /OriginalCase/);

		assert.match(
			searchHandoffHistory(source, { query: "sqlite absent" }, env),
			/No matches in active previous session/,
		);
	});

	it("rejects empty queries and empty quoted phrases", () => {
		const { source, env } = fixture();
		assert.throws(() => searchHandoffHistory(source, { query: "  " }, env), /must not be empty/);
		assert.throws(() => searchHandoffHistory(source, { query: '""' }, env), /at least one word or quoted phrase/);
	});

	it("uses ranked FTS search with expandable ordinals for an oversized archive", () => {
		const content = semanticsContent();
		const { tree, source, env } = fixture(content);
		archiveOversized(tree, content, source);

		const tokenMiss = searchHandoffHistory(source, { query: "hand" }, env);
		const hit = searchHandoffHistory(source, { query: '"alpha beta"' }, env);

		assert.match(tokenMiss, /^No matches in oversized archived previous session/u);
		assert.match(hit, /Oversized archive: FTS token matching, ranked; expand with view: "entries", offset: <#>\./u);
		assert.deepEqual(ordinals(hit), [11]);
		const expanded = readHandoffHistory(source, { view: "entries", offset: 11, limit: 1 }, env);
		assert.match(expanded, /^#11 \[message\/assistant\][^\n]*\nKeep the exact phrase alpha beta together\./mu);
	});
});
