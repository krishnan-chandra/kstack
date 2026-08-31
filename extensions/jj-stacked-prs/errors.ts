import { GitHubError } from "../shared/github.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { JjError } from "./jj.ts";
import { NativeStackError } from "./native-stack.ts";

export function isIndeterminate(error: BoundaryValue): boolean {
	return (
		(error instanceof JjError || error instanceof GitHubError || error instanceof NativeStackError) &&
		error.kind === "indeterminate"
	);
}

export function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}
