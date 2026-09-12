# Contributing to AgentMesh MCP

Thanks for helping improve AgentMesh.

## Before opening a pull request

1. Read the architecture and roadmap in `docs/`.
2. Keep the MCP-facing tool surface small and descriptions concise.
3. Keep large outputs in artifacts and return references where possible.
4. Never claim OCR or image-understanding work completed without provider evidence.
5. Run:

```bash
npm install
npm run typecheck
npm run build
```

## Pull requests

Please explain:

- the user-facing behavior;
- changes to the MCP tool, resource, or prompt surface;
- persistence or compatibility implications;
- security considerations;
- verification performed.

Avoid breaking tool names or input shapes without documenting a migration path.
