type GitExec = (args: string[], cwd: string) => string;

/** Prefix Git arguments with `--no-replace-objects` to read immutable pinned objects. */
export function pinnedGitArgs(args: string[]): string[] {
	if (args[0] === "--no-replace-objects") return args;
	return ["--no-replace-objects", ...args];
}

/** Apply immutable-object semantics once at a pinned review boundary. */
export function pinnedGitExec(exec: GitExec): GitExec {
	return (args, cwd) => exec(pinnedGitArgs(args), cwd);
}
