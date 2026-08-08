# Meta-Agent Thesis MVP

This fork adds a small, auditable layer on top of Flowise AgentFlow V2 for the thesis prototype.

## Added workflow

1. **Intent alignment** — users define task inputs, outputs, constraints, tools, HITL checkpoints, and success criteria.
2. **Deterministic compilation contract** — the server converts those fields into a reviewable blueprint before any LLM creates executable nodes.
3. **AgentFlow generation** — the blueprint opens Flowise's existing AgentFlow V2 generator with the compiler prompt prefilled.
4. **Sandbox and telemetry loop** — generated flows use existing Human Input/checkpoint behavior and link to Flowise execution history.

## Thesis-owned code

- `packages/ui/src/views/metaagent/index.jsx`
- `POST /api/v1/agentflowv2-generator/analyze-intent`
- Meta-Agent navigation and route integration
- Canvas handoff and generator-prefill behavior

The underlying AgentFlow generator, visual canvas, execution engine, Human Input nodes, checkpoints, and execution history remain Flowise components under the upstream license.

## Local development

Flowise 3.1.3 requires Node.js 24 and pnpm 10.26.

```text
pnpm install
pnpm build
pnpm start
```

Open **Meta-Agent Studio** from the left navigation. Configure an LLM credential before generating the final graph.
