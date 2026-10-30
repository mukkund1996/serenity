import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	SLACK_COMPLETE_UPLOAD_SCHEMA,
	SLACK_COMPLETE_UPLOAD_TOOL,
	SLACK_UPLOAD_URL_SCHEMA,
	SLACK_UPLOAD_URL_TOOL,
	slackCompleteUploadPrompt,
	slackUploadUrlPrompt,
} from "@serenity/core";
import type { ClaudeRunner } from "./claude";
import type { SlackFileUpload } from "./master";

export interface SlackUploadHost {
	runner: ClaudeRunner;
	model: string;
	cwd: string;
	/** `--mcp-config` JSON holding only the Slack server. */
	mcpConfig: string;
	fetch?: typeof fetch;
}

/** Each step is one Slack tool call. */
const STEP_TIMEOUT_MS = 120_000;

/**
 * Uploads a file to Slack and shares it (ADR 0049). The token is the
 * `claude` CLI's (0023), so the two Slack steps are one-shot workers, each
 * allowed exactly one tool; the bytes in between are POSTed here, so no
 * model handles the file. A rejected upload URL is fetched again once.
 * Returns the file's link; throws with Slack's reason on failure.
 */
export async function uploadSlackFile(
	host: SlackUploadHost,
	share: SlackFileUpload,
): Promise<string | null> {
	const bytes = readFileSync(share.path);
	const filename = basename(share.path);
	const post = host.fetch ?? fetch;
	let fileId: string | null = null;
	for (let attempt = 0; attempt < 2 && !fileId; attempt++) {
		const got = (await host.runner.runJson({
			prompt: slackUploadUrlPrompt(filename, bytes.length),
			model: host.model,
			schema: SLACK_UPLOAD_URL_SCHEMA,
			cwd: host.cwd,
			mcpConfig: host.mcpConfig,
			allowedTools: [SLACK_UPLOAD_URL_TOOL],
			timeoutMs: STEP_TIMEOUT_MS,
		})) as {
			upload_url?: string | null;
			file_id?: string | null;
			problem?: string | null;
		};
		if (!got?.upload_url || !got.file_id)
			throw new Error(`Slack gave no upload URL: ${got?.problem ?? "unknown"}`);
		if (!got.upload_url.startsWith("https://"))
			throw new Error("Slack's upload URL is not https");
		const res = await post(got.upload_url, {
			method: "POST",
			headers: { "Content-Type": "text/markdown" },
			body: bytes,
		});
		// 401 is an expired or mistyped URL: one more try with a fresh one.
		if (res.status === 401 && attempt === 0) continue;
		if (!res.ok) throw new Error(`Slack refused the upload (${res.status})`);
		fileId = got.file_id;
	}
	if (!fileId) throw new Error("Slack refused the upload URL twice");
	const done = (await host.runner.runJson({
		prompt: slackCompleteUploadPrompt({
			fileId,
			channelId: share.channelId,
			threadTs: share.threadTs,
			title: filename,
			comment: share.comment,
		}),
		model: host.model,
		schema: SLACK_COMPLETE_UPLOAD_SCHEMA,
		cwd: host.cwd,
		mcpConfig: host.mcpConfig,
		allowedTools: [SLACK_COMPLETE_UPLOAD_TOOL],
		timeoutMs: STEP_TIMEOUT_MS,
	})) as { shared?: boolean; permalink?: string | null; problem?: string };
	if (!done?.shared)
		throw new Error(`Slack did not share it: ${done?.problem ?? "unknown"}`);
	return done.permalink ?? null;
}
