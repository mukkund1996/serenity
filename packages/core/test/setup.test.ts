/** The setup steps' texts and parsers (ADR 0065, 0066). */
import { expect, test } from "bun:test";
import {
	describeSetupStatus,
	importSummary,
	nextOpenStep,
	parseGhAuthStatus,
	parseMcpGet,
	SETUP_STEPS,
	type SetupStatus,
	setupDone,
	setupIntro,
} from "../src";

test("gh auth status names the account, in new and old wording", () => {
	expect(
		parseGhAuthStatus(
			"github.com\n  ✓ Logged in to github.com account sam-demo (keyring)\n  - Token: gho_************************************",
		),
	).toBe("sam-demo");
	expect(
		parseGhAuthStatus(
			"github.com\n  ✓ Logged in to github.com as old-style (oauth_token)",
		),
	).toBe("old-style");
	expect(
		parseGhAuthStatus(
			"You are not logged into any GitHub hosts. To log in, run: gh auth login",
		),
	).toBeNull();
});

test("claude mcp get: connected, needs a login, missing, or failing", () => {
	const get = (status: string) =>
		`slack:\n  Scope: Local config\n  Status: ${status}\n  Type: http`;
	expect(parseMcpGet(true, get("✓ Connected"))).toBe("connected");
	expect(parseMcpGet(true, get("! Needs authentication"))).toBe("needs-login");
	expect(parseMcpGet(true, get("✗ Failed to connect"))).toBe("failed");
	expect(parseMcpGet(false, "No MCP server found with name: slack")).toBe(
		"missing",
	);
});

const status = (over: Partial<SetupStatus>): SetupStatus => ({
	id: "github",
	connected: false,
	user: null,
	problem: null,
	...over,
});

test("a status reads as who is connected, or what is missing", () => {
	expect(describeSetupStatus(status({ connected: true, user: "sam" }))).toBe(
		"connected as sam",
	);
	expect(describeSetupStatus(status({ connected: true }))).toBe("connected");
	expect(describeSetupStatus(status({ problem: "not logged in" }))).toBe(
		"not logged in",
	);
	expect(describeSetupStatus(status({}))).toBe("not connected");
	expect(
		describeSetupStatus(
			status({ id: "slack", connected: true, user: "Sam (Acme)", on: false }),
		),
	).toBe("connected as Sam (Acme) · off for this repo");
});

test("Slack is done once connected and on for this repo; GitHub once connected", () => {
	expect(setupDone(status({ connected: true }))).toBe(true);
	expect(setupDone(status({ id: "slack", connected: true, on: false }))).toBe(
		false,
	);
	expect(setupDone(status({ id: "slack", connected: true, on: true }))).toBe(
		true,
	);
	expect(setupDone(status({ id: "slack", connected: false, on: true }))).toBe(
		false,
	);
});

test("each step has a command and says what it gives in one line", () => {
	expect(SETUP_STEPS.map((s) => s.id)).toEqual(["github", "slack"]);
	for (const step of SETUP_STEPS) {
		expect(step.command).toBe(`serenity setup ${step.id}`);
		expect(step.gives.length).toBeGreaterThan(0);
		expect(step.gives.length).toBeLessThanOrEqual(50);
	}
	expect(SETUP_STEPS.find((s) => s.id === "slack")?.link).toContain(
		"PRIVACY.md",
	);
});

test("the welcome panel's intro counts its steps and points at the docs", () => {
	expect(setupIntro(3)).toBe(
		"Three optional steps. More: getserenity.dev/docs",
	);
	expect(setupIntro(1)).toBe("One optional step. More: getserenity.dev/docs");
});

test("the import step says what it found, or what happened", () => {
	expect(importSummary(12, 14, "todo")).toBe("12 past sessions, last 14 days");
	expect(importSummary(1, 14, "todo")).toBe("1 past session, last 14 days");
	expect(importSummary(12, 14, "done", 3)).toBe("imported 3");
	expect(importSummary(12, 14, "skipped")).toBe("skipped");
});

test("Enter or s goes to the next step left to do, then to You're set", () => {
	// GitHub done, Slack and Import to do: from Slack to Import.
	expect(nextOpenStep([false, false, true], 1)).toBe(2);
	// From the first, skipping one already done.
	expect(nextOpenStep([false, false, true], 0)).toBe(2);
	// One passed over with ↓ is still to do: back to it.
	expect(nextOpenStep([true, false, false], 2)).toBe(0);
	// Nothing left: the "You're set" line, past the last step.
	expect(nextOpenStep([false, false], 1)).toBe(2);
	// The start: the first step to do.
	expect(nextOpenStep([false, true], -1)).toBe(1);
});
