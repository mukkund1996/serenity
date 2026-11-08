/**
 * scripts/install.sh opens the docs at the end (ADR 0062), except when opted
 * out, in CI or with no display; it prints the URL every time. It adds the
 * install directory to the shell profile when it isn't on PATH.
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
	return runInstall(env).opened;
}

function runInstall(env: Record<string, string>) {
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
	return {
		...result,
		opened: existsSync(opened) ? readFileSync(opened, "utf8").trim() : null,
	};
}

/** A fresh HOME, so each PATH test sees only its own profiles. */
function freshHome(): string {
	return mkdtempSync(join(dir, "home-"));
}
const read = (file: string) =>
	existsSync(file) ? readFileSync(file, "utf8") : "";

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

test("adds the install directory to the zsh profile once", () => {
	const home = freshHome();
	const env = {
		HOME: home,
		SHELL: "/bin/zsh",
		SERENITY_INSTALL_DIR: join(home, ".local/bin"),
		SERENITY_NO_OPEN: "1",
	};
	const first = runInstall(env);
	const line = 'export PATH="$HOME/.local/bin:$PATH"';
	expect(read(join(home, ".zshrc"))).toContain(line);
	expect(first.stdout).toContain(`to your PATH in ${join(home, ".zshrc")}`);
	expect(first.stdout).toContain("open a new one");
	runInstall(env);
	expect(read(join(home, ".zshrc")).split(line).length - 1).toBe(1);
});

test("bash and fish get their own files", () => {
	const bash = freshHome();
	runInstall({ HOME: bash, SHELL: "/bin/bash", SERENITY_NO_OPEN: "1" });
	const bashrc = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
	expect(read(join(bash, bashrc))).toContain("export PATH=");

	const fish = freshHome();
	runInstall({
		HOME: fish,
		SHELL: "/usr/bin/fish",
		SERENITY_INSTALL_DIR: join(fish, ".local/bin"),
		SERENITY_NO_OPEN: "1",
	});
	expect(read(join(fish, ".config/fish/conf.d/serenity.fish"))).toContain(
		'fish_add_path "$HOME/.local/bin"',
	);
});

test("SERENITY_NO_MODIFY_PATH=1 only prints the line to add", () => {
	const home = freshHome();
	const result = runInstall({
		HOME: home,
		SHELL: "/bin/zsh",
		SERENITY_NO_MODIFY_PATH: "1",
		SERENITY_NO_OPEN: "1",
	});
	expect(existsSync(join(home, ".zshrc"))).toBe(false);
	expect(result.stderr).toContain("is not on your PATH");
});

test("leaves the profile alone when the directory is already on PATH", () => {
	const home = freshHome();
	const target = join(home, "bin");
	runInstall({
		HOME: home,
		SHELL: "/bin/zsh",
		SERENITY_INSTALL_DIR: target,
		PATH: `${target}:${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		SERENITY_NO_OPEN: "1",
	});
	expect(existsSync(join(home, ".zshrc"))).toBe(false);
});
