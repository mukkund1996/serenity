#!/usr/bin/env bun
/**
 * A stand-in for `gh` in E2E tests. PRs are JSON files in
 * $SERENITY_FAKE_GH_DIR named after their branch:
 *   gh pr view <branch> --json …        → prints <branch>.json, or "no PR"
 *   gh pr edit <n> --add-reviewer <who> → logs "<n> <who>" to edits.log and
 *                                         adds the request to that PR's file
 *   gh pr list --search … --json …      → review-requests.json, or []
 *   gh api user --jq .login             → "me"
 */
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const dir = process.env.SERENITY_FAKE_GH_DIR ?? ".";
const [group, command, target, ...rest] = process.argv.slice(2);

if (group === "api" && command === "user") {
	console.log("me");
	process.exit(0);
}

if (group === "pr" && command === "view") {
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

console.error(`fake gh: unsupported ${process.argv.slice(2).join(" ")}`);
process.exit(1);
