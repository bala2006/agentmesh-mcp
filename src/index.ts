import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { checkDesignInput } from './design.js';
import { analyzeMultimodalInput } from './multimodal.js';
import { JsonProjectStore } from './store.js';

const store = new JsonProjectStore();

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const errorResult = (value: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const safe =
  (handler: (input: any) => Promise<any>) =>
  async (input: any): Promise<any> => {
    try {
      return await handler(input);
    } catch (error) {
      return errorResult({
        error: error instanceof Error ? error.message : 'Unexpected AgentMesh operation failure.',
      });
    }
  };

function createServer() {
  const server = new McpServer({
    name: 'agentmesh-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'project_context',
    {
      description:
        'Read a compact project snapshot: active agents, tasks, unread messages, artifacts, and decisions.',
      inputSchema: z.object({}),
    },
    safe(async () => {
      const context = await store.projectContext();
      return textResult(context);
    }),
  );

  server.registerTool(
    'agent_manage',
    {
      description: 'Register an agent runtime or update its presence in the shared project.',
      inputSchema: z.object({
        operation: z.enum(['register', 'status', 'list']),
        agentId: z.string().optional(),
        name: z.string().optional(),
        role: z.string().optional(),
        runtime: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        status: z.enum(['online', 'idle', 'busy', 'offline']).optional(),
      }),
    },
    safe(async (input) => {
      if (input.operation === 'list') {
        const agents = await store.listAgents();
        return textResult({ agents });
      }

      if (input.operation === 'register') {
        if (!input.name || !input.role || !input.runtime) {
          return errorResult({
            error: 'name, role, and runtime are required to register an agent.',
          });
        }
        const agent = await store.registerAgent({
          id: input.agentId,
          name: input.name,
          role: input.role,
          runtime: input.runtime,
          capabilities: input.capabilities,
        });
        return textResult({ agent });
      }

      if (!input.agentId || !input.status) {
        return errorResult({ error: 'agentId and status are required for a status update.' });
      }
      const agent = await store.updateAgentStatus(input.agentId, input.status);
      return agent
        ? textResult({ agent })
        : errorResult({ error: `Agent not found: ${input.agentId}` });
    }),
  );

  server.registerTool(
    'task_manage',
    {
      description: 'Create, list, claim, update, or complete durable project tasks.',
      inputSchema: z.object({
        operation: z.enum(['create', 'list', 'update']),
        taskId: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
        status: z
          .enum(['backlog', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled'])
          .optional(),
        assigneeId: z.string().optional(),
        createdBy: z.string().default('unknown-agent'),
        parentTaskId: z.string().optional(),
        dependencies: z.array(z.string()).optional(),
      }),
    },
    safe(async (input) => {
      if (input.operation === 'list') {
        const tasks = await store.listTasks();
        return textResult({ tasks });
      }

      if (input.operation === 'create') {
        if (!input.title || !input.description) {
          return errorResult({ error: 'title and description are required for task creation.' });
        }
        const task = await store.createTask({
          title: input.title,
          description: input.description,
          priority: input.priority,
          createdBy: input.createdBy,
          parentTaskId: input.parentTaskId,
          dependencies: input.dependencies,
        });
        return textResult({ task });
      }

      if (!input.taskId) return errorResult({ error: 'taskId is required for task updates.' });
      const task = await store.updateTask({
        taskId: input.taskId,
        status: input.status,
        assigneeId: input.assigneeId,
        description: input.description,
      });
      return task
        ? textResult({ task })
        : errorResult({ error: `Task not found: ${input.taskId}` });
    }),
  );

  server.registerTool(
    'agent_message',
    {
      description: 'Send, list, or acknowledge durable messages between project agents.',
      inputSchema: z.object({
        operation: z.enum(['send', 'list', 'acknowledge']),
        fromAgentId: z.string().optional(),
        toAgentId: z.string().optional(),
        taskId: z.string().optional(),
        type: z.enum(['message', 'request', 'reply', 'status', 'review']).optional(),
        body: z.string().optional(),
        replyTo: z.string().optional(),
        messageId: z.string().optional(),
      }),
    },
    safe(async (input) => {
      if (input.operation === 'list') {
        const messages = await store.listMessages();
        return textResult({ messages });
      }

      if (input.operation === 'acknowledge') {
        if (!input.messageId) return errorResult({ error: 'messageId is required.' });
        const message = await store.acknowledgeMessage(input.messageId);
        return message ? textResult({ message }) : errorResult({ error: 'Message not found.' });
      }

      if (!input.fromAgentId || !input.body) {
        return errorResult({ error: 'fromAgentId and body are required to send a message.' });
      }
      const message = await store.sendMessage({
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        taskId: input.taskId,
        type: input.type ?? 'message',
        body: input.body,
        replyTo: input.replyTo,
      });
      return textResult({ message });
    }),
  );

  server.registerTool(
    'artifact_manage',
    {
      description: 'Publish, list, or read durable project artifacts by reference.',
      inputSchema: z.object({
        operation: z.enum(['publish', 'list', 'read']),
        artifactId: z.string().optional(),
        kind: z
          .enum(['note', 'analysis', 'ocr', 'design-review', 'change-proposal', 'review'])
          .optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        createdBy: z.string().default('unknown-agent'),
        taskId: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    safe(async (input) => {
      if (input.operation === 'list') {
        const artifacts = await store.listArtifactSummaries();
        return textResult({ artifacts });
      }

      if (input.operation === 'read') {
        const artifact = input.artifactId ? await store.getArtifact(input.artifactId) : undefined;
        return artifact ? textResult({ artifact }) : errorResult({ error: 'Artifact not found.' });
      }

      if (!input.kind || !input.title || input.content === undefined) {
        return errorResult({
          error: 'kind, title, and content are required to publish an artifact.',
        });
      }
      const artifact = await store.createArtifact({
        kind: input.kind,
        title: input.title,
        content: input.content,
        createdBy: input.createdBy,
        taskId: input.taskId,
        metadata: input.metadata,
      });
      return textResult({ artifact });
    }),
  );

  server.registerTool(
    'multimodal_analyze',
    {
      description:
        'Create a bounded multimodal analysis record for text or a local asset. This MVP reports provider readiness and never pretends provider-required work is complete.',
      inputSchema: z.object({
        mode: z.enum(['text', 'asset']),
        content: z.string().min(1),
        goal: z.string().min(1),
        createdBy: z.string().default('unknown-agent'),
        taskId: z.string().optional(),
      }),
    },
    safe(async (input) => {
      const result = await analyzeMultimodalInput(input);
      const artifact = await store.createArtifact({
        kind: input.mode === 'asset' ? 'ocr' : 'analysis',
        title: `Multimodal analysis: ${input.goal}`,
        content: JSON.stringify(result),
        createdBy: input.createdBy,
        taskId: input.taskId,
        metadata: { mode: input.mode, goal: input.goal },
      });
      return textResult({ result, artifactId: artifact.id });
    }),
  );

  server.registerTool(
    'design_check',
    {
      description:
        'Run baseline centralized design-system and accessibility checks against a UI summary and optional tokens.',
      inputSchema: z.object({
        uiSummary: z.string().min(1),
        tokens: z.string().optional(),
        accessibilityNotes: z.string().optional(),
        createdBy: z.string().default('unknown-agent'),
        taskId: z.string().optional(),
      }),
    },
    safe(async (input) => {
      const result = checkDesignInput(input);
      const artifact = await store.createArtifact({
        kind: 'design-review',
        title: 'Design-system check',
        content: JSON.stringify(result),
        createdBy: input.createdBy,
        taskId: input.taskId,
        metadata: { passed: result.passed },
      });
      return textResult({ result, artifactId: artifact.id });
    }),
  );

  server.registerTool(
    'change_propose',
    {
      description: 'Record a proposed code or workspace change for later review and approval.',
      inputSchema: z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
        files: z.array(z.string()).default([]),
        createdBy: z.string().default('unknown-agent'),
        taskId: z.string().optional(),
        risk: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
    },
    safe(async (input) => {
      const artifact = await store.createArtifact({
        kind: 'change-proposal',
        title: input.title,
        content: input.summary,
        createdBy: input.createdBy,
        taskId: input.taskId,
        metadata: { files: input.files, risk: input.risk, approval: 'pending' },
      });
      return textResult({
        status: 'pending_review',
        artifactId: artifact.id,
        message: 'The proposal is recorded. This MVP does not modify files or merge changes.',
      });
    }),
  );

  server.registerTool(
    'review_request',
    {
      description: 'Create a review artifact and notify a reviewer agent.',
      inputSchema: z.object({
        artifactId: z.string().min(1),
        requestedBy: z.string().min(1),
        reviewerAgentId: z.string().optional(),
        question: z.string().min(1),
      }),
    },
    safe(async (input) => {
      const result = await store.createReviewRequest(input);
      return textResult({ reviewArtifactId: result.review.id, messageId: result.message.id });
    }),
  );

  server.registerResource(
    'project-state',
    'agentmesh://project/state',
    {
      title: 'AgentMesh project state',
      description: 'Compact shared state for the active AgentMesh project.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await store.snapshot()),
        },
      ],
    }),
  );

  server.registerResource(
    'design-system-guidance',
    'agentmesh://project/design-system',
    {
      title: 'AgentMesh design-system guidance',
      description: 'Compact baseline rules for consistent UI and UX work.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: [
            '# AgentMesh design system',
            '',
            '- Prefer semantic design tokens over raw colors and dimensions.',
            '- Define loading, empty, error, focus, hover, and disabled states.',
            '- Check contrast and keyboard focus behavior.',
            '- Keep component variants documented and reusable.',
            '- Treat accessibility as part of the component contract.',
          ].join('\\n'),
        },
      ],
    }),
  );

  server.registerPrompt(
    'plan-task',
    {
      title: 'Plan a task',
      description: 'Create a small, reviewable implementation plan for an AgentMesh task.',
      argsSchema: z.object({ task: z.string().min(1) }),
    },
    ({ task }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Plan this task as small, independently reviewable steps. Identify risks, dependencies, and the artifact that should be published when complete.\\n\\nTask: ${task}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review-change',
    {
      title: 'Review a change',
      description: 'Review a proposed change for correctness, safety, and project consistency.',
      argsSchema: z.object({ change: z.string().min(1) }),
    },
    ({ change }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review this proposed change. Check scope, regressions, security, tests, accessibility, and consistency with the shared design system. Return blocking issues first.\\n\\nChange: ${change}`,
          },
        },
      ],
    }),
  );

  return server;
}

serveStdio(createServer);
