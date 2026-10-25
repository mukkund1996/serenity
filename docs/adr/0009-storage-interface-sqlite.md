# 0009 · SQLite behind a swappable storage interface

**Status:** Accepted · 2026-10-25

## Context
The daemon persists sessions, hook events, master conversation, suggestions and topics, and must rebuild state after a restart. We want to be able to change the backend later.

## Decision
- **Interfaces first:** `packages/core` defines repository interfaces per aggregate (`SessionStore`, `EventStore`, `SuggestionStore`, `ConversationStore`, `TopicStore`) plus a `Storage` that groups them and offers `transaction(fn)`.
- Interfaces speak domain types only — no SQL, rows or driver types leak out.
- **v1 backend:** `bun:sqlite`, WAL mode, at `~/.local/state/serenity/serenity.db`, with numbered forward-only migrations.
- An **in-memory backend** implements the same interfaces for tests.
- One shared **contract test suite** runs against every backend.

## Consequences
- Adding a backend means implementing the interfaces and passing the contract suite.
- No ORM; small hand-written queries per method.
