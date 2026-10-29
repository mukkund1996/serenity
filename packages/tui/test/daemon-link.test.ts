import { afterEach, expect, test } from "bun:test";
import {
	DaemonLink,
	healthBadges,
	type LinkOptions,
	type LinkStatus,
	linkBadge,
} from "../src/daemon-link";

class FakePeer {
	isClosed = false;
	private handlers: Array<() => void> = [];
	onClose(handler: () => void) {
		this.handlers.push(handler);
	}
	close() {
		if (this.isClosed) return;
		this.isClosed = true;
		for (const h of this.handlers) h();
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let link: DaemonLink<FakePeer> | null = null;
afterEach(() => link?.stop());

/** A link whose daemon is unreachable until `up` is set. */
function make(opts: Partial<LinkOptions<FakePeer>> = {}) {
	const world = {
		up: false,
		tries: 0,
		starts: 0,
		peers: [] as FakePeer[],
		statuses: [] as LinkStatus[],
	};
	link = new DaemonLink<FakePeer>({
		connect: async () => {
			world.tries++;
			if (!world.up) return null;
			const peer = new FakePeer();
			world.peers.push(peer);
			return peer;
		},
		ready: async () => {},
		startDaemon: () => world.starts++,
		onStatus: (s) => world.statuses.push(s),
		backoff: { baseMs: 2, maxMs: 4 },
		downAfterMs: 60,
		startAfterMs: 20,
		...opts,
	});
	link.start();
	return { world, link };
}

test("keeps trying with backoff until the daemon answers", async () => {
	const { world, link } = make();
	await wait(15);
	expect(world.tries).toBeGreaterThan(2);
	expect(link.current).toBeNull();
	world.up = true;
	await wait(15);
	expect(link.current).toBe(world.peers[0] ?? null);
	expect(world.statuses).toEqual(["connected"]);
});

test("losing the daemon reconnects: reconnecting, then connected", async () => {
	const { world, link } = make();
	world.up = true;
	await wait(10);
	world.peers[0]?.close();
	expect(world.statuses).toEqual(["connected", "reconnecting"]);
	expect(link.current).toBeNull();
	await wait(15);
	expect(world.statuses).toEqual(["connected", "reconnecting", "connected"]);
	expect(link.current).toBe(world.peers[1] ?? null);
});

test("reconnecting turns to down after a while, and back once it answers", async () => {
	const { world } = make();
	world.up = true;
	await wait(10);
	world.up = false;
	world.peers[0]?.close();
	await wait(80);
	expect(world.statuses).toEqual(["connected", "reconnecting", "down"]);
	world.up = true;
	await wait(15);
	expect(world.statuses.at(-1)).toBe("connected");
});

test("starts a daemon once per outage, and not when it answers in time", async () => {
	const { world } = make();
	await wait(35);
	expect(world.starts).toBe(1);
	world.up = true;
	await wait(10);
	world.peers[0]?.close();
	await wait(5);
	expect(world.starts).toBe(1);
	world.up = false;
	world.peers[1]?.close();
	await wait(35);
	expect(world.starts).toBe(2);
});

test("a failed subscribe drops the peer and tries again", async () => {
	let fail = 2;
	const { world, link } = make({
		ready: async () => {
			if (fail-- > 0) throw new Error("state.subscribe timed out");
		},
	});
	world.up = true;
	await wait(25);
	expect(world.peers.slice(0, 2).every((p) => p.isClosed)).toBe(true);
	expect(link.current).toBe(world.peers[2] ?? null);
	expect(world.statuses).toEqual(["connected"]);
});

test("a call waits for the reconnect, and gives up after its wait", async () => {
	const { world, link } = make();
	const waiting = link.waitForPeer(100);
	await wait(5);
	world.up = true;
	expect(await waiting).toBe((await waitFirst(world.peers)) ?? null);
	world.up = false;
	world.peers[0]?.close();
	expect(await link.waitForPeer(10)).toBeNull();
});

test("stopping closes the peer and stops trying", async () => {
	const { world, link } = make();
	world.up = true;
	await wait(10);
	link.stop();
	expect(world.peers[0]?.isClosed).toBe(true);
	const tries = world.tries;
	await wait(20);
	expect(world.tries).toBe(tries);
});

test("header badges: yellow while reconnecting, red once down or failing", () => {
	expect(linkBadge("connected")).toBeNull();
	expect(linkBadge("connecting")).toEqual({
		text: " connecting… ",
		color: "yellow",
	});
	expect(linkBadge("reconnecting")).toEqual({
		text: " reconnecting… ",
		color: "yellow",
	});
	expect(linkBadge("down")).toEqual({
		text: " daemon down · see daemon.log ",
		color: "red",
	});
	expect(
		healthBadges([
			{ dependency: "gh", message: "gh not logged in", since: 1 },
			{
				dependency: "slack",
				message: "Slack: MCP server slack failed to start in time",
				since: 1,
			},
		]),
	).toEqual([
		{ text: " gh not logged in ", color: "red" },
		{ text: " Slack: MCP server slack failed … ", color: "red" },
	]);
});

async function waitFirst<T>(items: T[]): Promise<T | undefined> {
	for (let i = 0; i < 20 && !items.length; i++) await wait(2);
	return items[0];
}
