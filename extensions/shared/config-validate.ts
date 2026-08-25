import { type BoundaryValue, isNumber } from "./validation.ts";
/** Check a finite number against inclusive bounds and an optional integer constraint. */
export function validateBoundedNumber(
	value: BoundaryValue,
	rules: { integer?: boolean; min: number; max: number },
): value is number {
	return (
		isNumber(value) &&
		Number.isFinite(value) &&
		(!rules.integer || Number.isInteger(value)) &&
		value >= rules.min &&
		value <= rules.max
	);
}

/** Parse an unknown value or string into a positive safe integer, or undefined if invalid. */
export function parsePositiveInteger(raw: BoundaryValue): number | undefined {
	if (raw === undefined || raw === null || raw === "") return undefined;
	const num = isNumber(raw) ? raw : Number(raw);
	return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}
