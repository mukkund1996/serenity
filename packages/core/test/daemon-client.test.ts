import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, StaleClientError } from "../src/daemon-client";
import { BUILD_ID } from "../src/domain";
import { socketPath } from "../src/paths";
import { RpcPeer } from "../src/rpc";

let server: Server | null = null;
let home = "";

afterEach(() => {
	server?.close();
	server = null;
	if (home) rmSync(home, { recursive: true, force: true });
});

/** A daemon of `version` on a temp home; records the methods it is sent. */
async function fakeDaemon(version: string) {
	home = mkdtempSync(join(tmpdir(), "sdc-"));
	const calls: string[] = [];
	server = createServer((socket) => {
		const peer = new RpcPeer(socket);
		peer.onRequest((method) => {
			calls.push(method);
			if (method === "hello") return { daemonVersion: version, pid: 1 };
			if (method === "daemon.shutdown") {
				server?.close();
				return {};
			}
			return {};
		});
	});
	await new Promise<void>((resolve) =>
		server?.listen(socketPath(home), resolve),
	);
	return calls;
}

test("connects to a daemon of the same build", async () => {
	const calls = await fakeDaemon(BUILD_ID);
	const peer = await connectDaemon(home, { installedBuild: () => "unused" });
	expect(peer).not.toBeNull();
	peer?.close();
	expect(calls).toEqual(["hello"]);
});

test("asks a daemon of another build to go when this build is installed", async () => {
	const calls = await fakeDaemon("0.10.0+old");
	const peer = await connectDaemon(home, { installedBuild: () => BUILD_ID });
	expect(peer).toBeNull();
	expect(calls).toEqual(["hello", "daemon.shutdown"]);
});

test("leaves the installed build's daemon alone when this client is outdated", async () => {
	const calls = await fakeDaemon("0.12.0+new");
	const connecting = connectDaemon(home, {
		installedBuild: () => "0.12.0+new",
	});
	await expect(connecting).rejects.toBeInstanceOf(StaleClientError);
	await expect(connecting).rejects.toThrow("restart it");
	expect(calls).toEqual(["hello"]);
});

test("still asks the daemon to go when the installed build can't be told", async () => {
	const calls = await fakeDaemon("0.12.0+new");
	const peer = await connectDaemon(home, { installedBuild: () => null });
	expect(peer).toBeNull();
	expect(calls).toEqual(["hello", "daemon.shutdown"]);
});
