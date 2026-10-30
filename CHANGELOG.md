# Changelog

## [0.8.0](https://github.com/mukkund1996/serenity/compare/v0.7.0...v0.8.0) (2026-10-30)


### Features

* [@copy](https://github.com/copy) and [@handover](https://github.com/handover) hand a session's work over through a handover doc, shareable on Slack as a file (ADR 0049) ([#52](https://github.com/mukkund1996/serenity/issues/52)) ([d7e8535](https://github.com/mukkund1996/serenity/commit/d7e8535a9c5c593dd3b3a84a4534be3bdb76b4be))
* [@new](https://github.com/new) starts sessions from a brief at once, and command words are never session names (ADR 0048) ([#50](https://github.com/mukkund1996/serenity/issues/50)) ([ba088a3](https://github.com/mukkund1996/serenity/commit/ba088a33faf8e928e52cba2aff58980dd5fd6349))
* Enter marks NEEDS YOU items seen, ◆ says what y does to whom, Slack follow-ups tell a session or start one (ADR 0050) ([#53](https://github.com/mukkund1996/serenity/issues/53)) ([e39dd33](https://github.com/mukkund1996/serenity/commit/e39dd33873bf92c369f153760bb9550f1a2e7cba))


### Bug Fixes

* Ctrl+g in an agent pane always reaches serenity, never claude's editor (ADR 0051) ([#54](https://github.com/mukkund1996/serenity/issues/54)) ([1380414](https://github.com/mukkund1996/serenity/commit/13804142f160f863b96172d9998339ffdbd1a6ab))

## [0.7.0](https://github.com/mukkund1996/serenity/compare/v0.6.0...v0.7.0) (2026-10-30)


### Features

* a card pulses when the master messages it, the master when the session answers ([#38](https://github.com/mukkund1996/serenity/issues/38)) ([fe92360](https://github.com/mukkund1996/serenity/commit/fe92360b8ca88739b62d6d3dbf519893bf00c0b5))
* a supervisor restarts the daemon, crashes become deduped issues, state survives a restart ([#46](https://github.com/mukkund1996/serenity/issues/46)) ([82b2776](https://github.com/mukkund1996/serenity/commit/82b27761f3f90b7f7e7ab7ed621ccc24735a2fe7))
* an [@session](https://github.com/session) message is relayed to the session; the master never looks into it ([#37](https://github.com/mukkund1996/serenity/issues/37)) ([4a601df](https://github.com/mukkund1996/serenity/commit/4a601df215f86b6e5b65b8f1f64238c09043e84c))
* claude restarts in its pane when it exits, resuming its conversation (ADR 0044) ([#44](https://github.com/mukkund1996/serenity/issues/44)) ([2321967](https://github.com/mukkund1996/serenity/commit/2321967d112c4817182dfe870415a014f5c975c2))
* dependency calls retry with backoff; the map reconnects on its own; lasting failures show in the header ([#45](https://github.com/mukkund1996/serenity/issues/45)) ([96cf9c1](https://github.com/mukkund1996/serenity/commit/96cf9c1d6cbb7a13408681b56a3e0d358728c966))
* finer topics, and a topic move waits while a session works or the user types (ADR 0047) ([#48](https://github.com/mukkund1996/serenity/issues/48)) ([71a2afd](https://github.com/mukkund1996/serenity/commit/71a2afd223c826efabaf5ef6034b2fc87ef768f9))
* i opens the master input and it stays open; [@session](https://github.com/session) acts on a session at once ([#36](https://github.com/mukkund1996/serenity/issues/36)) ([730862b](https://github.com/mukkund1996/serenity/commit/730862bc255aa925939f358835c0e05318cfaa14))
* Shift+Enter starts a new line in the master input; Enter still sends ([#39](https://github.com/mukkund1996/serenity/issues/39)) ([0831fbb](https://github.com/mukkund1996/serenity/commit/0831fbb028baf705e71bf249a6036d9e4017a7ab))
* Slack is read every minute, and within 15 s of opening a map ([#34](https://github.com/mukkund1996/serenity/issues/34)) ([86debf8](https://github.com/mukkund1996/serenity/commit/86debf890101ec93ae8c955df3252256ed86c45b))
* Slack joins NEEDS YOU, only mentions and DMs that need an action ([#29](https://github.com/mukkund1996/serenity/issues/29)) ([8ca8f2e](https://github.com/mukkund1996/serenity/commit/8ca8f2e5233cf58ddec5c64841a48eb635a92ea1))
* the master gets a skill, runs in auto mode, and sends Slack messages once confirmed in the chat ([#26](https://github.com/mukkund1996/serenity/issues/26)) ([f264c32](https://github.com/mukkund1996/serenity/commit/f264c32da3249dcf328b2200ece67331f5ee1e8e))
* the master reads session status on demand and watches sessions; hook status is checked against Claude's own ([#30](https://github.com/mukkund1996/serenity/issues/30)) ([7a8b47f](https://github.com/mukkund1996/serenity/commit/7a8b47f49a5fcddb1b79d5f7131f0561116a71f6))
* the master sends replies the user asked for with send_reply ([#33](https://github.com/mukkund1996/serenity/issues/33)) ([18d6142](https://github.com/mukkund1996/serenity/commit/18d61426b1fe0a251d6dd630e9651b2ffd1e2c9c))
* the master shows four messages; PgUp PgDn scroll its conversation ([#41](https://github.com/mukkund1996/serenity/issues/41)) ([72a8d30](https://github.com/mukkund1996/serenity/commit/72a8d30ab6841868e66505350e8e31d61ba6c583))
* the master starts sessions from a brief with create_session ([#31](https://github.com/mukkund1996/serenity/issues/31)) ([bb3fd5b](https://github.com/mukkund1996/serenity/commit/bb3fd5b76998981e1b70855da8de1469ddbe3f65))
* the master survives crashes, hangs and daemon restarts (ADR 0046) ([fe6677b](https://github.com/mukkund1996/serenity/commit/fe6677ba6df7122640c3706f0a4d8d08217592ce))
* the master's queue holds the replies it wants to send, apart from NEEDS YOU ([#40](https://github.com/mukkund1996/serenity/issues/40)) ([bd1a07a](https://github.com/mukkund1996/serenity/commit/bd1a07ac0efe92b1f42e76cb1adc2ae54d4cc639))
* three master messages, an eased pulse, and text fields that edit at a cursor ([#42](https://github.com/mukkund1996/serenity/issues/42)) ([8d40319](https://github.com/mukkund1996/serenity/commit/8d403196a4bc26a5bbab32247b6775ab6682eb33))
* x dismisses a Slack item from NEEDS YOU, for good, by message ([#32](https://github.com/mukkund1996/serenity/issues/32)) ([3a38d93](https://github.com/mukkund1996/serenity/commit/3a38d9309030380f276a7258da420e1370296d84))


### Bug Fixes

* a session name means the live session, not an archived one that shares it ([#35](https://github.com/mukkund1996/serenity/issues/35)) ([6296d55](https://github.com/mukkund1996/serenity/commit/6296d55bbb27bfe1e175e2385696eba82b41c920))
* Ctrl+g gets back to the map after a daemon restart, and never falls through to claude after /clear ([#47](https://github.com/mukkund1996/serenity/issues/47)) ([3382895](https://github.com/mukkund1996/serenity/commit/3382895f830da0b7583a4f4cb32e7b302641527d))

## [0.6.0](https://github.com/mukkund1996/serenity/compare/v0.5.0...v0.6.0) (2026-10-27)


### Features

* the master sits in the centre of the topics zoom, topics on both sides ([#20](https://github.com/mukkund1996/serenity/issues/20)) ([303f0ac](https://github.com/mukkund1996/serenity/commit/303f0acd9e0e088d5d61c9c91db671d0e5eb8af0))


### Bug Fixes

* Enter attaches a card and i messages it; only the master is gone into ([#22](https://github.com/mukkund1996/serenity/issues/22)) ([de0a3ae](https://github.com/mukkund1996/serenity/commit/de0a3ae60886476222b8fdc6b15be5170decd00f))

## [0.5.0](https://github.com/mukkund1996/serenity/compare/v0.4.0...v0.5.0) (2026-10-27)


### Features

* archived sessions off the map; K kills an agent; master can kill and open ([#5](https://github.com/mukkund1996/serenity/issues/5)) ([8bbb0f1](https://github.com/mukkund1996/serenity/commit/8bbb0f1ce03c50762865de83400edd6558d63904))
* arrow keys between nodes, Enter into a node, Esc out; Ctrl+m focuses the master ([#14](https://github.com/mukkund1996/serenity/issues/14)) ([f884333](https://github.com/mukkund1996/serenity/commit/f884333f76b43dcde19fc5c64f1302e3c527bd7a))
* first prompt in the new session dialog; readable dialog headers ([#6](https://github.com/mukkund1996/serenity/issues/6)) ([aeea379](https://github.com/mukkund1996/serenity/commit/aeea37951c39dbe1ccb31041dd105978a982047a))
* import claude sessions running in tmux; dogfooding setup ([d64dfc7](https://github.com/mukkund1996/serenity/commit/d64dfc785692dc376d662dfbad6b3308f1aca143))
* map zoom; z/Z/Esc between zooms; c, / search, r rename ([#9](https://github.com/mukkund1996/serenity/issues/9)) ([067ed53](https://github.com/mukkund1996/serenity/commit/067ed53ff6faab3a4e413f8095408a132655cf86))
* master overview with review requests, my PRs and sessions ([#8](https://github.com/mukkund1996/serenity/issues/8)) ([b527ae6](https://github.com/mukkund1996/serenity/commit/b527ae682ba4fb147a401e0209fcff0e40792708))
* milestone 1 walking skeleton ([b44f235](https://github.com/mukkund1996/serenity/commit/b44f2357618fcc376ef91d41fc33b6aea5138180))
* milestone 2, the master ([8f3b13f](https://github.com/mukkund1996/serenity/commit/8f3b13fbe2d4baf16b61b40af70d4a68319925fc))
* milestone 3, pull requests ([6ff719f](https://github.com/mukkund1996/serenity/commit/6ff719f23a3d51e24db166ed159b6fee25408674))
* node focus on the map; WASD between nodes, arrows inside them ([#2](https://github.com/mukkund1996/serenity/issues/2)) ([391315f](https://github.com/mukkund1996/serenity/commit/391315f7186194e8949aa648331dae22c8e2cc74))
* one-command install: install.sh and a Homebrew formula bring tmux, git, gh and Claude Code; release workflow ([#16](https://github.com/mukkund1996/serenity/issues/16)) ([0f33702](https://github.com/mukkund1996/serenity/commit/0f337029e435174602da2f2d65d6f8e32c005311))
* p pins a session for reuse; pinned topic, never done, resumed on attach ([#13](https://github.com/mukkund1996/serenity/issues/13)) ([a4f27de](https://github.com/mukkund1996/serenity/commit/a4f27de45baa6d7435defbbafb76829c055ff955))
* Slack under the master: threads and mentions waiting on you, [ ] to cycle; the chat reads Slack ([#17](https://github.com/mukkund1996/serenity/issues/17)) ([3e5ad84](https://github.com/mukkund1996/serenity/commit/3e5ad84af22c6c505c968bceb8c087c1d9eae30d))
* the master suggests Slack replies from your sessions and PRs, or asks a session first; y posts in the thread ([#18](https://github.com/mukkund1996/serenity/issues/18)) ([80b681d](https://github.com/mukkund1996/serenity/commit/80b681d43b99e22054aa259db640be1344337175))
* topic focus on the map; z out, Z in; topic shelves; topic cap; roomier master and cards ([#10](https://github.com/mukkund1996/serenity/issues/10)) ([2275cee](https://github.com/mukkund1996/serenity/commit/2275ceea6f3f4eb76f07cb808a9f3f3168ebb422))
* topics zoom shows every topic; rename category to topic ([#4](https://github.com/mukkund1996/serenity/issues/4)) ([058d514](https://github.com/mukkund1996/serenity/commit/058d514c3bc96a53d6bde681e6ddb4d5022b76b5))
* usage bar in the header: session and weekly limits, average wait ([#11](https://github.com/mukkund1996/serenity/issues/11)) ([22888b0](https://github.com/mukkund1996/serenity/commit/22888b026a758409fb72298c3788822b9fdbe66f))
* Z attaches from a topics card; session counts in the header; roomier topics zoom ([#12](https://github.com/mukkund1996/serenity/issues/12)) ([23f6d41](https://github.com/mukkund1996/serenity/commit/23f6d41bff369e8ec831f5cf843d0e5c4ebf15f4))


### Bug Fixes

* card message order, resize garbling, attached exit, spaces in names ([57a9489](https://github.com/mukkund1996/serenity/commit/57a9489c1a77672aad58354c11b8b0aa2e5f2a7d))
* detect sessions stuck on Claude's trust prompt or exited silently ([c7b7ee7](https://github.com/mukkund1996/serenity/commit/c7b7ee7189134130362ad85890cc945ea698628a))
* E2E flake from dropped typeahead keys; TUI blank in CI ([#3](https://github.com/mukkund1996/serenity/issues/3)) ([4a52f34](https://github.com/mukkund1996/serenity/commit/4a52f3444a7aef25bb843c18e7711659bda2b63e))
* readable import overlay; Claude Code's tmux key settings ([#1](https://github.com/mukkund1996/serenity/issues/1)) ([64af414](https://github.com/mukkund1996/serenity/commit/64af41487cf4fdb61f7724231ecac590e1d6ac99))
* stale frames when switching views; q no longer lands in a Claude pane ([5518c20](https://github.com/mukkund1996/serenity/commit/5518c2038d7e6086ae418e52422a96e78c73e22f))
* working status while tools run or subagents work; status-coloured topic outlines ([#15](https://github.com/mukkund1996/serenity/issues/15)) ([48b1572](https://github.com/mukkund1996/serenity/commit/48b15727fcc567b6088eb880c1bf6a44cdcf6e9b))
