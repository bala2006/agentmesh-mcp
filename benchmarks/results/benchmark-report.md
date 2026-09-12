# AgentMesh MCP Benchmark Report

Generated: 2026-09-12T15:14:37.975Z

## Scope

This benchmark exercises the local stdio MCP MVP through real JSON-RPC calls. It measures protocol behavior, local persistence, deterministic design checks, artifact context bounding, and guarded review workflows. It does not measure hosted OCR, vision-model accuracy, remote HTTP, OAuth, or real coding-agent runtime bridges because those capabilities are not implemented in this version.

Iterations per scenario: **20**

## Results

| Scenario                | Pass rate | Mean (ms) | P50 (ms) | P95 (ms) | Mean response (bytes) | Mean ops/sec |
| ----------------------- | --------: | --------: | -------: | -------: | --------------------: | -----------: |
| Protocol discovery      |      100% |   136.337 |  135.867 |  141.357 |              1166.333 |       44.035 |
| Coordination lifecycle  |      100% |   159.209 |  155.239 |  168.329 |               571.913 |      145.815 |
| Artifact context bounds |      100% |   172.015 |  167.748 |  177.354 |              1140.471 |      198.711 |
| Local analysis paths    |      100% |   143.045 |  142.523 |  146.131 |                   527 |       34.963 |
| Change and review chain |      100% |   142.051 |  141.452 |  146.092 |               368.286 |       49.291 |

## Correctness

All benchmark assertions passed in every trial.

## Scenario details

### Protocol discovery

Cold-start MCP initialization, surface discovery, and resource/prompt reads.

Assertions:

- server identity is agentmesh-mcp
- nine public tools discovered
- two resources discovered
- two prompts discovered
- design-system resource read successfully
- plan-task prompt rendered successfully

### Coordination lifecycle

Two-agent registration, task state transitions, message delivery, and context.

Assertions:

- planner registered online
- reviewer registered online
- two agents listed
- task created with an ID
- task transitioned to claimed
- task transitioned to in_progress
- task transitioned to review
- task transitioned to done
- task-linked message created
- one message listed
- message acknowledged
- project context includes the task
- acknowledged message is not unread
- all concurrent messages received IDs
- concurrent message IDs are unique
- all serialized messages are durable

### Artifact context bounds

Publish 30 large artifacts and verify compact references, metadata/context bounding, blob-backed persistence, and exact reads.

Assertions:

- artifact publish returns a compact content reference
- all 30 artifacts are listed
- artifact list omits content
- artifact list returns content references and byte sizes
- project context bounds artifacts to 20
- project context omits artifact content
- project-state resource omits artifact content
- artifact read returns complete content

### Local analysis paths

Deterministic design checks plus honest text, existing-asset, and missing-asset behavior.

Assertions:

- clean design passes
- clean design has no issues
- inaccessible design fails
- raw color detected
- raw dimension detected
- missing focus state detected
- text analysis path completes
- text analysis does not invent confidence
- existing asset correctly reports provider-required status
- missing asset reports zero confidence

### Change and review chain

Record a guarded change proposal, create a review artifact, notify a reviewer, and render a prompt.

Assertions:

- change proposal is pending review
- change proposal has an artifact ID
- review artifact is created
- review notification is created
- review artifact is discoverable
- review message is durable
- review-change prompt rendered successfully

## Optimizations exercised

- Artifact publish responses return IDs, SHA-256 content hashes, and byte counts instead of echoing large content.
- Artifact content is stored in content-addressed files while state.json stores only metadata; exact reads still return complete content.
- Project context, project-state resources, and list operations use bounded projections; list operations support opaque cursors.
- Unread message context uses bounded previews while message reads preserve full bodies.
- Compact JSON MCP responses reduce model-context and wire bytes.
- State writes use atomic temporary-file replacement; set `AGENTMESH_DURABLE_WRITES=1` to add file syncing for stronger power-loss durability.
- Review creation validates references and persists the review artifact plus notification message in one mutation.
- Task transitions, agent references, message references, and artifact task links are validated before persistence.

## Interpretation

- These results establish a repeatable baseline for the local JSON-backed MVP, not a production capacity claim.
- Artifact list and project context intentionally omit artifact content; the benchmark verifies that large content is retrieved by reference instead of always entering model context.
- The multimodal scenario verifies honest provider-boundary behavior. A `provider_required` result is correct for this MVP and must not be interpreted as successful OCR.
- The JSON store serializes mutations in one process. Multi-process or multi-user throughput requires the planned database and event-bus implementation.

## Reproduce

```bash
npm install
npm run benchmark
```

Set `BENCHMARK_ITERATIONS=10` to increase repetitions. Generated JSON, SVG charts, Markdown, and HTML are written to `benchmarks/results/`.
