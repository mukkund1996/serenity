import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	crashReportsDir,
	daemonCrashPath,
	daemonLogPath,
	dbPath,
	handoversRoot,
} from "./paths";

/**
 * The state directory holds prompts, agent replies, the master chat and
 * handover docs, so only the user may read it: folders 0700, files 0600.
 * Set per file rather than through the umask, which tmux, git and the
 * sessions would inherit for the user's own repos.
 */
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;

/** Creates the folder (and any missing parents) and makes it the user's alone. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR });
	chmodSync(path, PRIVATE_DIR);
}

/** Folders to 0700 and files to 0600, under and including `path`; missing is fine. */
export function makePrivate(path: string): void {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		return;
	}
	if (!stat.isDirectory()) {
		chmodSync(path, PRIVATE_FILE);
		return;
	}
	chmodSync(path, PRIVATE_DIR);
	for (const entry of readdirSync(path)) makePrivate(join(path, entry));
}

/**
 * Tightens what older versions left readable: the home folder, the
 * database, the log, crash reports and handover docs.
 */
export function securePrivateState(home: string): void {
	ensurePrivateDir(home);
	const db = dbPath(home);
	for (const path of [
		db,
		`${db}-wal`,
		`${db}-shm`,
		daemonLogPath(home),
		daemonCrashPath(home),
		crashReportsDir(home),
		handoversRoot(home),
	])
		makePrivate(path);
}
