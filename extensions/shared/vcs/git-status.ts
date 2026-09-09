/**
 * Decode Git's NUL-delimited `status --porcelain=v1 -z` records.
 *
 * Porcelain v1 `-z` is a record stream, not a list of independent paths. Each
 * ordinary entry is `XY<space><path>\0`. `XY` is the two-character index and
 * worktree code; the third byte is the separator space, so a real field is at
 * least four bytes. Rename and copy records add a second NUL-terminated field
 * immediately after the destination: `XY<space><destination>\0<source>\0`,
 * whether R/C is in the index column (`R `, `C `) or the worktree column
 * (` R`, ` C`). The parser consumes that source field in the same iteration so
 * it is not treated as a new `XY` entry. A trailing NUL from Git becomes an empty
 * split leftover and is skipped.
 */

interface GitStatusRecord {
	xy: string;
	path: string;
	origPath?: string;
}

function isRenameOrCopy(xy: string): boolean {
	return xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C";
}

export function parseGitStatus(stdout: string): GitStatusRecord[] {
	const records: GitStatusRecord[] = [];
	const fields = stdout.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const xy = field.slice(0, 2);
		const path = field.slice(3);
		if (!path) continue;
		if (isRenameOrCopy(xy)) {
			index += 1;
			const origPath = fields[index];
			records.push(origPath ? { xy, path, origPath } : { xy, path });
		} else {
			records.push({ xy, path });
		}
	}
	return records;
}

export function gitStatusChangedPaths(stdout: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (path: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};
	for (const record of parseGitStatus(stdout)) {
		add(record.path);
		if (record.origPath !== undefined) add(record.origPath);
	}
	return paths;
}
