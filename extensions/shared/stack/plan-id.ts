import { createHash } from "node:crypto";
import { isRecord } from "../narrow.ts";
import { type BoundaryValue, isBoolean, isNumber, isString } from "../validation.ts";

function canonicalJson(value: BoundaryValue): string {
	if (value === null || isString(value) || isBoolean(value)) return JSON.stringify(value);
	if (isNumber(value)) return JSON.stringify(value);
	if (Object.prototype.toString.call(value) === "[object Number]") {
		throw new TypeError("Plan facts must contain only finite numbers.");
	}
	if (value === undefined) throw new TypeError("Plan facts must not contain undefined values.");
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (!Object.hasOwn(value, index)) throw new TypeError("Plan facts must not contain undefined array entries.");
		}
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (!isRecord(value)) throw new TypeError("Plan facts must be JSON values.");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError("Plan facts must be plain JSON objects.");
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(Object.getOwnPropertyDescriptor(value, key)?.value)}`)
		.join(",")}}`;
}

/** Hash canonical JSON facts. A plan ID proves freshness, never authorization. */
export function planIdFor(version: number, facts: BoundaryValue): string {
	if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("Plan ID version must be a positive integer.");
	return createHash("sha256")
		.update(`${version}:${canonicalJson(facts)}`)
		.digest("hex");
}
