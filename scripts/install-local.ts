/**
 * Installs this checkout as your everyday serenity (docs/dogfooding.md):
 * builds the binary, puts it at ~/.local/bin/serenity, and restarts the
 * daemon onto it. Running sessions keep running.
 * Usage: bun scripts/install-local.ts [bin dir]
 */
import { chmodSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const binDir = process.argv[2] ?? join(homedir(), ".local", "bin");
const dest = join(binDir, "serenity");

const run = (cmd: string[]) => {
	const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
};

run(["bun", "scripts/build.ts"]);
mkdirSync(binDir, { recursive: true });
// Copy then rename: macOS kills a running binary that is overwritten in place.
copyFileSync("dist/serenity", `${dest}.new`);
chmodSync(`${dest}.new`, 0o755);
renameSync(`${dest}.new`, dest);
console.log(`installed ${dest}`);
// The hooks of running sessions call this path, so they use the new build at once.
run([dest, "restart"]);
