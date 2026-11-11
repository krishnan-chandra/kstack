import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

/** Compare a backend-reported cwd with an expected one; a missing report never matches. */
export function sameCwd(reported: string | undefined, expected: string): boolean {
	return reported !== undefined && reported !== "" && canonicalCwd(reported) === canonicalCwd(expected);
}
