import { expect, test } from "bun:test";
import { DependencyHealth, FAILURES_TO_REPORT } from "../src/health";
import {
	backoffMs,
	isTransientMessage,
	isTransientRpcError,
	withRetry,
} from "../src/retry";
import { RpcError, RpcErrorCode } from "../src/rpc";

const flaky = (failures: number, error: unknown = new Error("ECONNRESET")) => {
	let calls = 0;
	const fn = async () => {
		calls++;
		if (calls <= failures) throw error;
		return "ok";
	};
	return { fn, calls: () => calls };
};

const instant = { sleep: async () => {} };

test("backoff doubles from the base, capped, with full jitter", () => {
	const b = { baseMs: 100, maxMs: 1000 };
	expect(backoffMs(0, b, () => 1)).toBe(100);
	expect(backoffMs(1, b, () => 1)).toBe(200);
	expect(backoffMs(3, b, () => 1)).toBe(800);
	expect(backoffMs(4, b, () => 1)).toBe(1000);
	expect(backoffMs(30, b, () => 1)).toBe(1000);
	expect(backoffMs(3, b, () => 0)).toBe(0);
	expect(backoffMs(3, b, () => 0.5)).toBe(400);
});

test("a transient failure is retried until it passes", async () => {
	const call = flaky(2);
	const delays: number[] = [];
	const out = await withRetry(call.fn, {
		...instant,
		isTransient: () => true,
		random: () => 1,
		onRetry: (_e, _n, delay) => delays.push(delay),
	});
	expect(out).toBe("ok");
	expect(call.calls()).toBe(3);
	expect(delays).toEqual([200, 400]);
});

test("a permanent failure is thrown at once", async () => {
	const call = flaky(5, new Error("gh not logged in"));
	await expect(
		withRetry(call.fn, { ...instant, isTransient: () => false }),
	).rejects.toThrow("gh not logged in");
	expect(call.calls()).toBe(1);
});

test("tries run out: the last error is thrown", async () => {
	const call = flaky(10);
	await expect(
		withRetry(call.fn, {
			...instant,
			isTransient: () => true,
			policy: { attempts: 4, baseMs: 1, maxMs: 1 },
		}),
	).rejects.toThrow("ECONNRESET");
	expect(call.calls()).toBe(4);
});

test("transient: timeouts, dropped connections, 5xx, git locks, a lost tmux server", () => {
	for (const text of [
		"gh timed out",
		"read: connection reset by peer",
		"HTTP 502: Bad Gateway (https://api.github.com/graphql)",
		"HTTP 503: Service Unavailable",
		"error connecting to api.github.com: dial tcp: i/o timeout",
		"fatal: Unable to create '/r/.git/index.lock': File exists.",
		"error: cannot lock ref 'refs/heads/x'",
		"lost server",
		"server exited unexpectedly",
		"Resource temporarily unavailable (EAGAIN)",
	])
		expect(isTransientMessage(text)).toBe(true);
});

test("permanent: auth, not found, no server, missing binary", () => {
	for (const text of [
		"To get started with GitHub CLI, please run:  gh auth login",
		'no pull requests found for branch "x"',
		"HTTP 404: Not Found",
		"no server running on /tmp/tmux-501/default",
		"can't find pane: %9",
		"fatal: not a git repository",
		"gh: command not found",
		"",
	])
		expect(isTransientMessage(text)).toBe(false);
});

test("an RPC timeout or closed connection is transient; a handler error is not", () => {
	expect(isTransientRpcError(new RpcError(RpcErrorCode.Timeout, "x"))).toBe(
		true,
	);
	expect(isTransientRpcError(new RpcError(RpcErrorCode.Closed, "x"))).toBe(
		true,
	);
	expect(isTransientRpcError(new RpcError(RpcErrorCode.Internal, "x"))).toBe(
		false,
	);
	expect(isTransientRpcError(new Error("closed"))).toBe(false);
});

test("health reports a dependency after failures in a row, clears on success", () => {
	let changes = 0;
	let now = 100;
	const health = new DependencyHealth(
		() => changes++,
		() => now,
	);
	health.report("gh", "gh unreachable");
	expect(health.issues()).toEqual([]);
	expect(changes).toBe(0);
	now = 200;
	for (let i = 1; i < FAILURES_TO_REPORT; i++)
		health.report("gh", "gh unreachable");
	expect(health.issues()).toEqual([
		{ dependency: "gh", message: "gh unreachable", since: 100 },
	]);
	expect(changes).toBe(1);
	health.report("gh", "gh unreachable");
	expect(changes).toBe(1);
	health.report("gh", null);
	expect(health.issues()).toEqual([]);
	expect(changes).toBe(2);
	// One success resets the count: a later single failure is a blip again.
	health.report("gh", "gh unreachable");
	expect(health.issues()).toEqual([]);
});

test("health keeps each dependency apart", () => {
	const health = new DependencyHealth();
	for (let i = 0; i < FAILURES_TO_REPORT; i++) {
		health.report("tmux", "tmux unreachable");
		health.report("git", "git unreachable");
	}
	health.report("git", null);
	expect(health.issues().map((i) => i.dependency)).toEqual(["tmux"]);
});
