/**
 * Release downloads per version and asset, with the install-smoke workflow's
 * share taken out, to estimate real installs (ADR 0056).
 *
 *   bun scripts/stats/downloads.ts
 *
 * Reads through `gh api`, so it uses your gh login and never sees or prints
 * a token. GitHub doesn't say who downloaded an asset, so the CI share is
 * reconstructed from install-smoke's job history:
 * - Before ADR 0056, each install job fetched from the public release URL:
 *   a script job its binary and SHA256SUMS, a brew job its binary. A job
 *   counts against the release that was latest when it started (or the
 *   release that triggered the run).
 * - Since then, a run's `mirror` job copies the assets from the workflow
 *   artifacts of the release.yml run that built them, which GitHub doesn't
 *   count, and the install jobs read that copy. Those runs are listed but
 *   subtract nothing. (A dispatch with allow_release_download falls back to
 *   downloading, one per asset; the run's mirror job warns when it did.)
 * What is left ("other") is people: the curl installer (one SHA256SUMS per
 * install), Homebrew (a binary, no SHA256SUMS) and manual downloads.
 */

const REPO = "mukkund1996/serenity";

function ghLines(path: string, jq: string): unknown[] {
	const p = Bun.spawnSync(["gh", "api", "--paginate", path, "--jq", jq], {
		stderr: "inherit",
	});
	if (p.exitCode !== 0) {
		console.error(`gh api ${path} failed`);
		process.exit(1);
	}
	return p.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

type Release = {
	tag: string;
	published: string;
	assets: { name: string; downloads: number }[];
};
type Run = { id: number; event: string; created: string; tag: string | null };
type Job = { name: string; started: string | null; conclusion: string | null };

const releases = (
	ghLines(
		`repos/${REPO}/releases?per_page=100`,
		".[] | select(.draft | not) | select(.prerelease | not) | {tag: .tag_name, published: .published_at, assets: [.assets[] | {name, downloads: .download_count}]}",
	) as Release[]
).sort((a, b) => a.published.localeCompare(b.published));

const runs = ghLines(
	`repos/${REPO}/actions/workflows/install-smoke.yml/runs?per_page=100`,
	".workflow_runs[] | {id, event, created: .created_at, tag: (if .event == \"release\" then .head_branch else null end)}",
) as Run[];

/** The release that was latest at `when`. */
function latestAt(when: string): Release | undefined {
	return releases.filter((r) => r.published <= when).at(-1);
}

/** Assets a pre-0056 install job fetched from the public release URL. */
function assetsOf(job: string): string[] {
	if (job === "linuxbrew") return ["serenity-linux-x64"];
	const linux = /^linux \(.*, (amd64|arm64), /.exec(job);
	if (linux)
		return [
			linux[1] === "arm64" ? "serenity-linux-arm64" : "serenity-linux-x64",
			"SHA256SUMS",
		];
	const mac = /^macos \(([^,]+), ([^)]+)\)$/.exec(job);
	if (mac?.[1] && mac[2]) {
		const intel = /intel|macos-1[23]\b/.test(mac[1]);
		const bin = intel ? "serenity-darwin-x64" : "serenity-darwin-arm64";
		return mac[2] === "brew" ? [bin] : [bin, "SHA256SUMS"];
	}
	return [];
}

// ci[tag][asset] = downloads attributed to install-smoke
const ci = new Map<string, Map<string, number>>();
const runsPer = new Map<string, { legacy: number; mirrored: number }>();
for (const run of runs) {
	const jobs = ghLines(
		`repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`,
		".jobs[] | {name, started: .started_at, conclusion}",
	) as Job[];
	const mirrored = jobs.some((j) => j.name === "mirror");
	const runRelease = run.tag
		? releases.find((r) => r.tag === run.tag)
		: latestAt(run.created);
	if (runRelease) {
		const c = runsPer.get(runRelease.tag) ?? { legacy: 0, mirrored: 0 };
		if (mirrored) c.mirrored++;
		else c.legacy++;
		runsPer.set(runRelease.tag, c);
	}
	if (mirrored) continue;
	for (const job of jobs) {
		if (!job.started || job.conclusion === "skipped") continue;
		const rel = run.tag ? runRelease : latestAt(job.started);
		if (!rel) continue;
		const m = ci.get(rel.tag) ?? new Map<string, number>();
		for (const a of assetsOf(job.name)) m.set(a, (m.get(a) ?? 0) + 1);
		ci.set(rel.tag, m);
	}
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(
	`${"release".padEnd(9)} ${"asset".padEnd(22)} ${pad("downloads", 9)} ${pad("CI", 5)} ${pad("other", 6)}`,
);
let realScript = 0;
let realBinaries = 0;
for (const r of [...releases].reverse()) {
	const c = runsPer.get(r.tag) ?? { legacy: 0, mirrored: 0 };
	for (const a of [...r.assets].sort((x, y) => x.name.localeCompare(y.name))) {
		const fromCi = ci.get(r.tag)?.get(a.name) ?? 0;
		const other = Math.max(0, a.downloads - fromCi);
		if (a.name === "SHA256SUMS") realScript += other;
		else realBinaries += other;
		console.log(
			`${r.tag.padEnd(9)} ${a.name.padEnd(22)} ${pad(a.downloads, 9)} ${pad(fromCi, 5)} ${pad(other, 6)}`,
		);
	}
	console.log(
		`${"".padEnd(9)} install-smoke runs: ${c.legacy} from the public URL, ${c.mirrored} from a mirror\n`,
	);
}
console.log(
	`All releases, CI taken out: ~${realScript} curl-installer installs (SHA256SUMS), ~${realBinaries} binary downloads (installer + Homebrew + manual).`,
);
console.log(
	"Estimates: GitHub doesn't record who downloads, and a failed job may not have fetched everything it counts for.",
);
