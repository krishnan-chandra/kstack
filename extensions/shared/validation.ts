import { Type } from "typebox";
import { Check } from "typebox/value";

/** A value at an external boundary that must be decoded before domain use. */
export type BoundaryValue = ReturnType<<T>(value: T) => T>;

type JsonValue = string | number | boolean | null | undefined | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

const booleanSchema = Type.Boolean();
const functionSchema = Type.Function([], Type.Unknown());
const numberSchema = Type.Number();
const objectSchema = Type.Union([Type.Object({}, { additionalProperties: true }), Type.Array(Type.Unknown())]);
const stringSchema = Type.String();

export function isBoolean(value: BoundaryValue): value is boolean {
	return Check(booleanSchema, value);
}

export function isFunction(value: BoundaryValue): value is (...args: BoundaryValue[]) => BoundaryValue {
	return Check(functionSchema, value);
}

export function isNumber(value: BoundaryValue): value is number {
	return Check(numberSchema, value);
}

export function isObject(value: BoundaryValue): value is object {
	return Check(objectSchema, value);
}

export function isString(value: BoundaryValue): value is string {
	return Check(stringSchema, value);
}
