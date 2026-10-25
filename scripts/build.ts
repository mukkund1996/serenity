/**
 * Builds the single-file `serenity` binary (ADR 0002, 0014).
 * Usage: bun scripts/build.ts [bun-target] [outfile]
 */
import type { BunPlugin } from "bun";

// Ink imports react-devtools-core only when DEV=true, but the bundler hoists
// the import; a stub keeps the binary self-contained.
const stubDevtools: BunPlugin = {
	name: "stub-react-devtools-core",
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
			path: "react-devtools-core",
			namespace: "stub",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export default { initialize() {}, connectToDevTools() {} };",
			loader: "js",
		}));
	},
};

const [target, outfile = "dist/serenity"] = process.argv.slice(2);
const result = await Bun.build({
	entrypoints: ["packages/cli/src/main.ts"],
	compile: target
		? { target: target as Bun.Build.CompileTarget, outfile }
		: { outfile },
	minify: true,
	plugins: [stubDevtools],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`built ${outfile}${target ? ` for ${target}` : ""}`);
