# AgentMesh MCP

AgentMesh MCP is an open-source, lean Model Context Protocol (MCP) gateway for coordinating coding agents around a shared project.

It provides a small public interface for:

- durable project context, tasks, messages, and artifacts;
- agent-to-agent coordination records;
- bounded multimodal-analysis requests with honest provider status;
- baseline centralized design-system checks;
- change proposals and review requests;
- MCP resources and reusable prompts.

The local MVP uses a JSON state file so it can run without a database. It is intentionally a coordination foundation, not a production swarm controller yet.

## Current status

**Version:** `0.1.0` — local MVP

Implemented:

- MCP stdio server using the official MCP TypeScript SDK v2;
- nine small MCP tools instead of a large tool catalog;
- two MCP resources and two reusable prompts;
- serialized JSON metadata persistence in `.agentmesh/state.json` with content-addressed artifact files in `.agentmesh/artifacts/`;
- compact artifact references with exact content retrieval by ID;
- bounded list operations with opaque cursors and compact project-state resources;
- honest multimodal provider boundary: it inspects local asset readiness but does not pretend to perform OCR without a configured provider;
- MIT license and client configuration examples.

Not yet implemented:

- remote Streamable HTTP transport and OAuth;
- real-time WebSocket event delivery;
- hosted OCR or vision-provider adapters;
- runtime bridges that start and control Claude Code, Codex, OpenCode, or Antigravity sessions;
- Git worktree isolation, CI gates, and merge automation;
- multi-user database storage.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Install and run

```bash
npm install
npm run build
npm start
```

The server communicates over stdio. MCP hosts launch it as a child process. Project metadata is written to `.agentmesh/state.json` and large artifact content is stored under `.agentmesh/artifacts/` in the current working directory by default.

To use a different state directory:

```bash
AGENTMESH_DATA_DIR=/path/to/project-state npm start
```

Optional environment variables are documented in `.env.example`.

## Connect clients

Build first so `dist/index.js` exists. Replace `/absolute/path/agentmesh` with this repository's path.

### Claude Code

```bash
claude mcp add agentmesh -- node /absolute/path/agentmesh/dist/index.js
```

Or add a project `.mcp.json`:

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["/absolute/path/agentmesh/dist/index.js"]
    }
  }
}
```

### Codex

Add this to the relevant Codex configuration:

```toml
[mcp_servers.agentmesh]
command = "node"
args = ["/absolute/path/agentmesh/dist/index.js"]
```

### OpenCode

Add this to the OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentmesh": {
      "type": "local",
      "command": ["node", "/absolute/path/agentmesh/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Antigravity and other MCP hosts

Use the host's local MCP configuration and launch command:

```text
node /absolute/path/agentmesh/dist/index.js
```

Host configuration formats vary. The server itself remains a standard stdio MCP server.

## Public MCP surface

The server deliberately exposes a compact interface:

| Tool                 | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `project_context`    | Read compact project state without loading all artifact contents. |
| `agent_manage`       | Register agents and update their shared presence.                 |
| `task_manage`        | Create, list, and update durable tasks.                           |
| `agent_message`      | Send, list, and acknowledge agent messages.                       |
| `artifact_manage`    | Publish, list, and read durable artifacts by reference.           |
| `multimodal_analyze` | Record bounded text or asset analysis requests.                   |
| `design_check`       | Run baseline token and accessibility checks.                      |
| `change_propose`     | Record a guarded change proposal.                                 |
| `review_request`     | Create a review artifact and notify a reviewer.                   |
|                      |

Resources:

- `agentmesh://project/state`
- `agentmesh://project/design-system`

Prompts:

- `plan-task`
- `review-change`

## Example workflow

1. An agent calls `project_context`.
2. It creates a task with `task_manage`.
3. It registers or identifies another agent through the shared project state.
4. It sends a request with `agent_message`.
5. The worker publishes its result with `artifact_manage`.
6. The parent requests review with `review_request`.
7. A human or future policy engine approves a `change_propose` result.

Large results should be published as artifacts and referenced by ID instead of being repeatedly placed in model context. Artifact publish and list operations return metadata, SHA-256 content references, and byte sizes; use `artifact_manage` with `operation: "read"` to retrieve exact content.

## Development

```bash
npm run typecheck
npm run build
npm run dev
```

`npm run dev` starts the stdio server and will wait for an MCP client. Do not use it as a long-running shell command without an MCP host attached.

## Benchmark

Run five reproducible local scenarios with five trials per scenario:

```bash
npm run benchmark
```

The benchmark drives the built server through real MCP JSON-RPC calls and covers protocol discovery, multi-agent coordination, artifact/context bounding, deterministic local analysis, and the change/review chain. It generates:

- `benchmarks/results/benchmark-results.json`
- `benchmarks/results/benchmark-report.md`
- `benchmarks/results/benchmark-report.html`
- `benchmarks/results/latency-by-scenario.svg`
- `benchmarks/results/response-size-by-scenario.svg`
- `benchmarks/results/correctness-by-scenario.svg`

Increase repetitions with `BENCHMARK_ITERATIONS=10 npm run benchmark`. The current benchmark intentionally does not claim hosted OCR, vision-model accuracy, remote HTTP, OAuth, or real coding-agent runtime coverage.

### Optimization and durability controls

The local store uses atomic temporary-file replacement, content-addressed artifact blobs, compact JSON output, bounded project/context projections, opaque cursor pagination for list operations, and one-write review creation. Artifact content is never included in project context or list responses. For stronger power-loss durability, enable:

```bash
AGENTMESH_DURABLE_WRITES=1 npm start
```

That mode syncs each temporary state file before replacement and is slower by design. The default mode protects against partial JSON files while minimizing latency. Cross-record references are validated before writes, and invalid tool operations return explicit MCP error results.

## Project structure

```text
src/index.ts       MCP tools, resources, prompts, and server bootstrap
src/store.ts       Serialized JSON project state and domain mutations
src/types.ts       Shared domain contracts
src/design.ts      Baseline design-system checks
src/multimodal.ts  Provider-neutral multimodal boundary
examples/          Client configuration examples
docs/              Architecture and roadmap
```

## Security note

This MVP is designed for trusted local development. It does not yet provide remote authentication, multi-user isolation, workspace allowlists, or real code modification. Do not expose it to a network or give it sensitive project data until those controls are implemented.

## License

MIT. See [LICENSE](LICENSE).
