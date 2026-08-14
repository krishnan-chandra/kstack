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
