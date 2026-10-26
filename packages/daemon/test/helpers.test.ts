import { expect, test } from "bun:test";
import { siblingWorktreePath } from "../src/git";
import { hookSettings, shellQuote } from "../src/hooks";

test("sibling worktree paths get a suffix when taken", () => {
	const taken = new Set(["/r/demo-x", "/r/demo-x-2"]);
	expect(siblingWorktreePath("/r/demo", "y", (p) => taken.has(p))).toBe(
		"/r/demo-y",
	);
	expect(siblingWorktreePath("/r/demo", "x", (p) => taken.has(p))).toBe(
		"/r/demo-x-3",
	);
});

test("hook settings run serenity hook for every event, shell-quoted", () => {
	expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
	const settings = hookSettings(["/opt/my bin/serenity"]) as {
		hooks: Record<string, unknown>;
	};
	expect(settings.hooks.Stop).toEqual([
		{
			hooks: [
				{
					type: "command",
					command: "'/opt/my bin/serenity' hook Stop",
					timeout: 5,
				},
			],
		},
	]);
	expect(Object.keys(settings.hooks)).toContain("PermissionRequest");
	expect(settings).toMatchObject({
		statusLine: {
			type: "command",
			command: "'/opt/my bin/serenity' statusline",
		},
	});
});
