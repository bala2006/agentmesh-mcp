import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  Agent,
  AgentMessage,
  Artifact,
  ArtifactSummary,
  Decision,
  ProjectState,
  Task,
  TaskStatus,
} from './types.js';

const now = () => new Date().toISOString();

function artifactDigest(content: string): { hash: string; bytes: number } {
  return {
    hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function artifactSummary({
  content: _content,
  metadata: _metadata,
  ...artifact
}: Artifact): ArtifactSummary {
  return artifact;
}

type Page<T> = { items: T[]; nextCursor?: string };

function page<T>(items: T[], limit: number, cursor?: string): Page<T> {
  const offset = cursor
    ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10)
    : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) {
    throw new ProjectStoreError('Invalid pagination cursor.');
  }
  const nextOffset = offset + limit;
  return {
    items: items.slice(offset, nextOffset),
    ...(nextOffset < items.length
      ? { nextCursor: Buffer.from(String(nextOffset), 'utf8').toString('base64url') }
      : {}),
  };
}

const allowedTaskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['backlog', 'claimed', 'in_progress', 'cancelled'],
  claimed: ['claimed', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['in_progress', 'blocked', 'review', 'cancelled'],
  blocked: ['blocked', 'in_progress', 'cancelled'],
  review: ['review', 'in_progress', 'done', 'cancelled'],
  done: ['done'],
  cancelled: ['cancelled'],
};

function createInitialState(): ProjectState {
  const timestamp = now();
  return {
    project: {
      id: process.env.AGENTMESH_PROJECT_ID ?? 'default',
      name: process.env.AGENTMESH_PROJECT_NAME ?? 'AgentMesh Project',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    agents: [],
    tasks: [],
    messages: [],
    artifacts: [],
    decisions: [],
  };
}

export class ProjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export class JsonProjectStore {
  private readonly filePath: string;
  private readonly artifactDirectory: string;
  private readonly persistedArtifactHashes = new Set<string>();
  private state: ProjectState | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory = process.env.AGENTMESH_DATA_DIR ?? '.agentmesh') {
    this.filePath = resolve(dataDirectory, 'state.json');
    this.artifactDirectory = resolve(dataDirectory, 'artifacts');
  }

  private async load(): Promise<ProjectState> {
    if (this.state) return this.state;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const state = JSON.parse(raw) as ProjectState;
      for (const artifact of state.artifacts) {
        const hasEmbeddedContent = typeof artifact.content === 'string';
        const digest = artifactDigest(hasEmbeddedContent ? artifact.content : '');
        artifact.contentHash ??= digest.hash;
        artifact.contentBytes ??= hasEmbeddedContent ? digest.bytes : 0;
        if (!hasEmbeddedContent) {
          try {
            artifact.content = await readFile(
              join(this.artifactDirectory, artifact.contentHash),
              'utf8',
            );
            const storedDigest = artifactDigest(artifact.content);
            if (storedDigest.hash !== artifact.contentHash) {
              throw new ProjectStoreError(`Artifact content hash mismatch for ${artifact.id}`);
            }
            artifact.contentBytes = storedDigest.bytes;
            this.persistedArtifactHashes.add(artifact.contentHash);
          } catch (error) {
            throw new ProjectStoreError(
              `Artifact content is missing for ${artifact.id}: ${String(error)}`,
            );
          }
        } else if (artifact.contentHash !== digest.hash || artifact.contentBytes !== digest.bytes) {
          artifact.contentHash = digest.hash;
          artifact.contentBytes = digest.bytes;
        }
      }
      this.state = state;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
      this.state = createInitialState();
    }

    return this.state;
  }

  private async persistArtifactContent(artifact: Artifact): Promise<void> {
    if (this.persistedArtifactHashes.has(artifact.contentHash)) return;
    await mkdir(this.artifactDirectory, { recursive: true });
    const targetPath = join(this.artifactDirectory, artifact.contentHash);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, 'w', 0o600);
      try {
        await handle.writeFile(artifact.content, 'utf8');
        if (process.env.AGENTMESH_DURABLE_WRITES === '1') await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, targetPath);
      this.persistedArtifactHashes.add(artifact.contentHash);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async persist(state: ProjectState): Promise<void> {
    state.project.updatedAt = now();
    await mkdir(dirname(this.filePath), { recursive: true });
    for (const artifact of state.artifacts) await this.persistArtifactContent(artifact);

    // Artifact bytes live in content-addressed files. The metadata file remains small even
    // when a project contains many large OCR, vision, or review results.
    const persistedState = {
      ...state,
      artifacts: state.artifacts.map(({ content: _content, ...artifact }) => artifact),
    };
    const metadata = JSON.stringify(persistedState);
    // Atomic replacement prevents a process crash from leaving a partially-written JSON file.
    // Set AGENTMESH_DURABLE_WRITES=1 when power-loss durability is more important than latency.
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, 'w', 0o600);
      try {
        await handle.writeFile(`${metadata}\n`, 'utf8');
        if (process.env.AGENTMESH_DURABLE_WRITES === '1') await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async read<T>(reader: (state: ProjectState) => T): Promise<T> {
    await this.writeQueue;
    return reader(await this.load());
  }

  private async mutate<T>(operation: (state: ProjectState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      const state = await this.load();
      result = await operation(state);
      await this.persist(state);
    };

    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    await next;
    return result;
  }

  async snapshot(): Promise<ProjectState> {
    return this.read((state) => structuredClone(state));
  }

  async projectContext(limit = 20): Promise<{
    project: ProjectState['project'];
    agents: Agent[];
    tasks: Task[];
    unreadMessages: Array<Omit<AgentMessage, 'body'> & { bodyPreview: string }>;
    artifacts: ArtifactSummary[];
    decisions: Decision[];
  }> {
    return this.read((state) => ({
      project: { ...state.project },
      agents: state.agents
        .slice(-limit)
        .map((agent) => ({ ...agent, capabilities: [...agent.capabilities] })),
      tasks: state.tasks
        .slice(-limit)
        .map((task) => ({ ...task, dependencies: [...task.dependencies] })),
      unreadMessages: state.messages
        .filter((message) => !message.acknowledgedAt)
        .slice(-limit)
        .map(({ body: _body, ...message }) => ({ ...message, bodyPreview: _body.slice(0, 160) })),
      artifacts: state.artifacts.slice(-limit).map(artifactSummary),
      decisions: state.decisions.slice(-limit).map((decision) => ({ ...decision })),
    }));
  }

  async compactProjectState(limit = 20): Promise<{
    version: string;
    project: ProjectState['project'];
    agents: Agent[];
    tasks: Task[];
    unreadMessages: Array<Omit<AgentMessage, 'body'> & { bodyPreview: string }>;
    artifacts: ArtifactSummary[];
    decisions: Decision[];
  }> {
    const context = await this.projectContext(limit);
    return {
      version: context.project.updatedAt,
      ...context,
    };
  }

  async listAgents(limit = 50, cursor?: string): Promise<Page<Agent>> {
    return this.read((state) =>
      page(
        state.agents.map((agent) => ({ ...agent, capabilities: [...agent.capabilities] })),
        limit,
        cursor,
      ),
    );
  }

  async listTasks(limit = 50, cursor?: string): Promise<Page<Task>> {
    return this.read((state) =>
      page(
        state.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] })),
        limit,
        cursor,
      ),
    );
  }

  async listMessages(limit = 50, cursor?: string): Promise<Page<AgentMessage>> {
    return this.read((state) =>
      page(
        state.messages.map((message) => ({ ...message })),
        limit,
        cursor,
      ),
    );
  }

  async listArtifactSummaries(limit = 50, cursor?: string): Promise<Page<ArtifactSummary>> {
    return this.read((state) => page(state.artifacts.map(artifactSummary), limit, cursor));
  }

  async getArtifact(artifactId: string): Promise<Artifact | undefined> {
    return this.read((state) => {
      const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
      return artifact ? structuredClone(artifact) : undefined;
    });
  }

  async registerAgent(input: {
    id?: string;
    name: string;
    role: string;
    runtime: string;
    capabilities?: string[];
  }): Promise<Agent> {
    return this.mutate((state) => {
      const timestamp = now();
      const existing = input.id ? state.agents.find((agent) => agent.id === input.id) : undefined;
      if (existing) {
        existing.name = input.name;
        existing.role = input.role;
        existing.runtime = input.runtime;
        existing.capabilities = input.capabilities ?? existing.capabilities;
        existing.status = 'online';
        existing.lastHeartbeatAt = timestamp;
        return existing;
      }

      const agent: Agent = {
        id: input.id ?? `agent_${randomUUID()}`,
        name: input.name,
        role: input.role,
        runtime: input.runtime,
        status: 'online',
        capabilities: input.capabilities ?? [],
        lastHeartbeatAt: timestamp,
        createdAt: timestamp,
      };
      state.agents.push(agent);
      return agent;
    });
  }

  async updateAgentStatus(agentId: string, status: Agent['status']): Promise<Agent | undefined> {
    return this.mutate((state) => {
      const agent = state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return undefined;
      agent.status = status;
      agent.lastHeartbeatAt = now();
      return agent;
    });
  }

  async createTask(input: {
    title: string;
    description: string;
    priority?: Task['priority'];
    createdBy: string;
    parentTaskId?: string;
    dependencies?: string[];
  }): Promise<Task> {
    return this.mutate((state) => {
      if (input.parentTaskId && !state.tasks.some((task) => task.id === input.parentTaskId)) {
        throw new ProjectStoreError(`Parent task not found: ${input.parentTaskId}`);
      }
      const dependencies = input.dependencies ?? [];
      const missingDependency = dependencies.find(
        (dependency) => !state.tasks.some((task) => task.id === dependency),
      );
      if (missingDependency)
        throw new ProjectStoreError(`Dependency task not found: ${missingDependency}`);

      const timestamp = now();
      const task: Task = {
        id: `task_${randomUUID()}`,
        title: input.title,
        description: input.description,
        status: 'backlog',
        priority: input.priority ?? 'normal',
        parentTaskId: input.parentTaskId,
        dependencies,
        createdBy: input.createdBy,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.tasks.push(task);
      return task;
    });
  }

  async updateTask(input: {
    taskId: string;
    status?: TaskStatus;
    assigneeId?: string;
    description?: string;
  }): Promise<Task | undefined> {
    return this.mutate((state) => {
      const task = state.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task) return undefined;
      if (input.assigneeId && !state.agents.some((agent) => agent.id === input.assigneeId)) {
        throw new ProjectStoreError(`Assignee agent not found: ${input.assigneeId}`);
      }
      if (input.status && !allowedTaskTransitions[task.status].includes(input.status)) {
        throw new ProjectStoreError(`Invalid task transition: ${task.status} -> ${input.status}`);
      }
      if (input.status) task.status = input.status;
      if (input.assigneeId !== undefined) task.assigneeId = input.assigneeId;
      if (input.description !== undefined) task.description = input.description;
      task.updatedAt = now();
      return task;
    });
  }

  async sendMessage(input: Omit<AgentMessage, 'id' | 'createdAt'>): Promise<AgentMessage> {
    return this.mutate((state) => {
      if (!state.agents.some((agent) => agent.id === input.fromAgentId)) {
        throw new ProjectStoreError(`Sender agent not found: ${input.fromAgentId}`);
      }
      if (input.toAgentId && !state.agents.some((agent) => agent.id === input.toAgentId)) {
        throw new ProjectStoreError(`Recipient agent not found: ${input.toAgentId}`);
      }
      if (input.taskId && !state.tasks.some((task) => task.id === input.taskId)) {
        throw new ProjectStoreError(`Message task not found: ${input.taskId}`);
      }
      if (input.replyTo && !state.messages.some((message) => message.id === input.replyTo)) {
        throw new ProjectStoreError(`Reply message not found: ${input.replyTo}`);
      }

      const message: AgentMessage = { ...input, id: `msg_${randomUUID()}`, createdAt: now() };
      state.messages.push(message);
      return message;
    });
  }

  async acknowledgeMessage(messageId: string): Promise<AgentMessage | undefined> {
    return this.mutate((state) => {
      const message = state.messages.find((candidate) => candidate.id === messageId);
      if (!message) return undefined;
      message.acknowledgedAt = now();
      return message;
    });
  }

  async createArtifact(
    input: Omit<Artifact, 'id' | 'createdAt' | 'contentHash' | 'contentBytes'>,
  ): Promise<Artifact> {
    return this.mutate((state) => {
      if (input.taskId && !state.tasks.some((task) => task.id === input.taskId)) {
        throw new ProjectStoreError(`Artifact task not found: ${input.taskId}`);
      }
      const digest = artifactDigest(input.content);
      const artifact: Artifact = {
        ...input,
        contentHash: digest.hash,
        contentBytes: digest.bytes,
        id: `artifact_${randomUUID()}`,
        createdAt: now(),
      };
      state.artifacts.push(artifact);
      return artifact;
    });
  }

  async createReviewRequest(input: {
    artifactId: string;
    requestedBy: string;
    reviewerAgentId?: string;
    question: string;
  }): Promise<{ review: Artifact; message: AgentMessage }> {
    return this.mutate((state) => {
      if (!state.artifacts.some((artifact) => artifact.id === input.artifactId)) {
        throw new ProjectStoreError(`Artifact not found: ${input.artifactId}`);
      }
      if (!state.agents.some((agent) => agent.id === input.requestedBy)) {
        throw new ProjectStoreError(`Requester agent not found: ${input.requestedBy}`);
      }
      if (
        input.reviewerAgentId &&
        !state.agents.some((agent) => agent.id === input.reviewerAgentId)
      ) {
        throw new ProjectStoreError(`Reviewer agent not found: ${input.reviewerAgentId}`);
      }

      const timestamp = now();
      const digest = artifactDigest(input.question);
      const review: Artifact = {
        id: `artifact_${randomUUID()}`,
        kind: 'review',
        title: `Review request for ${input.artifactId}`,
        content: input.question,
        contentHash: digest.hash,
        contentBytes: digest.bytes,
        createdBy: input.requestedBy,
        metadata: {
          targetArtifactId: input.artifactId,
          reviewerAgentId: input.reviewerAgentId,
          status: 'requested',
        },
        createdAt: timestamp,
      };
      const message: AgentMessage = {
        id: `msg_${randomUUID()}`,
        fromAgentId: input.requestedBy,
        toAgentId: input.reviewerAgentId,
        type: 'review',
        body: input.question,
        createdAt: timestamp,
      };
      state.artifacts.push(review);
      state.messages.push(message);
      return { review, message };
    });
  }

  async recordDecision(input: Omit<Decision, 'id' | 'createdAt'>): Promise<Decision> {
    return this.mutate((state) => {
      const decision: Decision = { ...input, id: `decision_${randomUUID()}`, createdAt: now() };
      state.decisions.push(decision);
      return decision;
    });
  }
}
