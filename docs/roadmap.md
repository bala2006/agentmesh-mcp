# Roadmap

## 0.1 — Local coordination MVP

- stdio MCP transport;
- JSON project state;
- durable tasks, messages, artifacts, and reviews;
- baseline design checks;
- provider-neutral multimodal boundary.

## 0.2 — Real local project workflow

- file/workspace allowlists;
- local asset ingestion;
- real OCR provider adapter;
- event cursors and `event_wait`;
- MCP Inspector examples;
- contract tests for tool schemas.

## 0.3 — Agent runtime bridges

- Claude Code bridge;
- OpenCode bridge;
- generic webhook/SDK bridge;
- heartbeats, leases, inbox delivery, and transcript references.

Codex and Antigravity adapters must remain optional because their runtime-control interfaces and support levels differ from their ability to consume MCP servers.

## 0.4 — Safe code integration

- isolated Git worktrees;
- file claims;
- patch artifacts;
- CI gates;
- independent review policy;
- approval and rollback workflows.

## 1.0 — Remote multi-user control plane

- Streamable HTTP;
- OAuth and project RBAC;
- PostgreSQL;
- durable event bus;
- WebSocket dashboard;
- tenant isolation;
- audit export;
- production OCR and vision evaluations.
