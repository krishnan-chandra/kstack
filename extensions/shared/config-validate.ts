/** Check a finite number against inclusive bounds and an optional integer constraint. */
export function validateBoundedNumber(
	value: unknown,
	rules: { integer?: boolean; min: number; max: number },
): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		(!rules.integer || Number.isInteger(value)) &&
		value >= rules.min &&
		value <= rules.max
	);
}

/** Parse an unknown value or string into a positive safe integer, or undefined if invalid. */
export function parsePositiveInteger(raw: unknown): number | undefined {
	if (raw === undefined || raw === null || raw === "") return undefined;
	const num = typeof raw === "number" ? raw : Number(raw);
	return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}
