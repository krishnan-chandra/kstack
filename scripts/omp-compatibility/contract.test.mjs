import assert from "node:assert/strict";
import test from "node:test";
import { classifyImport, collectSourceContract } from "./contract.mjs";

test("contract inventory uses the TypeScript AST for imports and registrations", () => {
	const contract = collectSourceContract(
		`import { Type, MissingThing as Alias } from "@earendil-works/pi-ai";
export function register(pi, ctx) {
	pi.registerCommand("demo", {});
	pi.on("session_start", () => ctx.hasUI);
	pi.registerShortcut("ctrl+shift+k", {});
	SessionManager.listAll();
	return Type.Object({});
}`,
		"fixture.ts",
	);
	assert.deepEqual(contract.imports, [
		{ file: "fixture.ts", package: "pi-ai", symbol: "Type" },
		{ file: "fixture.ts", package: "pi-ai", symbol: "MissingThing" },
	]);
	assert.deepEqual(contract.registrationMethods, ["registerCommand", "registerShortcut"]);
	assert.deepEqual(contract.events, ["session_start"]);
	assert.deepEqual(contract.shortcuts, ["ctrl+shift+k"]);
	assert.deepEqual(contract.contextFields, ["hasUI"]);
	assert.deepEqual(contract.sessionManagerMethods, ["listAll"]);
});

test("a symbol absent from native declarations and the compatibility shim is missing", () => {
	const nativeExports = { "pi-ai": new Set(["Type"]) };
	const shimExports = { "pi-ai": new Set(["StringEnum"]) };
	assert.deepEqual(classifyImport({ package: "pi-ai", symbol: "NotAnExport" }, nativeExports, shimExports), {
		status: "missing",
	});
	assert.deepEqual(classifyImport({ package: "pi-ai", symbol: "Type" }, nativeExports, shimExports), {
		status: "native",
	});
});
