/**
 * Runs `bun test <dir>` and retries each failing test file once, on its own
 * (ADR 0068). A file that passes on the retry is reported as flaky, never
 * passed silently: a `::warning` annotation in CI, a table in the job
 * summary, and a line on stderr. A file that fails twice fails the run, and
 * so does a failure no test file is blamed for (a crash, an error outside a
 * test), which is never retried.
 *
 *   bun scripts/test-retry-flaky.ts e2e
 */
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun scripts/test-retry-flaky.ts <dir>");
	process.exit(2);
}

const ci = Boolean(process.env.GITHUB_ACTIONS);
const out = mkdtempSync(join(tmpdir(), "serenity-test-"));

/** Runs bun test on `paths`; the exit code and the files with a failing test. */
function run(
	paths: string[],
	name: string,
): { code: number; failed: string[] } {
	const report = join(out, `${name}.xml`);
	const { exitCode } = Bun.spawnSync(
		[
			"bun",
			"test",
			"--reporter=junit",
			`--reporter-outfile=${report}`,
			...paths,
		],
		{ stdio: ["inherit", "inherit", "inherit"] },
	);
	return { code: exitCode ?? 1, failed: failedFiles(report) };
}

/** Test files with at least one failure or error, from bun's junit report. */
function failedFiles(reportPath: string): string[] {
	let xml: string;
	try {
		xml = readFileSync(reportPath, "utf8");
	} catch {
		return [];
	}
	const files = new Set<string>();
	for (const m of xml.matchAll(/<testsuite\b[^>]*>/g)) {
		const tag = m[0];
		const file = /\bfile="([^"]+)"/.exec(tag)?.[1];
		const failures = Number(/\bfailures="(\d+)"/.exec(tag)?.[1] ?? 0);
		const errors = Number(/\berrors="(\d+)"/.exec(tag)?.[1] ?? 0);
		if (file && failures + errors > 0) files.add(file);
	}
	return [...files];
}

function annotate(level: "warning" | "error", message: string) {
	if (ci) console.log(`::${level}::${message}`);
	console.error(`${level}: ${message}`);
}

function summary(lines: string[]) {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (path) appendFileSync(path, `${lines.join("\n")}\n`);
}

const first = run([dir], "first");
if (first.code === 0) process.exit(0);
if (first.failed.length === 0) {
	annotate(
		"error",
		`bun test ${dir} failed outside any test file (a crash or an unhandled error); not retried`,
	);
	process.exit(first.code);
}

console.error(
	`\n${first.failed.length} file(s) failed; retrying each once on its own: ${first.failed.join(", ")}\n`,
);
const flaky: string[] = [];
const broken: string[] = [];
for (const [i, file] of first.failed.entries()) {
	// A path bun reads as a filter would also match other files; ./ pins it.
	const retry = run([`./${file.replace(/^\.\//, "")}`], `retry-${i}`);
	(retry.code === 0 ? flaky : broken).push(file);
}

for (const file of flaky)
	annotate(
		"warning",
		`FLAKY: ${file} failed, then passed on its one retry. See the first run's output above.`,
	);
for (const file of broken)
	annotate("error", `${file} failed twice: a real failure, not a flake.`);
summary([
	`### bun test ${dir}: retried failing files once`,
	"",
	"| file | result |",
	"| --- | --- |",
	...flaky.map((f) => `| \`${f}\` | ⚠️ flaky: failed, then passed on retry |`),
	...broken.map((f) => `| \`${f}\` | ❌ failed twice |`),
]);
process.exit(broken.length ? 1 : 0);
