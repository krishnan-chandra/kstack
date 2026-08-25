import { type BoundaryValue, isObject, type JsonObject } from "./validation.ts";
/** Narrowing helpers for untrusted JSON and event payloads. */

export function isRecord(value: BoundaryValue): value is JsonObject {
	return isObject(value) && value !== null && !Array.isArray(value);
}

export function asRecord(value: BoundaryValue): JsonObject | undefined {
	return isRecord(value) ? value : undefined;
}
