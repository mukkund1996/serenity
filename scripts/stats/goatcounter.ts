/**
 * getserenity.dev visitors, pages, events and referrers from GoatCounter.
 *
 *   bun scripts/stats/goatcounter.ts            # last 30 days
 *   bun scripts/stats/goatcounter.ts --days 7
 *
 * The dashboard and API are private. The script reads an API token from
 * $GOATCOUNTER_TOKEN, or else from ~/.config/goatcounter/token, and never
 * prints it. Create one at https://getserenity.goatcounter.com/user/api
 * with the "Read statistics" permission. See docs/analytics.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE = "https://getserenity.goatcounter.com";
const TOKEN_FILE = join(homedir(), ".config", "goatcounter", "token");

function token(): string {
	const env = process.env.GOATCOUNTER_TOKEN?.trim();
	if (env) return env;
	if (existsSync(TOKEN_FILE)) {
		const file = readFileSync(TOKEN_FILE, "utf8").trim();
		if (file) return file;
	}
	console.error(
		`No GoatCounter token. Set GOATCOUNTER_TOKEN or write one to ${TOKEN_FILE}\n` +
			`(create it at ${SITE}/user/api with "Read statistics").`,
	);
	process.exit(1);
}

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
if (!Number.isInteger(days) || days < 1) {
	console.error("--days takes a whole number of days, 1 or more");
	process.exit(1);
}
const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);
const range = `start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}`;
const auth = { Authorization: `Bearer ${token()}` };

async function api<T>(path: string): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${SITE}/api/v0/${path}`, { headers: auth });
		// The API allows a few requests a second; wait and retry when throttled.
		if (res.status === 429 && attempt < 5) {
			await Bun.sleep(1000 * (attempt + 1));
			continue;
		}
		if (!res.ok) {
			console.error(`GET /api/v0/${path}: ${res.status} ${await res.text()}`);
			process.exit(1);
		}
		return (await res.json()) as T;
	}
}

type Hit = { path: string; title: string; event: boolean; count: number };
type Ref = { name: string; count: number };

async function allHits(): Promise<Hit[]> {
	const hits: Hit[] = [];
	let exclude: number[] = [];
	for (;;) {
		const q = exclude.length ? `&exclude_paths=${exclude.join(",")}` : "";
		const page = await api<{
			hits: (Hit & { path_id: number })[];
			more: boolean;
		}>(`stats/hits?${range}&limit=100${q}`);
		hits.push(...page.hits);
		if (!page.more || page.hits.length === 0) return hits;
		exclude = exclude.concat(page.hits.map((h) => h.path_id));
	}
}

const total = await api<{ total: number; total_events: number }>(
	`stats/total?${range}`,
);
const hits = await allHits();
const refs = await api<{ stats: Ref[] }>(`stats/toprefs?${range}&limit=15`);

const row = (n: number, label: string) =>
	`  ${String(n).padStart(6)}  ${label}`;

console.log(`getserenity.dev, last ${days} days (${range.replace("&", ", ")})`);
// `total` includes events; page visits are the rest. GoatCounter counts a
// visitor once per path per session, so these are visits, not raw page loads.
console.log(
	`Page visits: ${total.total - total.total_events}   events: ${total.total_events}\n`,
);
console.log("Pages");
for (const h of hits.filter((h) => !h.event).sort((a, b) => b.count - a.count))
	console.log(row(h.count, h.path));
console.log("\nEvents");
for (const h of hits.filter((h) => h.event).sort((a, b) => b.count - a.count))
	console.log(row(h.count, h.path));
console.log("\nReferrers");
for (const r of refs.stats)
	console.log(row(r.count, r.name || "(direct / none)"));
