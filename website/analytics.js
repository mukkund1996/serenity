// GoatCounter events shared by every page of the website (no cookies, no personal data).
// count.js loads async and may be blocked, so every call is optional. Events:
//   star-<page>-nav, star-landing-install   Star on GitHub (data-goatcounter-click in the markup)
//   story-watch                             the landing story's WATCH button (same)
//   install-copy-<quick|curl|brew>          a landing copy button (site.js)
//   docs-copy: <command>                    a docs copy button (docs/docs.js)
//   reached-install                         the landing #install section came into view (site.js)
//   outbound: <host/path>                   any other link off the site (below)

window.srnEvent = (path, title) => {
	try {
		window.goatcounter?.count?.({ path, title, event: true });
	} catch {}
};

document.addEventListener(
	"click",
	(e) => {
		const a = e.target.closest?.("a[href]");
		if (!a || a.hasAttribute("data-goatcounter-click")) return;
		const url = new URL(a.href, location.href);
		if (url.host === location.host || !url.protocol.startsWith("http")) return;
		window.srnEvent(
			`outbound: ${url.host}${url.pathname}${url.hash}`.replace(/\/$/, ""),
			a.textContent.trim().replace(/\s+/g, " ").slice(0, 80) || url.href,
		);
	},
	{ capture: true },
);
