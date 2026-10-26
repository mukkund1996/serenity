import { beforeEach, expect, test } from "bun:test";
import type { ReviewRequest } from "@serenity/core";
import { Gh } from "../src/gh";
import { ReviewWatcher } from "../src/reviews";

class FakeGh extends Gh {
	calls = 0;
	result: { prs: ReviewRequest[]; error: string | null } = {
		prs: [],
		error: null,
	};
	override async reviewRequests() {
		this.calls++;
		return this.result;
	}
	override async currentUser(): Promise<string | null> {
		return "me";
	}
}

const review = (number: number): ReviewRequest => ({
	number,
	url: `https://github.com/o/r/pull/${number}`,
	title: `t${number}`,
	author: "ana",
	updatedAt: number,
});

let gh: FakeGh;
let open: boolean;
let broadcasts: number;
let watcher: ReviewWatcher;

beforeEach(() => {
	gh = new FakeGh();
	open = true;
	broadcasts = 0;
	watcher?.stop();
	watcher = new ReviewWatcher({
		gh,
		watching: () => open,
		broadcast: () => broadcasts++,
		log: () => {},
		pollMs: 20,
	});
});

test("opening a map fetches review requests and broadcasts the change", async () => {
	expect(watcher.state("/r")).toEqual({ user: null, reviewRequests: [] });
	gh.result = { prs: [review(4)], error: null };
	watcher.watch("/r");
	await Bun.sleep(5);
	expect(watcher.state("/r")).toEqual({
		user: "me",
		reviewRequests: [review(4)],
	});
	expect(broadcasts).toBe(1);
	// Reopening within a minute does not ask gh again.
	watcher.watch("/r");
	await Bun.sleep(5);
	expect(gh.calls).toBe(1);
	watcher.stop();
});

test("polls while a map is open, stops when none is, and keeps the list on errors", async () => {
	gh.result = { prs: [review(4)], error: null };
	watcher.watch("/r");
	await Bun.sleep(50);
	expect(gh.calls).toBeGreaterThan(1);
	// Nothing changed, so nothing was broadcast after the first fetch.
	expect(broadcasts).toBe(1);

	gh.result = { prs: [], error: "gh not logged in" };
	await Bun.sleep(30);
	expect(watcher.state("/r").reviewRequests).toEqual([review(4)]);

	open = false;
	await Bun.sleep(30);
	const calls = gh.calls;
	await Bun.sleep(50);
	expect(gh.calls).toBe(calls);
	watcher.stop();
});
