import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SLACK_COMPLETE_UPLOAD_TOOL,
	SLACK_UPLOAD_URL_TOOL,
} from "@serenity/core";
import type { ClaudeRunner, JsonRunOptions } from "../src/claude";
import { uploadSlackFile } from "../src/slack-upload";

let dir: string;
let path: string;
let calls: JsonRunOptions[];
let answers: unknown[];
let posts: Array<{ url: string; body: string; type: string | null }>;
let statuses: number[];

const runner: ClaudeRunner = {
	runJson: async (opts) => {
		calls.push(opts);
		return answers.shift();
	},
	startChat: () => {
		throw new Error("no chat");
	},
};

const fakeFetch = (async (url: string, init: RequestInit) => {
	posts.push({
		url,
		body: new TextDecoder().decode(init.body as Uint8Array),
		type: new Headers(init.headers).get("content-type"),
	});
	return new Response(null, { status: statuses.shift() ?? 200 });
}) as unknown as typeof fetch;

const host = () => ({
	runner,
	model: "haiku",
	cwd: "/tmp",
	mcpConfig: "{}",
	fetch: fakeFetch,
});
const url = (n: number) => ({
	upload_url: `https://files.slack.com/upload/v1/X${n}`,
	file_id: `F${n}`,
	problem: null,
});
const share = { channelId: "C0ENG", threadTs: "171.5", comment: "for you" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "srupload-"));
	path = join(dir, "api-auth-20261030-141502.md");
	writeFileSync(path, "# Goal\nRotate tokens.");
	calls = [];
	answers = [];
	posts = [];
	statuses = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("gets a URL, POSTs the bytes itself, then completes the share; one tool per step", async () => {
	answers = [
		url(1),
		{ shared: true, permalink: "https://slack/f/F1", problem: null },
	];
	const link = await uploadSlackFile(host(), { path, ...share });
	expect(link).toBe("https://slack/f/F1");
	expect(calls.map((c) => c.allowedTools)).toEqual([
		[SLACK_UPLOAD_URL_TOOL],
		[SLACK_COMPLETE_UPLOAD_TOOL],
	]);
	expect(calls[0]?.prompt).toContain(
		'filename "api-auth-20261030-141502.md" and content_length 21',
	);
	expect(posts).toEqual([
		{
			url: "https://files.slack.com/upload/v1/X1",
			body: "# Goal\nRotate tokens.",
			type: "text/markdown",
		},
	]);
	const complete = calls[1]?.prompt as string;
	expect(complete).toContain('file_id "F1", channel_id "C0ENG"');
	expect(complete).toContain('thread_ts "171.5"');
	expect(complete).toContain("<<<\nfor you\n>>>");
});

test("a rejected URL is fetched again once", async () => {
	statuses = [401, 200];
	answers = [url(1), url(2), { shared: true, permalink: null, problem: null }];
	await uploadSlackFile(host(), { path, ...share, comment: null });
	expect(posts.map((p) => p.url)).toEqual([
		"https://files.slack.com/upload/v1/X1",
		"https://files.slack.com/upload/v1/X2",
	]);
	expect(calls[2]?.prompt).toContain('file_id "F2"');
	expect(calls[2]?.prompt).toContain("No initial_comment.");
});

test("fails with Slack's reason, and never completes a failed upload", async () => {
	answers = [{ upload_url: null, file_id: null, problem: "uploads disabled" }];
	await expect(uploadSlackFile(host(), { path, ...share })).rejects.toThrow(
		"uploads disabled",
	);
	statuses = [500];
	answers = [url(1)];
	await expect(uploadSlackFile(host(), { path, ...share })).rejects.toThrow(
		"refused the upload (500)",
	);
	answers = [{ ...url(1), upload_url: "http://evil" }];
	await expect(uploadSlackFile(host(), { path, ...share })).rejects.toThrow(
		"not https",
	);
	expect(
		calls.some((c) => c.allowedTools?.includes(SLACK_COMPLETE_UPLOAD_TOOL)),
	).toBe(false);
	answers = [
		url(1),
		{ shared: false, permalink: null, problem: "not_in_channel" },
	];
	await expect(uploadSlackFile(host(), { path, ...share })).rejects.toThrow(
		"not_in_channel",
	);
});
