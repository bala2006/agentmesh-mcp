import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentMessage,
  Artifact,
  Decision,
  ProjectState,
  Task,
  TaskStatus,
} from './types.js';

const now = () => new Date().toISOString();

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

export class JsonProjectStore {
  private readonly filePath: string;
  private state: ProjectState | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory = process.env.AGENTMESH_DATA_DIR ?? '.agentmesh') {
    this.filePath = resolve(dataDirectory, 'state.json');
  }

  get path(): string {
    return this.filePath;
  }

  private async load(): Promise<ProjectState> {
    if (this.state) return this.state;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = JSON.parse(raw) as ProjectState;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
      this.state = createInitialState();
      await this.persist(this.state);
    }

    return this.state;
  }

  private async persist(state: ProjectState): Promise<void> {
    state.project.updatedAt = now();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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
    await this.writeQueue;
    return structuredClone(await this.load());
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
      const existing = state.agents.find((agent) => agent.id === input.id);
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
      const timestamp = now();
      const task: Task = {
        id: `task_${randomUUID()}`,
        title: input.title,
        description: input.description,
        status: 'backlog',
        priority: input.priority ?? 'normal',
        parentTaskId: input.parentTaskId,
        dependencies: input.dependencies ?? [],
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
      if (input.status) task.status = input.status;
      if (input.assigneeId !== undefined) task.assigneeId = input.assigneeId;
      if (input.description !== undefined) task.description = input.description;
      task.updatedAt = now();
      return task;
    });
  }

  async sendMessage(input: Omit<AgentMessage, 'id' | 'createdAt'>): Promise<AgentMessage> {
    return this.mutate((state) => {
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

  async createArtifact(input: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact> {
    return this.mutate((state) => {
      const artifact: Artifact = { ...input, id: `artifact_${randomUUID()}`, createdAt: now() };
      state.artifacts.push(artifact);
      return artifact;
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
