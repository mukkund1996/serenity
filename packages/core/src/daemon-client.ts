import { spawn, spawnSync } from "node:child_process";
import { existsSync, fchmodSync, openSync } from "node:fs";
import { BUILD_ID } from "./domain";
import { daemonLockPath, daemonLogPath, socketPath } from "./paths";
import { ensurePrivateDir, PRIVATE_FILE } from "./private";
import { connectRpc, type RpcPeer } from "./rpc";
import { selfCommand } from "./self";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After a shutdown request: waits for the worker's socket, then its
 * supervisor's lock, to go, so a new supervisor can take the home (ADR 0045).
 */
export async function waitForDaemonGone(home: string): Promise<void> {
	for (let i = 0; i < 40 && existsSync(socketPath(home)); i++) await sleep(50);
	for (let i = 0; i < 40 && existsSync(daemonLockPath(home)); i++)
		await sleep(50);
}

/**
 * This process is an older build than the running daemon: serenity was
 * upgraded while it ran. It must not shut that daemon down, or it and a
 * current client restart and stop it in turn until both give up.
 */
export class StaleClientError extends Error {
	constructor(readonly daemonVersion: string) {
		super(
			`this serenity (${BUILD_ID}) is older than the running daemon (${daemonVersion}); restart it`,
		);
		this.name = "StaleClientError";
	}
}

/** The build `selfCommand` would start now, or null if it can't be told. */
export function installedBuild(): string | null {
	const [command, ...args] = selfCommand();
	const result = spawnSync(command as string, [...args, "version"], {
		encoding: "utf8",
		timeout: 2000,
	});
	const out = result.status === 0 ? result.stdout.trim() : "";
	return out || null;
}

export interface ConnectOptions {
	/** Defaults to asking the installed binary for its `version`. */
	installedBuild?: () => string | null;
}

/**
 * Connects to a running daemon of the same version, or returns null. A daemon
 * of another build is asked to go, unless it is the installed build and this
 * process the outdated one: then this throws StaleClientError.
 */
export async function connectDaemon(
	home: string,
	opts: ConnectOptions = {},
): Promise<RpcPeer | null> {
	let peer: RpcPeer;
	try {
		peer = await connectRpc(socketPath(home), 500);
	} catch {
		return null;
	}
	let daemonVersion: string;
	try {
		const hello = await peer.request(
			"hello",
			{ clientVersion: BUILD_ID },
			{ timeoutMs: 1000 },
		);
		daemonVersion = hello.daemonVersion;
	} catch {
		peer.close();
		return null;
	}
	if (daemonVersion === BUILD_ID) return peer;
	if ((opts.installedBuild ?? installedBuild)() === daemonVersion) {
		peer.close();
		throw new StaleClientError(daemonVersion);
	}
	// Another build, and not the installed one: ask it to go, and wait for it to be gone.
	await peer
		.request("daemon.shutdown", {}, { timeoutMs: 1000 })
		.catch(() => {});
	peer.close();
	await waitForDaemonGone(home);
	return null;
}

/** Spawns `serenity daemon` in the background, logging to daemon.log. */
export function startDaemonProcess(home: string): void {
	ensurePrivateDir(home);
	const log = openSync(daemonLogPath(home), "a", PRIVATE_FILE);
	// A log from an older version keeps its mode; open does not change it.
	fchmodSync(log, PRIVATE_FILE);
	const [command, ...args] = selfCommand();
	const child = spawn(command as string, [...args, "daemon"], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, SERENITY_HOME: home },
	});
	child.unref();
}

/** Returns a connection to the daemon, starting it first if needed (ADR 0005). */
export async function ensureDaemon(
	home: string,
	timeoutMs = 5000,
): Promise<RpcPeer> {
	const existing = await connectDaemon(home);
	if (existing) return existing;
	startDaemonProcess(home);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(100);
		const peer = await connectDaemon(home);
		if (peer) return peer;
	}
	throw new Error(`serenityd did not start; see ${daemonLogPath(home)}`);
}
