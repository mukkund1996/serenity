import { expect, test } from "bun:test";
import { classifyGhError, Gh } from "../src/gh";

test("gh errors: quiet when there is simply no PR, a reason otherwise", () => {
	expect(classifyGhError('no pull requests found for branch "x"')).toBeNull();
	expect(
		classifyGhError(
			"none of the git remotes configured for this repository point to a known GitHub host",
		),
	).toBeNull();
	expect(
		classifyGhError(
			"To get started with GitHub CLI, please run:  gh auth login",
		),
	).toBe("gh not logged in");
	expect(classifyGhError("HTTP 502: Bad Gateway\nmore")).toBe(
		"HTTP 502: Bad Gateway",
	);
});

test("a missing gh binary reads as not installed", async () => {
	const lookup = await new Gh("/nonexistent/gh").prForBranch("/tmp", "x");
	expect(lookup).toEqual({ pr: null, error: "gh not installed" });
});
