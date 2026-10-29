import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { BUILD_ID } from "./domain";
import { daemonLockPath, daemonLogPath, socketPath } from "./paths";
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

/** Connects to a running daemon of the same version, or returns null. */
export async function connectDaemon(home: string): Promise<RpcPeer | null> {
	let peer: RpcPeer;
	try {
		peer = await connectRpc(socketPath(home), 500);
	} catch {
		return null;
	}
	try {
		const hello = await peer.request(
			"hello",
			{ clientVersion: BUILD_ID },
			{ timeoutMs: 1000 },
		);
		if (hello.daemonVersion === BUILD_ID) return peer;
		// Another build: ask it to go, and wait for it to be gone.
		await peer
			.request("daemon.shutdown", {}, { timeoutMs: 1000 })
			.catch(() => {});
		peer.close();
		await waitForDaemonGone(home);
		return null;
	} catch {
		peer.close();
		return null;
	}
}

/** Spawns `serenity daemon` in the background, logging to daemon.log. */
export function startDaemonProcess(home: string): void {
	mkdirSync(home, { recursive: true });
	const log = openSync(daemonLogPath(home), "a");
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
