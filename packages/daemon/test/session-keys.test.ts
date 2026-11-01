import { expect, test } from "bun:test";
import { IN_AGENT_PANE, SessionKeysKeeper, Tmux } from "../src/tmux";

/** A root key table: each list-keys read answers from `reads`; `binds` counts rebinds. */
function fakeTmux(reads: boolean[]) {
	const tmux = {
		binds: 0,
		async sessionKeysBound() {
			return reads.shift() ?? true;
		},
		async bindSessionKeys() {
			tmux.binds++;
		},
	};
	return tmux;
}

test("binds the keys again when list-keys no longer shows them", async () => {
	const tmux = fakeTmux([true, false, true]);
	const log: string[] = [];
	const keeper = new SessionKeysKeeper(tmux, (m) => log.push(m));
	await keeper.check("detach");
	expect(tmux.binds).toBe(0);
	await keeper.check("detach");
	expect(tmux.binds).toBe(1);
	expect(log).toEqual([
		"the Ctrl+q / Ctrl+w bindings were missing or changed; bound them again",
	]);
});

test("one unconfirmed rebind does not stop later repairs; it is logged once", async () => {
	// Missing, rebound but not seen; missing again twice; then missing and fixed.
	const tmux = fakeTmux([
		false,
		false,
		false,
		false,
		false,
		false,
		false,
		true,
	]);
	const log: string[] = [];
	const keeper = new SessionKeysKeeper(tmux, (m) => log.push(m));
	await keeper.check("detach");
	await keeper.check("detach");
	await keeper.check("detach");
	await keeper.check("detach");
	expect(tmux.binds).toBe(4);
	expect(log).toEqual([
		"cannot confirm the Ctrl+q / Ctrl+w bindings; binding them again on each check",
		"the Ctrl+q / Ctrl+w bindings were missing or changed; bound them again",
	]);
});

/** list-keys -T root as a given tmux prints it. */
class ListKeys extends Tmux {
	constructor(private readonly table: string) {
		super();
	}
	protected override async cmd(): Promise<string> {
		return this.table;
	}
}

const DETACH = "env SERENITY_HOME=/h /bin/bun /m.ts detach";
const line = (key: string, sends = key, when = IN_AGENT_PANE) =>
	`bind-key -T root ${key}                       if-shell -F "${when}" "run-shell -b \\"${DETACH} #{pane_id}\\"" "send-keys ${sends}"`;
const SHIFT_ENTER = `bind-key -T root S-Enter                   if-shell -F "#{@serenity_map}" "send-keys Escape '[13;2u'" "send-keys S-Enter"`;

test("sessionKeysBound reads tmux 3.6+'s table, where C-q and C-Q are apart", async () => {
	const all = [line("C-Q"), line("C-W"), line("C-q"), line("C-w"), SHIFT_ENTER];
	expect(await new ListKeys(all.join("\n")).sessionKeysBound(DETACH)).toBe(
		true,
	);
	// A lost C-Q is not covered by C-q.
	const noCapsQ = all.filter((l) => !l.includes("root C-Q"));
	expect(await new ListKeys(noCapsQ.join("\n")).sessionKeysBound(DETACH)).toBe(
		false,
	);
});

test("sessionKeysBound reads tmux 3.4's table, where C-Q replaced C-q", async () => {
	const folded = [line("C-q", "C-Q"), line("C-w", "C-W"), SHIFT_ENTER];
	expect(await new ListKeys(folded.join("\n")).sessionKeysBound(DETACH)).toBe(
		true,
	);
	expect(
		await new ListKeys(folded.slice(1).join("\n")).sessionKeysBound(DETACH),
	).toBe(false);
});

test("sessionKeysBound takes a binding from before ADR 0054 as changed, so it is bound again", async () => {
	const old = ["C-Q", "C-W", "C-q", "C-w"].map((k) =>
		line(k, k, "#{@serenity_session}"),
	);
	expect(
		await new ListKeys([...old, SHIFT_ENTER].join("\n")).sessionKeysBound(
			DETACH,
		),
	).toBe(false);
});

test("bindSessionKeys tests the marker against empty, which a session id starting with 0 passes", async () => {
	const sent: string[][] = [];
	class Recording extends Tmux {
		protected override async cmd(args: string[]): Promise<string> {
			sent.push(args);
			return "";
		}
	}
	await new Recording().bindSessionKeys(DETACH);
	const conditions = sent
		.filter((a) => a[0] === "bind-key" && /^C-[qQwW]$/.test(a[2] ?? ""))
		.map((a) => a[5]);
	expect(conditions).toEqual(Array(4).fill("#{!=:#{@serenity_session},}"));
});
