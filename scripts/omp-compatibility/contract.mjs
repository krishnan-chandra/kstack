import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript-compiler";

const HOST_PACKAGE_RE = /^@(?:earendil-works|mariozechner)\/(pi-ai|pi-coding-agent|pi-tui)$/;
const OMP_PACKAGE_DIR = { "pi-ai": "pi-ai", "pi-coding-agent": "pi-coding-agent", "pi-tui": "pi-tui" };
const SHIM_FILE = {
	"pi-ai": "legacy-pi-ai-shim.ts",
	"pi-coding-agent": "legacy-pi-coding-agent-shim.ts",
	"pi-tui": "legacy-pi-tui-shim.ts",
};
const RENAMED = new Map([["pi-ai:StringEnum", "pi.typebox.Type.Union of literals"]]);

async function matchingFiles(root, accepts) {
	const output = [];
	async function walk(path) {
		const entries = await import("node:fs/promises").then(({ readdir }) => readdir(path, { withFileTypes: true }));
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await walk(child);
			else if (accepts(entry.name)) output.push(child);
		}
	}
	await walk(root);
	return output.sort();
}

function sourceFiles(root) {
	return matchingFiles(root, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

function literalText(node) {
	return ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function collectSourceContract(source, file) {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const imports = [];
	const registrationMethods = new Set();
	const events = new Set();
	const shortcuts = new Set();
	const contextFields = new Set();
	const sessionManagerMethods = new Set();
	const schemaConstructors = new Set();
	function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const packageName = literalText(node.moduleSpecifier);
			const match = packageName?.match(HOST_PACKAGE_RE);
			if (match) {
				const clause = node.importClause;
				if (clause?.name) imports.push({ file, package: match[1], symbol: "default" });
				if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements) {
						imports.push({ file, package: match[1], symbol: (element.propertyName ?? element.name).text });
					}
				}
			}
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const owner = node.expression.expression.getText(tree);
			if (owner === "pi" && method.startsWith("register")) registrationMethods.add(method);
			if (owner === "pi" && method === "on") {
				const event = literalText(node.arguments[0]);
				if (event) events.add(event);
			}
			if (owner === "pi" && method === "registerShortcut") {
				const shortcut = literalText(node.arguments[0]);
				if (shortcut) shortcuts.add(shortcut);
			}
			if (owner === "SessionManager") sessionManagerMethods.add(method);
		}
		if (ts.isPropertyAccessExpression(node)) {
			const owner = node.expression.getText(tree);
			if (["ctx", "context", "commandContext"].includes(owner)) contextFields.add(node.name.text);
			if (["Type", "StringEnum"].includes(owner)) schemaConstructors.add(`${owner}.${node.name.text}`);
		}
		if (ts.isIdentifier(node) && node.text === "StringEnum") schemaConstructors.add("StringEnum");
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return {
		imports,
		registrationMethods: [...registrationMethods],
		events: [...events],
		shortcuts: [...shortcuts],
		contextFields: [...contextFields],
		sessionManagerMethods: [...sessionManagerMethods],
		schemaConstructors: [...schemaConstructors],
	};
}

function exportedNames(rootFile, compilerOptions = {}) {
	const program = ts.createProgram([rootFile], {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true,
		...compilerOptions,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(rootFile);
	if (!source) return new Set();
	const moduleSymbol = checker.getSymbolAtLocation(source);
	return new Set(moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name) : []);
}

export function classifyImport({ package: packageName, symbol }, nativeExports, shimExports) {
	const rename = RENAMED.get(`${packageName}:${symbol}`);
	if (rename) return { status: "renamed", replacement: rename };
	if (nativeExports[packageName]?.has(symbol)) return { status: "native" };
	if (shimExports[packageName]?.has(symbol)) return { status: "compatibility-shim-only" };
	return { status: "missing" };
}

function mergeContracts(contracts) {
	const merged = {
		imports: [],
		registrationMethods: new Set(),
		events: new Set(),
		shortcuts: new Set(),
		contextFields: new Set(),
		sessionManagerMethods: new Set(),
		schemaConstructors: new Set(),
	};
	for (const contract of contracts) {
		merged.imports.push(...contract.imports);
		for (const key of [
			"registrationMethods",
			"events",
			"shortcuts",
			"contextFields",
			"sessionManagerMethods",
			"schemaConstructors",
		]) {
			for (const value of contract[key]) merged[key].add(value);
		}
	}
	for (const key of [
		"registrationMethods",
		"events",
		"shortcuts",
		"contextFields",
		"sessionManagerMethods",
		"schemaConstructors",
	])
		merged[key] = [...merged[key]].sort();
	return merged;
}

function markdownList(values) {
	return values.length ? values.map((value) => `- \`${value}\``).join("\n") : "- None found";
}

export async function generateContractReport({ kstackRoot, ompCheckout, ompRuntimeRoot, outputDir }) {
	const files = [resolve(kstackRoot, "kstack.ts"), ...(await sourceFiles(resolve(kstackRoot, "extensions")))];
	const contracts = [];
	for (const path of files)
		contracts.push(collectSourceContract(await readFile(path, "utf8"), relative(kstackRoot, path)));
	const inventory = mergeContracts(contracts);
	const nativeExports = {};
	const shimExports = {};
	for (const packageName of Object.keys(OMP_PACKAGE_DIR)) {
		nativeExports[packageName] = exportedNames(
			join(ompRuntimeRoot, "node_modules", "@oh-my-pi", OMP_PACKAGE_DIR[packageName], "dist", "types", "index.d.ts"),
		);
		shimExports[packageName] = exportedNames(
			join(ompCheckout, "packages", "coding-agent", "src", "extensibility", SHIM_FILE[packageName]),
			{ allowImportingTsExtensions: true, noEmit: true },
		);
	}
	const classifiedImports = inventory.imports.map((entry) => ({
		...entry,
		...classifyImport(entry, nativeExports, shimExports),
	}));
	const uniqueImports = [
		...new Map(classifiedImports.map((entry) => [`${entry.package}:${entry.symbol}:${entry.status}`, entry])).values(),
	].sort((left, right) => `${left.package}:${left.symbol}`.localeCompare(`${right.package}:${right.symbol}`));
	const cliAssumptions = [];
	for (const root of ["skills", "scripts", "extensions"]) {
		for (const path of await matchingFiles(resolve(kstackRoot, root), (name) => /\.(?:md|mjs|ts)$/.test(name))) {
			const lines = (await readFile(path, "utf8")).split("\n");
			lines.forEach((line, index) => {
				if (/\bpi\b|PI_CODING_AGENT_DIR|\.pi\//.test(line))
					cliAssumptions.push({ file: relative(kstackRoot, path), line: index + 1, text: line.trim().slice(0, 240) });
			});
		}
	}
	const report = {
		generatedAt: new Date().toISOString(),
		...inventory,
		imports: classifiedImports,
		uniqueImports,
		cliAssumptions,
	};
	await mkdir(outputDir, { recursive: true });
	await writeFile(join(outputDir, "omp-contract.json"), `${JSON.stringify(report, null, 2)}\n`);
	const importRows = uniqueImports
		.map(
			(entry) =>
				`| \`${entry.package}\` | \`${entry.symbol}\` | ${entry.status}${entry.replacement ? ` → \`${entry.replacement}\`` : ""} |`,
		)
		.join("\n");
	const markdown = `# OMP Extension Contract Inventory\n\nGenerated from KStack source and OMP's pinned native declarations and legacy shims. Runtime behavior remains probe-required even when a symbol is native.\n\n## Imports\n\n| Package | Symbol | Classification |\n|---|---|---|\n${importRows}\n\n## Registration methods\n\n${markdownList(inventory.registrationMethods)}\n\n## Events\n\n${markdownList(inventory.events)}\n\n## Shortcuts\n\n${markdownList(inventory.shortcuts)}\n\n## Context fields\n\n${markdownList(inventory.contextFields)}\n\n## SessionManager methods\n\n${markdownList(inventory.sessionManagerMethods)}\n\n## Schema constructors\n\n${markdownList(inventory.schemaConstructors)}\n\n## Embedded host CLI and path assumptions\n\n${cliAssumptions.map((entry) => `- \`${entry.file}:${entry.line}\` — \`${entry.text.replaceAll("`", "\\`")}\``).join("\n")}\n`;
	await writeFile(join(outputDir, "omp-contract.md"), markdown);
	return report;
}
