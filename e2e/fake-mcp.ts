/**
 * `claude mcp …` for the fake claudes (e2e/fake-claude.ts and the demo's
 * agent.ts): Slack's server registered or not, logged in or not, kept in
 * `fake-mcp.json` under CLAUDE_CONFIG_DIR. Prints what Claude Code prints,
 * closely enough for serenity's checks (ADR 0065).
 *   mcp add-json -s local <name> <json>   registers it
 *   mcp remove -s local <name>            unregisters it (the login stays)
 *   mcp get <name>                        "Status: ✓ Connected" or
 *                                         "! Needs authentication"
 *   mcp login <name>                      a browser-login look-alike: waits
 *                                         SERENITY_FAKE_MCP_LOGIN_MS, then
 *                                         logged in
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface State {
	registered: string[];
	loggedIn: string[];
}

const file = () => join(process.env.CLAUDE_CONFIG_DIR ?? ".", "fake-mcp.json");

function load(): State {
	try {
		return JSON.parse(readFileSync(file(), "utf8"));
	} catch {
		return { registered: [], loggedIn: [] };
	}
}

function save(state: State): void {
	const dir = process.env.CLAUDE_CONFIG_DIR ?? ".";
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(file(), JSON.stringify(state));
}

/** Handles `args` (after "mcp") and exits. */
export async function fakeMcp(args: string[]): Promise<never> {
	const [command, ...rest] = args;
	const name = rest.filter((a) => !a.startsWith("-") && a !== "local")[0] ?? "";
	const state = load();
	if (command === "add-json") {
		state.registered = [...new Set([...state.registered, name])];
		save(state);
		console.log(`Added http MCP server ${name} to local config`);
		process.exit(0);
	}
	if (command === "remove") {
		state.registered = state.registered.filter((n) => n !== name);
		save(state);
		process.exit(0);
	}
	if (command === "get") {
		if (!state.registered.includes(name)) {
			console.error(`No MCP server found with name: ${name}`);
			process.exit(1);
		}
		const ok = state.loggedIn.includes(name);
		console.log(
			`${name}:\n  Scope: Local config\n  Status: ${ok ? "✓ Connected" : "! Needs authentication"}\n  Type: http`,
		);
		process.exit(0);
	}
	if (command === "login") {
		console.log("Opening your browser to sign in to slack…");
		console.log("Waiting for the sign-in to finish in the browser.");
		await Bun.sleep(Number(process.env.SERENITY_FAKE_MCP_LOGIN_MS ?? 300));
		state.loggedIn = [...new Set([...state.loggedIn, name])];
		save(state);
		console.log(`✓ Authenticated with ${name}.`);
		process.exit(0);
	}
	console.error(`fake claude: unsupported mcp ${args.join(" ")}`);
	process.exit(1);
}
