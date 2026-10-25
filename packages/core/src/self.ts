/**
 * How to invoke this same serenity build from another process (hooks, the
 * daemon, tmux bindings): the compiled binary, or `bun <entry script>` in dev.
 * SERENITY_SELF (a JSON array) overrides it.
 */
export function selfCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.SERENITY_SELF) return JSON.parse(env.SERENITY_SELF) as string[];
	const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");
	return compiled ? [process.execPath] : [process.execPath, Bun.main];
}
