import { spawnSync } from "node:child_process";

export interface Check {
	name: string;
	ok: boolean;
	required: boolean;
	detail: string;
}

function output(command: string[]): { ok: boolean; text: string } {
	const result = spawnSync(command[0] as string, command.slice(1), {
		encoding: "utf8",
	});
	if (result.error) return { ok: false, text: "" };
	return {
		ok: result.status === 0,
		text: `${result.stdout}${result.stderr}`.trim(),
	};
}

/** tmux ≥ 3.2 is needed for the join-pane / pane-option features we use. */
export function tmuxVersionOk(versionText: string): boolean {
	const match = versionText.match(/(\d+)\.(\d+)/);
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return major > 3 || (major === 3 && minor >= 2);
}

export function runChecks(): Check[] {
	const tmux = output(["tmux", "-V"]);
	const claude = output([
		process.env.SERENITY_CLAUDE_BIN ?? "claude",
		"--version",
	]);
	const git = output(["git", "--version"]);
	const gh = output(["gh", "auth", "status"]);
	return [
		{
			name: "tmux",
			required: true,
			ok: tmux.ok && tmuxVersionOk(tmux.text),
			detail: tmux.ok
				? `${tmux.text}${tmuxVersionOk(tmux.text) ? "" : " (need 3.2 or newer)"}`
				: "not found · brew install tmux",
		},
		{
			name: "claude",
			required: true,
			ok: claude.ok,
			detail: claude.ok
				? (claude.text.split("\n")[0] ?? "")
				: "not found · https://claude.com/claude-code",
		},
		{
			name: "git",
			required: true,
			ok: git.ok,
			detail: git.ok ? git.text : "not found",
		},
		{
			name: "gh",
			required: false,
			ok: gh.ok,
			detail: gh.ok
				? "authenticated"
				: "missing or not logged in · PR status needs it later (gh auth login)",
		},
	];
}

export function printChecks(checks: Check[]): boolean {
	for (const c of checks) {
		const mark = c.ok
			? "\x1b[32m✓\x1b[0m"
			: c.required
				? "\x1b[31m✗\x1b[0m"
				: "\x1b[33m!\x1b[0m";
		console.log(`${mark} ${c.name.padEnd(7)} ${c.detail}`);
	}
	return checks.every((c) => c.ok || !c.required);
}
