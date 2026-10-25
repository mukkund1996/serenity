import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { VERSION } from "./domain";
import { daemonLogPath, socketPath } from "./paths";
import { connectRpc, type RpcPeer } from "./rpc";
import { selfCommand } from "./self";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
			{ clientVersion: VERSION },
			{ timeoutMs: 1000 },
		);
		if (hello.daemonVersion === VERSION) return peer;
		// An older daemon: ask it to go, and wait for its socket to disappear.
		await peer
			.request("daemon.shutdown", {}, { timeoutMs: 1000 })
			.catch(() => {});
		peer.close();
		for (let i = 0; i < 40 && existsSync(socketPath(home)); i++)
			await sleep(50);
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
