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

The local MVP stores project metadata in `.agentmesh/state.json` and content-addressed artifact bytes in `.agentmesh/artifacts/<sha256>`. Mutations are serialized in-process and metadata replacement is atomic. Artifact publish/list/context paths return compact references; exact content is read by ID. Production deployment should replace this with SQLite WAL or PostgreSQL plus a durable event bus when multi-process or multi-user coordination is required.

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
