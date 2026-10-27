# Changelog

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
