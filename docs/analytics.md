# Analytics: where the numbers are and how to read them

For maintainers and agents asked "how many installs / visitors do we have?". Serenity has no telemetry in the CLI itself. There are two sources, and neither counts users directly.

## 1. Installs: GitHub release downloads

```bash
bun scripts/stats/downloads.ts
```

Prints downloads per release and asset, with the install-smoke CI share taken out (ADR 0056). Uses your `gh` login.

- **"other" is the real-user estimate.** A curl install fetches one `SHA256SUMS`, so its count ≈ curl-installer installs. Binary counts also include Homebrew and manual downloads.
- **Raw `download_count`, clone and traffic numbers are mostly CI.** Don't report them as adoption.
- **Don't download release assets to test.** `gh release download` and API downloads bump the counts too, minutes later. Use `scripts/install-smoke/mirror.sh <tag> <dir>` instead.

## 2. Website: GoatCounter (getserenity.dev)

```bash
bun scripts/stats/goatcounter.ts            # last 30 days
bun scripts/stats/goatcounter.ts --days 7
```

Prints visitors, page views per path, events and top referrers.

**Access is private.** The dashboard is <https://getserenity.goatcounter.com> (maintainer login). The script needs an API token, which it reads from `$GOATCOUNTER_TOKEN` or else from `~/.config/goatcounter/token`. It never prints the token. The maintainer keeps it in 1Password as the item *GoatCounter* (field `credential`). Pass it in without echoing it:

```bash
GOATCOUNTER_TOKEN="$(op read 'op://Employee/GoatCounter/credential')" bun scripts/stats/goatcounter.ts
```

To create a new token: dashboard → *Settings → API* (<https://getserenity.goatcounter.com/user/api>), with the *Read statistics* permission. Agents: only read the token from 1Password when the maintainer asks you to.

**What gets counted** (defined in `website/analytics.js`, plus `data-goatcounter-click` in the HTML):

| Event path | Meaning |
| --- | --- |
| `install-copy-quick`, `install-copy-curl`, `install-copy-brew` | a copy button for an install command on the landing page: the closest thing to "intent to install" |
| `reached-install` | the landing `#install` section scrolled into view |
| `docs-copy: <command>` | a copy button on the docs page |
| `star-<page>-nav`, `star-landing-install` | a "Star on GitHub" click |
| `story-watch` | the landing story's WATCH button |
| `outbound: <host/path>` | any other link off the site |

**Caveats:**
- An install-copy event is not an install. Compare it with the release "other" numbers for the same period.
- Maintainer visits are excluded only from browsers that opened `#toggle-goatcounter`, and from IPs on the dashboard's ignore list (CONTRIBUTING.md, Maintainers). Localhost, LAN addresses and `file://` are never counted.
- Ad blockers often block `gc.zgo.at`, so counts run low, and by how much changes over time.
