#!/usr/bin/env bun
/**
 * A stand-in for `gh` in E2E tests. PRs are JSON files in
 * $SERENITY_FAKE_GH_DIR named after their branch:
 *   gh pr view <branch> --json …        → prints <branch>.json, or "no PR"
 *   gh pr view <number> --json …        → the fixture with that number
 *   gh pr edit <n> --add-reviewer <who> → logs "<n> <who>" to edits.log and
 *                                         adds the request to that PR's file
 *   gh pr list --search … --json …      → review-requests.json, or []
 *   gh api user --jq .login             → "me"
 *   gh --version                        → a version line
 *   gh auth status                      → logged in as "me", unless the
 *                                         file logged-out exists
 *   gh auth login …                     → a device-flow look-alike: waits
 *                                         for Enter, then removes logged-out
 *   gh issue list --search '"<x>" in:title' → open issues in issues.json
 *                                         whose title contains <x>
 *   gh issue create --title … --body …  → appends to issues.json, prints its URL
 *   gh issue comment <n> --body …       → appends to comments.json
 */
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const dir = process.env.SERENITY_FAKE_GH_DIR ?? ".";
const [group, command, target, ...rest] = process.argv.slice(2);

const loggedOut = () => existsSync(join(dir, "logged-out"));
const login = () => process.env.SERENITY_FAKE_GH_LOGIN ?? "me";

if (group === "--version") {
	console.log("gh version 2.0.0 (fake)");
	process.exit(0);
}

if (group === "auth" && command === "status") {
	if (loggedOut()) {
		console.error(
			"You are not logged into any GitHub hosts. To log in, run: gh auth login",
		);
		process.exit(1);
	}
	console.log(
		`github.com\n  ✓ Logged in to github.com account ${login()} (keyring)`,
	);
	process.exit(0);
}

if (group === "auth" && command === "login") {
	console.log("! First copy your one-time code: DEMO-1234");
	console.log(
		"Press Enter to open https://github.com/login/device in your browser...",
	);
	for await (const chunk of process.stdin) if (chunk.includes(10)) break;
	await Bun.sleep(Number(process.env.SERENITY_FAKE_GH_LOGIN_MS ?? 800));
	rmSync(join(dir, "logged-out"), { force: true });
	console.log("✓ Authentication complete.");
	console.log(`✓ Logged in as ${login()}`);
	process.exit(0);
}

if (group === "api" && command === "user") {
	if (loggedOut()) process.exit(1);
	console.log("me");
	process.exit(0);
}

if (group === "pr" && command === "view") {
	if (/^\d+$/.test(target ?? "")) {
		for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			const text = readFileSync(join(dir, name), "utf8");
			if (String(JSON.parse(text).number) !== target) continue;
			process.stdout.write(text);
			process.exit(0);
		}
		console.error(`no pull requests found for #${target}`);
		process.exit(1);
	}
	const file = join(dir, `${target}.json`);
	if (!existsSync(file)) {
		console.error(`no pull requests found for branch "${target}"`);
		process.exit(1);
	}
	process.stdout.write(readFileSync(file, "utf8"));
	process.exit(0);
}

if (group === "pr" && command === "list") {
	const file = join(dir, "review-requests.json");
	process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "[]");
	process.exit(0);
}

if (group === "pr" && command === "edit") {
	const reviewer = rest[rest.indexOf("--add-reviewer") + 1] as string;
	appendFileSync(join(dir, "edits.log"), `${target} ${reviewer}\n`);
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		const pr = JSON.parse(readFileSync(join(dir, name), "utf8"));
		if (String(pr.number) !== target) continue;
		pr.reviewRequests = [...(pr.reviewRequests ?? []), { login: reviewer }];
		writeFileSync(join(dir, name), JSON.stringify(pr));
	}
	process.exit(0);
}

const flag = (name: string) => {
	const args = process.argv.slice(2);
	return args[args.indexOf(name) + 1] ?? "";
};
const readJson = (name: string) => {
	const file = join(dir, name);
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
};

if (group === "issue" && command === "list") {
	const needle = flag("--search").match(/"([^"]+)"/)?.[1] ?? "";
	const issues = readJson("issues.json") as {
		number: number;
		title: string;
		state: string;
	}[];
	const found = issues
		.filter((i) => i.state === "open" && i.title.includes(needle))
		.map(({ number, title }) => ({ number, title }));
	process.stdout.write(JSON.stringify(found));
	process.exit(0);
}

if (group === "issue" && command === "create") {
	const issues = readJson("issues.json");
	const number = issues.length + 1;
	issues.push({
		number,
		repo: flag("--repo"),
		title: flag("--title"),
		body: flag("--body"),
		state: "open",
	});
	writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
	console.log(`https://github.com/${flag("--repo")}/issues/${number}`);
	process.exit(0);
}

if (group === "issue" && command === "comment") {
	const comments = readJson("comments.json");
	comments.push({ issue: Number(target), body: flag("--body") });
	writeFileSync(join(dir, "comments.json"), JSON.stringify(comments));
	process.exit(0);
}

console.error(`fake gh: unsupported ${process.argv.slice(2).join(" ")}`);
process.exit(1);
