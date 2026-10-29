import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** How a daemon worker ended, and the error it left behind if it had one (ADR 0044). */
export interface CrashInfo {
	/** The error's name ("TypeError"), or "Exit" when the worker left none. */
	name: string;
	message: string;
	stack: string | null;
	code: number | null;
	signal: string | null;
}

/** What a report says about where it happened. */
export interface CrashEnvironment {
	build: string;
	/** e.g. "darwin 25.5.0 arm64". */
	os: string;
	/** e.g. "Bun 1.3.0". */
	runtime: string;
}

/** Where crash issues go; the daemon's `Gh` implements it. */
export interface IssueTracker {
	findOpenIssue(needle: string): Promise<number | null>;
	createIssue(title: string, body: string): Promise<number>;
	commentIssue(issue: number, body: string): Promise<void>;
}

export interface ReportPolicy {
	/** One GitHub write per signature this often; repeats in between are counted. */
	perSignatureMs: number;
	/** At most this many GitHub writes a day, all signatures together. */
	dailyLimit: number;
}

export const DEFAULT_REPORT_POLICY: ReportPolicy = {
	perSignatureMs: 6 * 60 * 60_000,
	dailyLimit: 5,
};

const DAY_MS = 24 * 60 * 60_000;
/** Log lines a report carries. */
const LOG_LINES = 40;
/** Local report files kept. */
const KEEP_REPORTS = 20;

export type ReportOutcome =
	| "filed"
	| "commented"
	| "rate-limited"
	| "local-only"
	| "failed";

const ESCAPE = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes what a public issue must not carry: tokens and keys, emails, and
 * file paths (which name the user and their repos). serenity's own source
 * paths are kept from `packages/` on, so stacks stay readable.
 */
export function scrub(
	text: string,
	home = homedir(),
	user = safeUsername(),
): string {
	let out = text
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in log lines
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{16,})/g, "<token>")
		.replace(/\bxox[a-z]-[A-Za-z0-9-]{8,}/g, "<token>")
		.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<token>")
		.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<token>")
		.replace(/\b(Bearer|Basic|token)\s+[\w.~+/=-]{12,}/gi, "$1 <token>")
		.replace(
			/\b((?:api[_-]?key|secret|password|passwd|token|auth)[\w-]*["']?\s*[:=]\s*)["']?[^\s"',;]+/gi,
			"$1<redacted>",
		)
		.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1<redacted>@")
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
		// serenity's own files: keep the part inside the repo.
		.replace(
			/(?:~|\/)[^\s():'"]*?\/(packages\/(?:cli|core|daemon|tui)\/[^\s():'"]+)/g,
			"$1",
		);
	if (home && home !== "/")
		out = out.replace(new RegExp(ESCAPE(home), "g"), "~");
	out = out
		// Any other absolute or home path: it names folders and repos.
		.replace(/(?<![\w.:/$<>-])(?:~|\/)(?:[\w.@%+-]+\/)*[\w.@%+-]+/g, (m) =>
			m === "~" || m.startsWith("/$bunfs") ? m : "<path>",
		);
	if (user && user.length >= 3)
		out = out.replace(new RegExp(`\\b${ESCAPE(user)}\\b`, "g"), "<user>");
	return out;
}

function safeUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

/** The message with what varies from one occurrence to the next taken out. */
function normalizeMessage(message: string): string {
	return scrub(message)
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			"<id>",
		)
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
		.replace(/%\d+/g, "%N")
		.replace(/\d+/g, "N")
		.replace(/"[^"]*"|'[^']*'/g, '"…"')
		.trim();
}

/** `fn@file` for the top frames, serenity's own first. */
function topFrames(stack: string | null, count = 3): string[] {
	if (!stack) return [];
	const frames = stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at "))
		.map((line) => {
			const m = line.match(/^at (?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/);
			const fn = m?.[1] ?? "<anonymous>";
			const file = scrub(m?.[2] ?? "").replace(/^.*\//, "");
			return { fn, file, ours: /packages\//.test(scrub(m?.[2] ?? "")) };
		});
	const ours = frames.filter((f) => f.ours);
	return (ours.length ? ours : frames)
		.slice(0, count)
		.map((f) => `${f.fn}@${f.file}`);
}

/**
 * Same bug, same signature: the error's name, its message without ids and
 * numbers, and the top frames without line numbers (they move between builds).
 */
export function crashSignature(info: CrashInfo): string {
	const key = [
		info.name,
		normalizeMessage(info.message),
		...topFrames(info.stack),
	].join("\n");
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

const fence = (text: string) =>
	`\`\`\`\n${text.replace(/```/g, "ʼʼʼ")}\n\`\`\``;

function describeExit(info: CrashInfo): string {
	if (info.signal) return `killed by ${info.signal}`;
	return `exit code ${info.code ?? "unknown"}`;
}

export function crashTitle(info: CrashInfo, signature: string): string {
	const message = normalizeMessage(info.message);
	const short = message.length > 70 ? `${message.slice(0, 69)}…` : message;
	return `Crash: ${info.name}: ${short} (sig:${signature})`;
}

export function issueBody(
	info: CrashInfo,
	env: CrashEnvironment,
	logTail: string,
	signature: string,
): string {
	return [
		`serenityd crashed (${describeExit(info)}).`,
		"",
		`- **Error:** \`${scrub(`${info.name}: ${info.message}`)}\``,
		`- **Build:** ${env.build}`,
		`- **OS:** ${env.os} · ${env.runtime}`,
		`- **Signature:** \`sig:${signature}\``,
		"",
		"### Stack",
		fence(scrub(info.stack ?? "(none)")),
		"",
		"### Recent daemon log",
		fence(scrub(logTail) || "(empty)"),
		"",
		"_Filed by serenity's crash reporter (`crashReports.enabled`). Paths, tokens and emails are redacted._",
	].join("\n");
}

export function commentBody(
	info: CrashInfo,
	env: CrashEnvironment,
	logTail: string,
	suppressed: number,
): string {
	return [
		`Happened again (${describeExit(info)}) on ${env.build}, ${env.os} · ${env.runtime}.`,
		suppressed
			? `${suppressed} more occurrence${suppressed === 1 ? "" : "s"} since the last report, not posted (rate limit).`
			: "",
		"",
		"### Recent daemon log",
		fence(scrub(logTail) || "(empty)"),
	]
		.filter((line, i) => line || i > 1)
		.join("\n");
}

/** The last `lines` lines of a file; "" when it cannot be read. */
export function tailFile(path: string, lines = LOG_LINES): string {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, 64 * 1024);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer
			.toString("utf8")
			.trimEnd()
			.split("\n")
			.slice(-lines)
			.join("\n");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** Written by a dying worker for its supervisor (ADR 0044). */
export function recordCrash(path: string, error: unknown): void {
	const e =
		error instanceof Error ? error : new Error(`non-error thrown: ${error}`);
	try {
		writeFileSync(
			path,
			JSON.stringify({ name: e.name, message: e.message, stack: e.stack }),
		);
	} catch {}
}

/** The error a worker recorded, removed once read; null when it left none. */
export function takeCrash(
	path: string,
): Pick<CrashInfo, "name" | "message" | "stack"> | null {
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			name: typeof raw.name === "string" ? raw.name : "Error",
			message: typeof raw.message === "string" ? raw.message : "",
			stack: typeof raw.stack === "string" ? raw.stack : null,
		};
	} catch {
		return null;
	} finally {
		rmSync(path, { force: true });
	}
}

interface SignatureState {
	issue: number | null;
	lastSentAt: number;
	/** Occurrences since the last GitHub write. */
	suppressed: number;
}

interface ReporterState {
	signatures: Record<string, SignatureState>;
	/** When each GitHub write of the last day happened. */
	sent: number[];
}

export interface CrashReporterOptions {
	/** crashReportsDir(home): local reports and the rate-limit state. */
	dir: string;
	enabled: boolean;
	tracker: IssueTracker;
	env: CrashEnvironment;
	now?: () => number;
	log?: (line: string) => void;
	policy?: ReportPolicy;
}

/**
 * Keeps every crash as a local report and, when the user turned it on, files
 * it on GitHub: a new issue for a new signature, a comment on the open one
 * otherwise, never more often than the policy allows (ADR 0044).
 */
export class CrashReporter {
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly policy: ReportPolicy;

	constructor(private readonly opts: CrashReporterOptions) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.policy = opts.policy ?? DEFAULT_REPORT_POLICY;
	}

	private get statePath(): string {
		return join(this.opts.dir, "state.json");
	}

	private load(): ReporterState {
		try {
			const raw = JSON.parse(readFileSync(this.statePath, "utf8"));
			return { signatures: raw.signatures ?? {}, sent: raw.sent ?? [] };
		} catch {
			return { signatures: {}, sent: [] };
		}
	}

	private save(state: ReporterState): void {
		writeFileSync(this.statePath, JSON.stringify(state, null, 2));
	}

	/** Writes the report to disk, so the user can see what is (or would be) sent. */
	private keepLocal(signature: string, body: string): void {
		const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
		writeFileSync(join(this.opts.dir, `${stamp}-${signature}.md`), body);
		const files = readdirSync(this.opts.dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
		for (const old of files.slice(0, Math.max(0, files.length - KEEP_REPORTS)))
			rmSync(join(this.opts.dir, old), { force: true });
	}

	async report(info: CrashInfo, logTail: string): Promise<ReportOutcome> {
		mkdirSync(this.opts.dir, { recursive: true });
		const signature = crashSignature(info);
		const title = crashTitle(info, signature);
		const body = issueBody(info, this.opts.env, logTail, signature);
		this.keepLocal(signature, `# ${title}\n\n${body}\n`);
		if (!this.opts.enabled) return "local-only";

		const now = this.now();
		const state = this.load();
		state.sent = state.sent.filter((at) => now - at < DAY_MS);
		const entry = state.signatures[signature] ?? {
			issue: null,
			lastSentAt: 0,
			suppressed: 0,
		};
		state.signatures[signature] = entry;
		if (
			(entry.lastSentAt > 0 &&
				now - entry.lastSentAt < this.policy.perSignatureMs) ||
			state.sent.length >= this.policy.dailyLimit
		) {
			entry.suppressed++;
			this.save(state);
			this.log(`crash ${signature}: not reported (rate limit)`);
			return "rate-limited";
		}

		// A failed write counts too, so a broken gh is not retried on every crash.
		entry.lastSentAt = now;
		state.sent.push(now);
		this.save(state);
		try {
			const open = await this.opts.tracker.findOpenIssue(`sig:${signature}`);
			if (open !== null) {
				await this.opts.tracker.commentIssue(
					open,
					commentBody(info, this.opts.env, logTail, entry.suppressed),
				);
				entry.issue = open;
			} else {
				entry.issue = await this.opts.tracker.createIssue(title, body);
			}
			const outcome = open !== null ? "commented" : "filed";
			entry.suppressed = 0;
			this.save(state);
			this.log(`crash ${signature}: ${outcome} issue #${entry.issue}`);
			return outcome;
		} catch (error) {
			this.log(
				`crash ${signature}: report failed: ${(error as Error).message}`,
			);
			return "failed";
		}
	}
}
