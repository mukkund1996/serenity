import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRpc, RpcError, RpcPeer } from "../src/rpc";

const EMPTY_STATE = {
	repo: "/r",
	sessions: [],
	attachedSessionId: null,
	suggestions: [],
	conversation: [],
	permissions: [],
	master: { status: "idle" as const, error: null },
	github: { user: null, reviewRequests: [] },
	usage: null,
	averageWaitMs: null,
	pings: [],
	slack: null,
	health: [],
};

let server: Server | null = null;
let dir = "";

afterEach(() => {
	server?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function serve(onPeer: (peer: RpcPeer) => void): Promise<string> {
	dir = mkdtempSync(join(tmpdir(), "srpc-"));
	const path = join(dir, "s.sock");
	server = createServer((socket) => onPeer(new RpcPeer(socket)));
	await new Promise<void>((resolve) => server?.listen(path, resolve));
	return path;
}

test("requests, errors and notifications round-trip", async () => {
	const path = await serve((peer) => {
		peer.onRequest((method, params) => {
			if (method === "hello") {
				peer.notify("state.changed", EMPTY_STATE);
				return { daemonVersion: "x", pid: 1, echo: params };
			}
			throw new RpcError(-32602, "bad");
		});
	});
	const client = await connectRpc(path);
	const notes: unknown[] = [];
	client.onNotification((method, params) => notes.push([method, params]));
	const hello = await client.request("hello", { clientVersion: "1" });
	expect(hello).toMatchObject({
		daemonVersion: "x",
		echo: { clientVersion: "1" },
	});
	await expect(client.request("daemon.shutdown", {})).rejects.toThrow("bad");
	expect(notes).toEqual([["state.changed", EMPTY_STATE]]);
	client.close();
});

test("pending requests reject when the connection closes", async () => {
	const path = await serve((peer) =>
		peer.onRequest(() => new Promise(() => {})),
	);
	const client = await connectRpc(path);
	const pending = client.request("hello", { clientVersion: "1" });
	client.close();
	await expect(pending).rejects.toThrow("connection closed");
});

test("requests time out", async () => {
	const path = await serve((peer) =>
		peer.onRequest(() => new Promise(() => {})),
	);
	const client = await connectRpc(path);
	await expect(
		client.request("hello", { clientVersion: "1" }, { timeoutMs: 20 }),
	).rejects.toThrow("timed out");
	client.close();
});
