# Security Policy

## Current scope

The `0.1.x` MVP is intended for trusted local development only. It uses a local JSON state file and stdio transport. It is not safe to expose directly to a network.

## Please report

Report suspected vulnerabilities privately to the repository maintainer before opening a public issue. Include a minimal reproduction, affected version, impact, and suggested mitigation when possible.

## Planned controls

Before remote or multi-user deployment, AgentMesh must add authenticated Streamable HTTP, OAuth audience validation, project-level authorization, workspace allowlists, secret redaction, rate limits, task isolation, audit logging, and approval gates for external side effects.
