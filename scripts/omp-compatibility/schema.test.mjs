import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { runPackageProbe } from "./probes.mjs";

const ompCheckout = process.env.OMP_CHECKOUT;
const probeTest = ompCheckout ? test : test.skip;

function semanticSchema(value) {
	if (Array.isArray(value)) return value.map(semanticSchema);
	if (!value || Object.prototype.toString.call(value) !== "[object Object]") return value;
	if (
		Array.isArray(value.anyOf) &&
		value.anyOf.every((entry) => Object.prototype.toString.call(entry?.const) === "[object String]")
	) {
		const { anyOf, ...rest } = value;
		return { ...semanticSchema(rest), type: "string", enum: anyOf.map((entry) => entry.const) };
	}
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, semanticSchema(entry)]));
}

probeTest("Pi and OMP schema adapters serialize the required KStack shapes equivalently", async () => {
	const piSchema = Type.Object(
		{
			requiredEnum: Type.Union([Type.Literal("one"), Type.Literal("two")], { description: "Required enum" }),
			optionalEnum: Type.Optional(Type.Union([Type.Literal("one"), Type.Literal("two")])),
			values: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
			count: Type.Integer({ minimum: 1, maximum: 5 }),
		},
		{ additionalProperties: false },
	);
	const probe = await runPackageProbe({ ompCheckout, kind: "schema" });
	assert.equal(probe.result.code, 0, `diagnostics: ${probe.runRoot}\n${probe.result.stderr}`);
	const tool = probe.frames
		.find((frame) => frame.type === "response" && frame.id === "state")
		?.data?.dumpTools?.find((candidate) => candidate.name === "fixture_schema");
	assert.ok(tool, `schema tool missing: ${probe.runRoot}`);
	assert.deepEqual(semanticSchema(tool.parameters), semanticSchema(piSchema));
});
