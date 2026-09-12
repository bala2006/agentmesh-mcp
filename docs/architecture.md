# AgentMesh architecture

## Boundary

AgentMesh is deliberately split into a small MCP facade and a richer backend.

```text
MCP host
  |
  v
MCP gateway: tools, resources, prompts
  |
  v
Control plane: tasks, messages, artifacts, decisions
  |
  +--> multimodal workers
  +--> agent runtime adapters
  +--> Git/worktree and CI integrations
```

The MCP server is the compatibility boundary. Internal workers should not become one MCP tool per provider or implementation detail.

## State model

The local MVP stores one project state document at `.agentmesh/state.json`. Mutations are serialized in-process to avoid overlapping writes. Production deployment should replace this with PostgreSQL and a durable event bus.

## Coordination model

Agents communicate through durable messages and artifacts rather than relying on shared model context. A message may reference a task or artifact. A child agent should publish a result artifact before the parent continues.

## Integrity model

The current MVP records proposals but never changes project files. The planned production path is:

```text
claim task -> isolated worktree -> publish patch -> run checks -> independent review -> approval -> merge queue
```

No agent should approve its own change, and overlapping file claims should be escalated rather than silently overwritten.

## Multimodal model

`multimodal_analyze` is a provider-neutral boundary. It currently records text requests and validates local asset readiness. Provider adapters will later implement OCR and visual understanding, returning confidence, provenance, and evidence regions. The server must never report provider-required work as complete.

## Context budget

The public interface is intentionally small. Large outputs belong in artifacts and should be read by ID or narrow view. This keeps project context and tool results bounded across MCP clients with different tool-loading behavior.
