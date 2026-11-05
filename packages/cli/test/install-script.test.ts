/**
 * scripts/install.sh opens the docs at the end (ADR 0062), except when opted
 * out, in CI or with no display; it prints the URL every time.
 */
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/install.sh");
const DOCS = "https://getserenity.dev/docs/";
const dir = mkdtempSync(join(tmpdir(), "sr-install-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A release of a fake serenity for every platform, with its checksums.
const release = join(dir, "release");
mkdirSync(release);
const sums: string[] = [];
for (const target of [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
]) {
	const file = `serenity-${target}`;
	const body = '#!/bin/sh\n[ "$1" = version ] && echo 9.9.9\nexit 0\n';
	writeFileSync(join(release, file), body);
	sums.push(
		`${new Bun.CryptoHasher("sha256").update(body).digest("hex")}  ${file}`,
	);
}
writeFileSync(join(release, "SHA256SUMS"), `${sums.join("\n")}\n`);

// `open` and `xdg-open` that only record what they were asked to open.
const bin = join(dir, "bin");
const opened = join(dir, "opened");
mkdirSync(bin);
for (const name of ["open", "xdg-open"]) {
	writeFileSync(
		join(bin, name),
		`#!/bin/sh\necho "${name} $*" >> "${opened}"\n`,
	);
	chmodSync(join(bin, name), 0o755);
}

let run = 0;
function install(env: Record<string, string>) {
	rmSync(opened, { force: true });
	const result = spawnSync("sh", [SCRIPT], {
		encoding: "utf8",
		env: {
			PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: dir,
			SERENITY_NO_DEPS: "1",
			SERENITY_INSTALL_DIR: join(dir, `install-${++run}`),
			SERENITY_DOWNLOAD_BASE: `file://${release}`,
			...env,
		},
	});
	expect(result.stderr).not.toContain("✗");
	expect(result.status).toBe(0);
	expect(result.stdout).toContain(`Docs: ${DOCS}`);
	return existsSync(opened) ? readFileSync(opened, "utf8").trim() : null;
}

const display: Record<string, string> =
	process.platform === "darwin" ? {} : { DISPLAY: ":0" };
const opener = process.platform === "darwin" ? "open" : "xdg-open";

test("opens the docs in the browser when the install finishes", () => {
	expect(install(display)).toBe(`${opener} ${DOCS}`);
});

test("SERENITY_NO_OPEN=1 only prints the URL", () => {
	expect(install({ ...display, SERENITY_NO_OPEN: "1" })).toBeNull();
});

test("CI only prints the URL", () => {
	expect(install({ ...display, CI: "true" })).toBeNull();
});

test("no display (Linux) or an SSH session (macOS) only prints the URL", () => {
	expect(
		install(process.platform === "darwin" ? { SSH_CONNECTION: "1 2 3 4" } : {}),
	).toBeNull();
});
