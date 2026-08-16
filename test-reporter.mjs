/**
 * Quiet test reporter for Node.js test runner.
 *
 * Suppresses passing test noise and reports only failures with location,
 * error message, and stack trace, followed by a one-line summary.
 */

export default async function* quietReporter(source) {
	for await (const event of source) {
		if (event.type === "test:stderr") {
			yield event.data.message;
		} else if (event.type === "test:fail") {
			const data = event.data;
			if (data.details?.type === "suite" && data.details?.error?.failureType === "subtestsFailed") {
				continue;
			}
			const loc = data.file ? ` (${data.file}:${data.line || 1}:${data.column || 1})` : "";
			yield `\n✖ ${data.name}${loc}\n`;
			const err = data.details?.error;
			if (err) {
				const cause = err.cause;
				if (cause && typeof cause === "object") {
					if (cause.message) {
						yield `  ${cause.message}\n`;
					}
					if (cause.stack) {
						const stackLines = cause.stack
							.split("\n")
							.filter((line) => !line.includes("node:internal"));
						if (stackLines.length > 0) {
							yield `  ${stackLines.join("\n  ")}\n`;
						}
					}
				} else if (err.message) {
					yield `  ${err.message}\n`;
					if (err.stack) {
						const stackLines = err.stack
							.split("\n")
							.filter((line) => !line.includes("node:internal"));
						if (stackLines.length > 0) {
							yield `  ${stackLines.join("\n  ")}\n`;
						}
					}
				}
			}
		} else if (event.type === "test:summary" && !event.data.file) {
			const counts = event.data.counts;
			const duration = ((event.data.duration_ms || 0) / 1000).toFixed(2);
			if (event.data.success) {
				yield `\n✔ ${counts.tests} tests passed across ${counts.suites} suites (${duration}s)\n`;
			} else {
				yield `\n✖ ${counts.failed} failed, ${counts.passed} passed across ${counts.suites} suites (${duration}s)\n`;
			}
		}
	}
}
