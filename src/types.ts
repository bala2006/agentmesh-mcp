export type AgentStatus = 'online' | 'idle' | 'busy' | 'offline';
export type TaskStatus =
  'backlog' | 'claimed' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled';
export type ArtifactKind =
  'note' | 'analysis' | 'ocr' | 'design-review' | 'change-proposal' | 'review';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  runtime: string;
  status: AgentStatus;
  capabilities: string[];
  lastHeartbeatAt: string;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'low' | 'normal' | 'high' | 'critical';
  assigneeId?: string;
  parentTaskId?: string;
  dependencies: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId?: string;
  taskId?: string;
  type: 'message' | 'request' | 'reply' | 'status' | 'review';
  body: string;
  replyTo?: string;
  acknowledgedAt?: string;
  createdAt: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  contentHash: string;
  contentBytes: number;
  createdBy: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type ArtifactSummary = Omit<Artifact, 'content' | 'metadata'>;

export interface Decision {
  id: string;
  title: string;
  decision: string;
  rationale?: string;
  createdBy: string;
  createdAt: string;
}

export interface ProjectState {
  project: Project;
  agents: Agent[];
  tasks: Task[];
  messages: AgentMessage[];
  artifacts: Artifact[];
  decisions: Decision[];
}
