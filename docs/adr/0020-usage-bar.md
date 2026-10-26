# 0020 · A usage bar in the header: plan limits and the average wait on you

**Status:** Accepted · 2026-10-26

## Context
Running many agents at once spends a Claude plan fast, and the map gave no hint of how much was left. Claude Code shows the 5-hour session limit and the weekly limit in `/usage`, which is one session at a time. It also had no measure of how long agents sit blocked on you.

Hooks carry no usage. Claude Code's status line JSON does: on a subscription plan it has `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`. Reading Claude's OAuth token to call its usage endpoint was rejected: the endpoint is undocumented and the token is the user's.

## Decision
- **Usage from the status line.** The `--settings` file given to spawned sessions (0006) also sets `statusLine` to `serenity statusline`. It forwards `rate_limits` to a running daemon (`usage.report`) and never starts one, since the status line runs often.
- **The user's own status line still shows.** `--settings` overrides it, so `serenity statusline` runs the user's `statusLine` command (local, then project, then user settings, as Claude reads them) with the same JSON on stdin and prints its output. It is cut off after 3 s.
- **Usage is per account.** The daemon keeps the latest report in memory and sends it to every repo's clients, only when the numbers change. A limit past its `resets_at` reads 0% until a session reports again.
- **Average wait on you.** A session's `waitingSince` is set when it enters waiting (permission, question, startup prompt) and cleared when it leaves. A wait that ends with the session moving on is stored (`waits` table); one that ends with the session ended or archived was never answered and is not. The average is over this repo's waits that ended in the last 24 hours.
- **Where it shows.** The header of the topics and map zooms, right after the repo name: `session 42% · week 17% · avg wait 3m`. Unknown values are `—`. At 80% a limit turns yellow and shows its reset (`↻1h05m`); at 95% it turns red. The repo name truncates first, so the bar always fits.

## Consequences
- Usage is known only after a spawned session has had an API reply, and goes stale when no spawned session is active. Adopted sessions not yet restarted (0016) report none. API-key, Bedrock and Vertex users see `—`.
- A daemon restart forgets usage until the next report. Waits are kept.
- The user's `statusLine` `padding` and `refreshInterval` are not carried over.
