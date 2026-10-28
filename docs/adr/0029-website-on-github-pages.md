# 0029 · The website: static page on GitHub Pages at getserenity.dev, version filled in at deploy

**Status:** Accepted · 2026-10-28

## Context
serenity needs a landing page. It was designed on a Claude Design canvas ([source](https://claude.ai/artifact/ES8rj8QgexBYgGDyns5cdp)): one fluid page with a scroll story, an install section and a footer, checked at desktop, tablet (834) and phone (390) widths. The page shows the current release, and must never show an older one than the latest release.

## Decision
- **Hosting:** GitHub Pages from this repo, domain `getserenity.dev` (registered at Namecheap; Namecheap DNS points the apex at GitHub's A/AAAA records and `www` at `mukkund1996.github.io`). The site is free to host and lives beside the code it describes.
- **Source:** `website/` holds plain `index.html`, `site.js` and `favicon.svg`; no framework or build step. The markup is the canvas's `Main.dc.html` with its template holes turned into `data-st` style templates (and `data-t` text), and `site.js` carries the canvas's `renderVals()` unchanged, filling those templates on every scroll frame. A design change on the canvas is ported the same way.
- **Version:** the page holds `__SERENITY_VERSION__`; `.github/workflows/website.yml` replaces it with the latest published release's tag (`gh release view`, falling back to `.release-please-manifest.json`) and deploys. It runs on pushes to `main` that touch the site, on published releases, and when the `release` workflow finishes: release-please creates releases with `GITHUB_TOKEN`, which does not fire `release` events. Visitors make no extra request for the version.
- The `BETA` pill and footer note stay in the markup while serenity is pre-1.0.

## Consequences
- A new release redeploys the site within minutes of the release workflow finishing; between the tag and that redeploy the page shows the previous version.
- Pages must use "GitHub Actions" as its source, with `getserenity.dev` as the custom domain and HTTPS enforced (`.dev` is HTTPS-only).
- Opening `website/index.html` locally shows `__SERENITY_VERSION__` in place of the version.
