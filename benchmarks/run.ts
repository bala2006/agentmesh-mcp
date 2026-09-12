import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface TimedOperation<T> {
  value: T;
  durationMs: number;
  responseBytes: number;
}

interface OperationSample {
  scenario: string;
  trial: number;
  operation: string;
  durationMs: number;
  responseBytes: number;
}

interface TrialResult {
  scenario: string;
  trial: number;
  passed: boolean;
  durationMs: number;
  operationCount: number;
  checks: string[];
  failures: string[];
}

interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  trials: number;
  passedTrials: number;
  passRate: number;
  meanDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  meanResponseBytes: number;
  meanOperationsPerSecond: number;
}

interface BenchmarkResults {
  metadata: {
    generatedAt: string;
    iterations: number;
    node: string;
    platform: string;
    serverPath: string;
    command: string;
  };
  scenarios: ScenarioSummary[];
  trials: TrialResult[];
  samples: OperationSample[];
}

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const serverPath = join(root, 'dist', 'index.js');
const resultsDirectory = join(root, 'benchmarks', 'results');
const iterations = Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? '5', 10);
const requestTimeoutMs = 10_000;

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (message: JsonRpcMessage) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = '';

  constructor(dataDirectory: string) {
    this.child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, AGENTMESH_DATA_DIR: dataDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.on('error', (error) => this.rejectPending(error));
    this.child.on('close', (code, signal) => {
      const detail = `MCP process closed before responding (code=${code}, signal=${signal}). ${this.stderr}`;
      this.rejectPending(new Error(detail));
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.rejectPending(new Error(`Invalid JSON from MCP server: ${String(error)}; line=${line}`));
      return;
    }

    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message);
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out after ${requestTimeoutMs}ms: ${method}`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize(): Promise<JsonRpcMessage> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'agentmesh-benchmark', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async close(): Promise<void> {
    this.lines.close();
    if (!this.child.killed) this.child.kill();
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null) {
        resolveClose();
        return;
      }
      this.child.once('close', () => resolveClose());
      setTimeout(() => resolveClose(), 1_000);
    });
  }
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function timed<T>(operation: () => Promise<T>): Promise<TimedOperation<T>> {
  const start = performance.now();
  const value = await operation();
  return {
    value,
    durationMs: performance.now() - start,
    responseBytes: responseBytes(value),
  };
}

function resultPayload(response: JsonRpcMessage): Record<string, any> {
  const result = response.result as
    { content?: Array<{ type: string; text?: string }> } | undefined;
  const text = result?.content?.find((content) => content.type === 'text')?.text;
  if (!text) throw new Error('MCP response did not contain a text payload.');
  return JSON.parse(text) as Record<string, any>;
}

function assertCondition(
  condition: unknown,
  message: string,
  checks: string[],
  failures: string[],
): void {
  if (condition) checks.push(message);
  else failures.push(message);
}

function recordSample(
  samples: OperationSample[],
  scenario: string,
  trial: number,
  operation: string,
  measured: TimedOperation<unknown>,
): void {
  samples.push({
    scenario,
    trial,
    operation,
    durationMs: measured.durationMs,
    responseBytes: measured.responseBytes,
  });
}

async function scenarioProtocol(
  client: StdioMcpClient,
  trial: number,
  samples: OperationSample[],
  checks: string[],
  failures: string[],
): Promise<void> {
  const initialize = await timed(() => client.initialize());
  recordSample(samples, 'protocol-discovery', trial, 'initialize', initialize);
  const initResult = initialize.value.result as {
    serverInfo?: { name?: string };
    capabilities?: unknown;
  };
  assertCondition(
    initResult.serverInfo?.name === 'agentmesh-mcp',
    'server identity is agentmesh-mcp',
    checks,
    failures,
  );

  const tools = await timed(() => client.request('tools/list'));
  recordSample(samples, 'protocol-discovery', trial, 'tools/list', tools);
  const toolList = (tools.value.result as { tools?: unknown[] }).tools ?? [];
  assertCondition(toolList.length === 9, 'nine public tools discovered', checks, failures);

  const resources = await timed(() => client.request('resources/list'));
  recordSample(samples, 'protocol-discovery', trial, 'resources/list', resources);
  const resourceList = (resources.value.result as { resources?: unknown[] }).resources ?? [];
  assertCondition(resourceList.length === 2, 'two resources discovered', checks, failures);

  const prompts = await timed(() => client.request('prompts/list'));
  recordSample(samples, 'protocol-discovery', trial, 'prompts/list', prompts);
  const promptList = (prompts.value.result as { prompts?: unknown[] }).prompts ?? [];
  assertCondition(promptList.length === 2, 'two prompts discovered', checks, failures);

  const resource = await timed(() =>
    client.request('resources/read', { uri: 'agentmesh://project/design-system' }),
  );
  recordSample(samples, 'protocol-discovery', trial, 'resources/read', resource);
  const resourceContents = (resource.value.result as { contents?: unknown[] }).contents ?? [];
  assertCondition(
    resourceContents.length === 1,
    'design-system resource read successfully',
    checks,
    failures,
  );

  const prompt = await timed(() =>
    client.request('prompts/get', {
      name: 'plan-task',
      arguments: { task: 'benchmark protocol discovery' },
    }),
  );
  recordSample(samples, 'protocol-discovery', trial, 'prompts/get', prompt);
  const promptMessages = (prompt.value.result as { messages?: unknown[] }).messages ?? [];
  assertCondition(
    promptMessages.length === 1,
    'plan-task prompt rendered successfully',
    checks,
    failures,
  );
}

async function scenarioCoordination(
  client: StdioMcpClient,
  trial: number,
  samples: OperationSample[],
  checks: string[],
  failures: string[],
): Promise<void> {
  const call = async (operation: string, name: string, args: Record<string, unknown>) => {
    const measured = await timed(() => client.request('tools/call', { name, arguments: args }));
    recordSample(samples, 'coordination-lifecycle', trial, operation, measured);
    return resultPayload(measured.value);
  };

  const firstAgent = await call('agent-register-a', 'agent_manage', {
    operation: 'register',
    agentId: 'benchmark-planner',
    name: 'Benchmark Planner',
    role: 'planner',
    runtime: 'benchmark',
    capabilities: ['planning'],
  });
  const secondAgent = await call('agent-register-b', 'agent_manage', {
    operation: 'register',
    agentId: 'benchmark-reviewer',
    name: 'Benchmark Reviewer',
    role: 'reviewer',
    runtime: 'benchmark',
    capabilities: ['review'],
  });
  assertCondition(
    firstAgent.agent?.status === 'online',
    'planner registered online',
    checks,
    failures,
  );
  assertCondition(
    secondAgent.agent?.status === 'online',
    'reviewer registered online',
    checks,
    failures,
  );

  const listedAgents = await call('agent-list', 'agent_manage', { operation: 'list' });
  assertCondition(listedAgents.agents?.length === 2, 'two agents listed', checks, failures);

  const created = await call('task-create', 'task_manage', {
    operation: 'create',
    title: 'Coordinate benchmark task',
    description: 'Exercise task and message lifecycle.',
    createdBy: 'benchmark-planner',
    priority: 'high',
  });
  const taskId = created.task?.id as string;
  assertCondition(Boolean(taskId), 'task created with an ID', checks, failures);

  for (const status of ['claimed', 'in_progress', 'review', 'done']) {
    const updated = await call(`task-${status}`, 'task_manage', {
      operation: 'update',
      taskId,
      status,
      assigneeId: 'benchmark-planner',
    });
    assertCondition(
      updated.task?.status === status,
      `task transitioned to ${status}`,
      checks,
      failures,
    );
  }

  const sent = await call('message-send', 'agent_message', {
    operation: 'send',
    fromAgentId: 'benchmark-planner',
    toAgentId: 'benchmark-reviewer',
    taskId,
    type: 'request',
    body: 'Please review the benchmark task.',
  });
  const messageId = sent.message?.id as string;
  assertCondition(Boolean(messageId), 'task-linked message created', checks, failures);

  const messages = await call('message-list', 'agent_message', { operation: 'list' });
  assertCondition(messages.messages?.length === 1, 'one message listed', checks, failures);

  const acknowledged = await call('message-ack', 'agent_message', {
    operation: 'acknowledge',
    messageId,
  });
  assertCondition(
    Boolean(acknowledged.message?.acknowledgedAt),
    'message acknowledged',
    checks,
    failures,
  );

  const context = await call('project-context', 'project_context', {});
  assertCondition(
    context.tasks?.length === 1,
    'project context includes the task',
    checks,
    failures,
  );
  assertCondition(
    context.unreadMessages?.length === 0,
    'acknowledged message is not unread',
    checks,
    failures,
  );

  const concurrentMessages = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      call(`concurrent-message-${index + 1}`, 'agent_message', {
        operation: 'send',
        fromAgentId: 'benchmark-planner',
        toAgentId: 'benchmark-reviewer',
        taskId,
        type: 'status',
        body: `Concurrent coordination message ${index + 1}`,
      }),
    ),
  );
  const concurrentIds = concurrentMessages.map((result) => result.message?.id).filter(Boolean);
  assertCondition(
    concurrentIds.length === 10,
    'all concurrent messages received IDs',
    checks,
    failures,
  );
  assertCondition(
    new Set(concurrentIds).size === 10,
    'concurrent message IDs are unique',
    checks,
    failures,
  );

  const finalMessages = await call('final-message-list', 'agent_message', { operation: 'list' });
  assertCondition(
    finalMessages.messages?.length === 11,
    'all serialized messages are durable',
    checks,
    failures,
  );
}

async function scenarioArtifacts(
  client: StdioMcpClient,
  trial: number,
  samples: OperationSample[],
  checks: string[],
  failures: string[],
): Promise<void> {
  const call = async (operation: string, name: string, args: Record<string, unknown>) => {
    const measured = await timed(() => client.request('tools/call', { name, arguments: args }));
    recordSample(samples, 'artifact-context-bounds', trial, operation, measured);
    return resultPayload(measured.value);
  };

  const content = 'benchmark-artifact-content-'.repeat(180);
  let lastArtifactId = '';
  for (let index = 0; index < 30; index += 1) {
    const published = await call(`publish-${index + 1}`, 'artifact_manage', {
      operation: 'publish',
      kind: 'analysis',
      title: `Benchmark artifact ${index + 1}`,
      content,
      createdBy: 'benchmark-agent',
    });
    lastArtifactId = published.artifact?.id as string;
  }

  const listed = await call('artifact-list', 'artifact_manage', { operation: 'list' });
  const list = listed.artifacts as Array<Record<string, unknown>>;
  assertCondition(list.length === 30, 'all 30 artifacts are listed', checks, failures);
  assertCondition(
    list.every((artifact) => !('content' in artifact)),
    'artifact list omits content',
    checks,
    failures,
  );

  const context = await call('project-context', 'project_context', {});
  const contextArtifacts = context.artifacts as Array<Record<string, unknown>>;
  assertCondition(
    contextArtifacts.length === 20,
    'project context bounds artifacts to 20',
    checks,
    failures,
  );
  assertCondition(
    contextArtifacts.every((artifact) => !('content' in artifact)),
    'project context omits artifact content',
    checks,
    failures,
  );

  const read = await call('artifact-read', 'artifact_manage', {
    operation: 'read',
    artifactId: lastArtifactId,
  });
  assertCondition(
    read.artifact?.content === content,
    'artifact read returns complete content',
    checks,
    failures,
  );
}

async function scenarioAnalysis(
  client: StdioMcpClient,
  trial: number,
  samples: OperationSample[],
  checks: string[],
  failures: string[],
  fixturePath: string,
): Promise<void> {
  const call = async (operation: string, name: string, args: Record<string, unknown>) => {
    const measured = await timed(() => client.request('tools/call', { name, arguments: args }));
    recordSample(samples, 'local-analysis-paths', trial, operation, measured);
    return resultPayload(measured.value);
  };

  const clean = await call('design-clean', 'design_check', {
    uiSummary: 'A responsive dashboard card using semantic tokens.',
    accessibilityNotes: 'Keyboard focus and color contrast are documented.',
    createdBy: 'benchmark-designer',
  });
  assertCondition(clean.result?.passed === true, 'clean design passes', checks, failures);
  assertCondition(
    clean.result?.issues?.length === 0,
    'clean design has no issues',
    checks,
    failures,
  );

  const failing = await call('design-failing', 'design_check', {
    uiSummary: 'A card with #fff, 16px padding, and arbitrary spacing.',
    accessibilityNotes: '',
    createdBy: 'benchmark-designer',
  });
  const issueCodes = (failing.result?.issues ?? []).map((issue: { code: string }) => issue.code);
  assertCondition(failing.result?.passed === false, 'inaccessible design fails', checks, failures);
  assertCondition(issueCodes.includes('raw-color'), 'raw color detected', checks, failures);
  assertCondition(issueCodes.includes('raw-dimension'), 'raw dimension detected', checks, failures);
  assertCondition(
    issueCodes.includes('missing-focus-state'),
    'missing focus state detected',
    checks,
    failures,
  );

  const text = await call('multimodal-text', 'multimodal_analyze', {
    mode: 'text',
    content: 'A screenshot shows a primary action button in the top-right corner.',
    goal: 'summarize the UI hierarchy',
    createdBy: 'benchmark-vision',
  });
  assertCondition(
    text.result?.status === 'completed',
    'text analysis path completes',
    checks,
    failures,
  );
  assertCondition(
    text.result?.confidence === null,
    'text analysis does not invent confidence',
    checks,
    failures,
  );

  const existingAsset = await call('multimodal-existing-asset', 'multimodal_analyze', {
    mode: 'asset',
    content: fixturePath,
    goal: 'prepare asset for OCR',
    createdBy: 'benchmark-vision',
  });
  assertCondition(
    existingAsset.result?.status === 'provider_required',
    'existing asset correctly reports provider-required status',
    checks,
    failures,
  );

  const missingAsset = await call('multimodal-missing-asset', 'multimodal_analyze', {
    mode: 'asset',
    content: join(tmpdir(), 'agentmesh-benchmark-does-not-exist.png'),
    goal: 'prepare asset for OCR',
    createdBy: 'benchmark-vision',
  });
  assertCondition(
    missingAsset.result?.confidence === 0,
    'missing asset reports zero confidence',
    checks,
    failures,
  );
}

async function scenarioChangeReview(
  client: StdioMcpClient,
  trial: number,
  samples: OperationSample[],
  checks: string[],
  failures: string[],
): Promise<void> {
  const call = async (operation: string, name: string, args: Record<string, unknown>) => {
    const measured = await timed(() => client.request('tools/call', { name, arguments: args }));
    recordSample(samples, 'change-review-chain', trial, operation, measured);
    return resultPayload(measured.value);
  };

  await call('register-planner', 'agent_manage', {
    operation: 'register',
    agentId: 'benchmark-planner',
    name: 'Benchmark Planner',
    role: 'planner',
    runtime: 'benchmark',
  });
  await call('register-reviewer', 'agent_manage', {
    operation: 'register',
    agentId: 'benchmark-reviewer',
    name: 'Benchmark Reviewer',
    role: 'reviewer',
    runtime: 'benchmark',
  });

  const proposal = await call('change-propose', 'change_propose', {
    title: 'Add guarded benchmark reporting',
    summary: 'Add repeatable local benchmark artifacts without changing production behavior.',
    files: ['benchmarks/run.ts', 'benchmarks/results/benchmark-report.md'],
    risk: 'low',
    createdBy: 'benchmark-planner',
  });
  const artifactId = proposal.artifactId as string;
  assertCondition(
    proposal.status === 'pending_review',
    'change proposal is pending review',
    checks,
    failures,
  );
  assertCondition(Boolean(artifactId), 'change proposal has an artifact ID', checks, failures);

  const review = await call('review-request', 'review_request', {
    artifactId,
    requestedBy: 'benchmark-planner',
    reviewerAgentId: 'benchmark-reviewer',
    question:
      'Check that the benchmark is reproducible and does not claim external-provider coverage.',
  });
  assertCondition(Boolean(review.reviewArtifactId), 'review artifact is created', checks, failures);
  assertCondition(Boolean(review.messageId), 'review notification is created', checks, failures);

  const artifacts = await call('artifact-list', 'artifact_manage', { operation: 'list' });
  const reviewArtifact = (artifacts.artifacts as Array<Record<string, any>>).find(
    (artifact) => artifact.id === review.reviewArtifactId,
  );
  assertCondition(
    reviewArtifact?.kind === 'review',
    'review artifact is discoverable',
    checks,
    failures,
  );

  const messages = await call('message-list', 'agent_message', { operation: 'list' });
  const reviewMessage = (messages.messages as Array<Record<string, any>>).find(
    (message) => message.id === review.messageId,
  );
  assertCondition(reviewMessage?.type === 'review', 'review message is durable', checks, failures);

  const prompt = await timed(() =>
    client.request('prompts/get', {
      name: 'review-change',
      arguments: { change: 'Review the guarded benchmark reporting proposal.' },
    }),
  );
  recordSample(samples, 'change-review-chain', trial, 'prompts/get-review', prompt);
  const promptMessages = (prompt.value.result as { messages?: unknown[] }).messages ?? [];
  assertCondition(
    promptMessages.length === 1,
    'review-change prompt rendered successfully',
    checks,
    failures,
  );
}

const scenarioDefinitions = [
  {
    id: 'protocol-discovery',
    title: 'Protocol discovery',
    description: 'Cold-start MCP initialization, surface discovery, and resource/prompt reads.',
    run: scenarioProtocol,
  },
  {
    id: 'coordination-lifecycle',
    title: 'Coordination lifecycle',
    description: 'Two-agent registration, task state transitions, message delivery, and context.',
    run: scenarioCoordination,
  },
  {
    id: 'artifact-context-bounds',
    title: 'Artifact context bounds',
    description:
      'Publish 30 large artifacts and verify metadata/context bounding versus full reads.',
    run: scenarioArtifacts,
  },
  {
    id: 'local-analysis-paths',
    title: 'Local analysis paths',
    description:
      'Deterministic design checks plus honest text, existing-asset, and missing-asset behavior.',
    run: scenarioAnalysis,
  },
  {
    id: 'change-review-chain',
    title: 'Change and review chain',
    description:
      'Record a guarded change proposal, create a review artifact, notify a reviewer, and render a prompt.',
    run: scenarioChangeReview,
  },
] as const;

function percentile(values: number[], percentage: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function runScenario(
  definition: (typeof scenarioDefinitions)[number],
  trial: number,
  samples: OperationSample[],
): Promise<TrialResult> {
  const dataDirectory = await mkdtemp(join(tmpdir(), `agentmesh-${definition.id}-`));
  const fixturePath = join(dataDirectory, 'fixture.txt');
  await writeFile(fixturePath, 'AgentMesh benchmark fixture: OCR provider boundary.\n', 'utf8');
  const client = new StdioMcpClient(dataDirectory);
  const checks: string[] = [];
  const failures: string[] = [];
  const start = performance.now();

  try {
    if (definition.id === 'local-analysis-paths') {
      await definition.run(client, trial, samples, checks, failures, fixturePath);
    } else {
      await definition.run(client, trial, samples, checks, failures);
    }
  } catch (error) {
    failures.push(
      `unexpected exception: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }

  return {
    scenario: definition.id,
    trial,
    passed: failures.length === 0,
    durationMs: performance.now() - start,
    operationCount: samples.filter(
      (sample) => sample.scenario === definition.id && sample.trial === trial,
    ).length,
    checks,
    failures,
  };
}

function summarizeScenario(
  definition: (typeof scenarioDefinitions)[number],
  trials: TrialResult[],
  samples: OperationSample[],
): ScenarioSummary {
  const scenarioTrials = trials.filter((trial) => trial.scenario === definition.id);
  const durations = scenarioTrials.map((trial) => trial.durationMs);
  const scenarioSamples = samples.filter((sample) => sample.scenario === definition.id);
  const meanDurationMs = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const meanResponseBytes =
    scenarioSamples.reduce((sum, sample) => sum + sample.responseBytes, 0) /
    Math.max(1, scenarioSamples.length);
  const meanOperationsPerSecond =
    scenarioTrials.reduce(
      (sum, trial) => sum + trial.operationCount / (trial.durationMs / 1000),
      0,
    ) / Math.max(1, scenarioTrials.length);

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    trials: scenarioTrials.length,
    passedTrials: scenarioTrials.filter((trial) => trial.passed).length,
    passRate:
      scenarioTrials.filter((trial) => trial.passed).length / Math.max(1, scenarioTrials.length),
    meanDurationMs: round(meanDurationMs),
    p50DurationMs: round(percentile(durations, 50)),
    p95DurationMs: round(percentile(durations, 95)),
    minDurationMs: round(Math.min(...durations)),
    maxDurationMs: round(Math.max(...durations)),
    meanResponseBytes: round(meanResponseBytes),
    meanOperationsPerSecond: round(meanOperationsPerSecond),
  };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character];
  });
}

function chartSvg(
  title: string,
  summaries: ScenarioSummary[],
  series: Array<{ label: string; value: (summary: ScenarioSummary) => number; color: string }>,
  unit: string,
): string {
  const width = 1280;
  const height = 680;
  const margin = { top: 78, right: 60, bottom: 150, left: 90 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(
    1,
    ...summaries.flatMap((summary) => series.map((item) => item.value(summary))),
  );
  const slotWidth = chartWidth / summaries.length;
  const barWidth = Math.min(48, slotWidth / (series.length + 1));
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#0b1220"/>',
    `<text x="${margin.left}" y="42" font-family="Inter,Arial,sans-serif" font-size="26" font-weight="700" fill="#f8fafc">${escapeXml(title)}</text>`,
    `<text x="${margin.left}" y="66" font-family="Inter,Arial,sans-serif" font-size="13" fill="#94a3b8">AgentMesh MCP local benchmark · ${escapeXml(unit)}</text>`,
  ];

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxValue * tick) / 4;
    const y = margin.top + chartHeight - (value / maxValue) * chartHeight;
    lines.push(
      `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#243248"/>`,
    );
    lines.push(
      `<text x="${margin.left - 12}" y="${y + 5}" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="12" fill="#94a3b8">${round(value)}</text>`,
    );
  }

  summaries.forEach((summary, summaryIndex) => {
    const center = margin.left + slotWidth * (summaryIndex + 0.5);
    series.forEach((item, seriesIndex) => {
      const value = item.value(summary);
      const barHeight = (value / maxValue) * chartHeight;
      const x = center + (seriesIndex - (series.length - 1) / 2) * barWidth - barWidth / 2;
      const y = margin.top + chartHeight - barHeight;
      lines.push(
        `<rect x="${x}" y="${y}" width="${barWidth - 4}" height="${barHeight}" rx="4" fill="${item.color}"/>`,
      );
      lines.push(
        `<text x="${x + (barWidth - 4) / 2}" y="${Math.max(margin.top + 14, y - 8)}" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="11" fill="#cbd5e1">${round(value)}</text>`,
      );
    });
    const label = summary.title.replace(' ', '\n');
    const parts = label.split('\n');
    parts.forEach((part, lineIndex) => {
      lines.push(
        `<text x="${center}" y="${height - margin.bottom + 28 + lineIndex * 16}" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="12" fill="#cbd5e1">${escapeXml(part)}</text>`,
      );
    });
  });

  series.forEach((item, index) => {
    const x = width - margin.right - 190 + index * 120;
    lines.push(
      `<rect x="${x}" y="${height - 42}" width="12" height="12" rx="2" fill="${item.color}"/>`,
    );
    lines.push(
      `<text x="${x + 20}" y="${height - 31}" font-family="Inter,Arial,sans-serif" font-size="12" fill="#cbd5e1">${escapeXml(item.label)}</text>`,
    );
  });
  lines.push('</svg>');
  return lines.join('\n');
}

function reportMarkdown(results: BenchmarkResults): string {
  const lines = [
    '# AgentMesh MCP Benchmark Report',
    '',
    `Generated: ${results.metadata.generatedAt}`,
    '',
    '## Scope',
    '',
    'This benchmark exercises the local stdio MCP MVP through real JSON-RPC calls. It measures protocol behavior, local persistence, deterministic design checks, artifact context bounding, and guarded review workflows. It does not measure hosted OCR, vision-model accuracy, remote HTTP, OAuth, or real coding-agent runtime bridges because those capabilities are not implemented in this version.',
    '',
    `Iterations per scenario: **${results.metadata.iterations}**`,
    '',
    '## Results',
    '',
    '| Scenario | Pass rate | Mean (ms) | P50 (ms) | P95 (ms) | Mean response (bytes) | Mean ops/sec |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const summary of results.scenarios) {
    lines.push(
      `| ${summary.title} | ${(summary.passRate * 100).toFixed(0)}% | ${summary.meanDurationMs} | ${summary.p50DurationMs} | ${summary.p95DurationMs} | ${summary.meanResponseBytes} | ${summary.meanOperationsPerSecond} |`,
    );
  }

  const failures = results.trials.flatMap((trial) =>
    trial.failures.map((failure) => `${trial.scenario} trial ${trial.trial}: ${failure}`),
  );
  lines.push(
    '',
    '## Correctness',
    '',
    failures.length === 0 ? 'All benchmark assertions passed in every trial.' : 'Failures:',
    '',
  );
  lines.push(...(failures.length === 0 ? [] : failures.map((failure) => `- ${failure}`)));

  lines.push('', '## Scenario details', '');
  for (const summary of results.scenarios) {
    lines.push(`### ${summary.title}`, '', summary.description, '');
    const scenarioTrials = results.trials.filter((trial) => trial.scenario === summary.id);
    const checks = [...new Set(scenarioTrials.flatMap((trial) => trial.checks))];
    lines.push('Assertions:', '', ...checks.map((check) => `- ${check}`), '');
  }

  lines.push(
    '## Optimizations exercised',
    '',
    '- Compact JSON MCP responses reduce model-context and wire bytes.',
    '- Project context, lists, and artifact reads use bounded selectors instead of cloning the complete state for every request.',
    '- State writes use atomic temporary-file replacement; set `AGENTMESH_DURABLE_WRITES=1` to add file syncing for stronger power-loss durability.',
    '- Review creation validates references and persists the review artifact plus notification message in one mutation.',
    '- Task transitions, agent references, message references, and artifact task links are validated before persistence.',
    '',
    '## Interpretation',
    '',
    '- These results establish a repeatable baseline for the local JSON-backed MVP, not a production capacity claim.',
    '- Artifact list and project context intentionally omit artifact content; the benchmark verifies that large content is retrieved by reference instead of always entering model context.',
    '- The multimodal scenario verifies honest provider-boundary behavior. A `provider_required` result is correct for this MVP and must not be interpreted as successful OCR.',
    '- The JSON store serializes mutations in one process. Multi-process or multi-user throughput requires the planned database and event-bus implementation.',
    '',
    '## Reproduce',
    '',
    '```bash',
    'npm install',
    'npm run benchmark',
    '```',
    '',
    'Set `BENCHMARK_ITERATIONS=10` to increase repetitions. Generated JSON, SVG charts, Markdown, and HTML are written to `benchmarks/results/`.',
    '',
  );
  return lines.join('\n');
}

function reportHtml(results: BenchmarkResults): string {
  const rows = results.scenarios
    .map(
      (summary) =>
        `<tr><td>${escapeXml(summary.title)}</td><td>${(summary.passRate * 100).toFixed(0)}%</td><td>${summary.meanDurationMs}</td><td>${summary.p95DurationMs}</td><td>${summary.meanResponseBytes}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentMesh MCP Benchmark</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font:16px/1.5 Inter,system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:40px 24px}h1{color:#f8fafc}p{color:#94a3b8}.card{background:#111c2f;border:1px solid #243248;border-radius:14px;padding:18px;margin:20px 0;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #243248}th{color:#93c5fd}img{width:100%;height:auto;border-radius:8px}</style>
</head>
<body><main>
<h1>AgentMesh MCP Benchmark</h1>
<p>Local stdio JSON-RPC benchmark generated ${escapeXml(results.metadata.generatedAt)} with ${results.metadata.iterations} iterations per scenario.</p>
<div class="card"><table><thead><tr><th>Scenario</th><th>Pass rate</th><th>Mean ms</th><th>P95 ms</th><th>Mean response bytes</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><img src="latency-by-scenario.svg" alt="Mean and p95 latency by benchmark scenario" /></div>
<div class="card"><img src="response-size-by-scenario.svg" alt="Mean MCP response size by benchmark scenario" /></div>
<div class="card"><img src="correctness-by-scenario.svg" alt="Correctness pass rate by benchmark scenario" /></div>
</main></body></html>`;
}

async function main(): Promise<void> {
  const fixture = await stat(serverPath);
  if (!fixture.isFile())
    throw new Error(`Built MCP server not found at ${serverPath}. Run npm run build first.`);
  await mkdir(resultsDirectory, { recursive: true });

  const samples: OperationSample[] = [];
  const trials: TrialResult[] = [];
  for (const definition of scenarioDefinitions) {
    for (let trial = 1; trial <= iterations; trial += 1) {
      const result = await runScenario(definition, trial, samples);
      trials.push(result);
      process.stdout.write(
        `${definition.id} trial ${trial}/${iterations}: ${result.passed ? 'PASS' : 'FAIL'} ${result.durationMs.toFixed(2)}ms\n`,
      );
    }
  }

  const results: BenchmarkResults = {
    metadata: {
      generatedAt: new Date().toISOString(),
      iterations,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      serverPath: 'dist/index.js',
      command: 'npm run benchmark',
    },
    scenarios: scenarioDefinitions.map((definition) =>
      summarizeScenario(definition, trials, samples),
    ),
    trials,
    samples,
  };

  await writeFile(
    join(resultsDirectory, 'benchmark-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(resultsDirectory, 'benchmark-report.md'), reportMarkdown(results), 'utf8');
  await writeFile(join(resultsDirectory, 'benchmark-report.html'), reportHtml(results), 'utf8');
  await writeFile(
    join(resultsDirectory, 'latency-by-scenario.svg'),
    chartSvg(
      'Latency by scenario',
      results.scenarios,
      [
        { label: 'Mean', value: (summary) => summary.meanDurationMs, color: '#60a5fa' },
        { label: 'P95', value: (summary) => summary.p95DurationMs, color: '#f59e0b' },
      ],
      'milliseconds; lower is better',
    ),
    'utf8',
  );
  await writeFile(
    join(resultsDirectory, 'response-size-by-scenario.svg'),
    chartSvg(
      'Mean MCP response size',
      results.scenarios,
      [{ label: 'Bytes', value: (summary) => summary.meanResponseBytes, color: '#a78bfa' }],
      'bytes per response; lower is generally better for context usage',
    ),
    'utf8',
  );
  await writeFile(
    join(resultsDirectory, 'correctness-by-scenario.svg'),
    chartSvg(
      'Correctness pass rate',
      results.scenarios,
      [{ label: 'Pass rate', value: (summary) => summary.passRate * 100, color: '#34d399' }],
      'percent of trials passing all assertions; higher is better',
    ),
    'utf8',
  );

  const failed = trials.filter((trial) => !trial.passed);
  process.stdout.write(`\nGenerated benchmark artifacts in ${resultsDirectory}\n`);
  process.stdout.write(
    `Overall: ${trials.length - failed.length}/${trials.length} trials passed\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
