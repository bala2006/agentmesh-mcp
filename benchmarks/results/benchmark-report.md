# AgentMesh MCP Benchmark Report

Generated: 2026-09-12T13:27:21.630Z

## Scope

This benchmark exercises the local stdio MCP MVP through real JSON-RPC calls. It measures protocol behavior, local persistence, deterministic design checks, artifact context bounding, and guarded review workflows. It does not measure hosted OCR, vision-model accuracy, remote HTTP, OAuth, or real coding-agent runtime bridges because those capabilities are not implemented in this version.

Iterations per scenario: **5**

## Results

| Scenario                | Pass rate | Mean (ms) | P50 (ms) | P95 (ms) | Mean response (bytes) | Mean ops/sec |
| ----------------------- | --------: | --------: | -------: | -------: | --------------------: | -----------: |
| Protocol discovery      |      100% |    134.54 |  135.513 |  138.225 |              1104.333 |       44.619 |
| Coordination lifecycle  |      100% |   148.836 |  148.018 |  152.109 |               614.833 |       80.653 |
| Artifact context bounds |      100% |   192.733 |  177.746 |  249.988 |              5292.667 |        174.4 |
| Local analysis paths    |      100% |   138.327 |  139.997 |  141.968 |                 638.8 |       36.167 |
| Change and review chain |      100% |   142.047 |  140.658 |  149.091 |                 472.8 |       35.224 |

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

### Artifact context bounds

Publish 30 large artifacts and verify metadata/context bounding versus full reads.

Assertions:

- all 30 artifacts are listed
- artifact list omits content
- project context bounds artifacts to 20
- project context omits artifact content
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
