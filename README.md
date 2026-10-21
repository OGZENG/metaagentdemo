# Workflow Autopilot

Automated design and optimization of multi-agent LLM workflows, built on [Flowise](https://github.com/FlowiseAI/Flowise).

This repository is the implementation of the master's thesis *Workflow Autopilot: Automated Design and
Optimization of Multi-Agent LLM Workflows* (Yuxuan Zeng, Technical University of Munich, Chair of
Robotics, Artificial Intelligence and Real-time Systems, 2026). It is a fork of Flowise 3.1.3; the
thesis work lives on the branch `thesis-mvp`. The original Flowise README is kept in
[README-FLOWISE.md](README-FLOWISE.md).

## What it does

A non-expert describes a business workflow in plain language, for example *"Build a customer-support
workflow for an online electronics shop ... escalate refunds above EUR 100 to a human, never invent an
order status"*. Workflow Autopilot then:

1. **Writes a reviewable contract**: success criteria, constraints, the external systems the workflow
   needs, and a risk-based coverage plan.
2. **Builds a deterministic test world**: every external system becomes a simulated tool backed by
   fixtures (exact match, then containment, then a fallback; some fixtures inject failures), plus an
   acceptance suite split into development and held-out cases. Each case carries machine-checkable
   assertions (`tool_called`, `tool_not_called`, `tool_succeeded`, `output_contains`,
   `output_not_contains`, `output_matches`, `grounded`). An LLM rubric judges only what needs judgement.
   The score of a case is `0.6 × assertions + 0.4 × rubric`, and a failed critical assertion fails the case.
3. **Designs a crew in CrewIR**: agents, tasks, dependencies, tool bindings and guardrails, with a
   sequential, parallel or routed process. The model never emits graph nodes; a deterministic compiler
   turns CrewIR into an executable Flowise AgentFlow V2 graph and repairs typical structural mistakes.
4. **Searches over crews**: candidates are produced by typed, legality-checked operators on CrewIR
   (`merge_tasks`, `merge_agents`, `remove_task`, `add_validator`, `parallelize_task`,
   `sequentialize_task`, `add_router`, `remove_router`, `bind_tool`, `unbind_tool`, `rewrite_prompt`),
   measured on the development cases, and selected on a Pareto frontier of pass rate, quality, cost and
   latency. Strategies: `random`, `greedy`, `evidence_guided` (an LLM picks operators from observed
   failures), `evidence_guided_v2`, and `regenerate` (a baseline without operators that redesigns the
   whole crew from the findings).
5. **Deploys and improves online**: a measured crew can be deployed to a chat playground with a
   per-agent token monitor. Live replies can become regression cases, but only after a person accepts
   them, and a new version is published only if it passes a server-side gate (no regression on any
   case set, and a measurable improvement).

The executor also supports dependency-aware parallel execution of independent nodes.

## Repository layout

| Path | Content |
|---|---|
| `packages/server/src/services/agentflowv2-generator/` | Thesis back end: contract and test-world generation (`studioService.ts`), CrewIR and compiler (`crewIR.ts`), operators (`crewOperators.ts`), search (`crewSearch.ts`), assertions (`assertions.ts`), simulated tools (`mockToolCompiler.ts`, `mockToolStore.ts`), test-world validation and repair (`testWorldValidator.ts`), deployments and the improvement gate (`deploymentService.ts`, `deploymentModel.ts`) |
| `packages/ui/src/views/metaagent/` | Workflow Autopilot studio and deployment playground (React) |
| `experiments/autopilot/` | Headless experiment harness, raw results and the scripts that produce the thesis tables; see its [README](experiments/autopilot/README.md) |
| `THESIS_MVP.md` | Longer design notes and the API routes |

Everything else is upstream Flowise under its original license.

## Getting started

Requirements: Node.js 24 and pnpm 10.26.

```bash
pnpm install
pnpm build
pnpm start
```

Open <http://localhost:3000>, add a credential for a chat model (any OpenAI-compatible endpoint
works), and open **Workflow Autopilot** in the left navigation.

### Using a self-hosted open-weight model

Any OpenAI-compatible server can replace the hosted model. The thesis used Qwen3.5-9B served by vLLM
on a single RTX 4080 (16 GB), quantized to FP8 at load time, with thinking disabled and native tool
calling enabled:

```bash
vllm serve <path-to>/qwen3.5-9b --served-model-name qwen3.5-9b \
  --quantization fp8 --language-model-only --max-model-len 32768 --max-num-seqs 8 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' --api-key <key>
```

In Flowise, use the ChatOpenAI node with model name `qwen3.5-9b`, base path
`http://<host>:8000/v1` and an OpenAI credential holding the vLLM key.

## Reproducing the experiments

The harness drives a running Flowise instance through the same endpoints as the studio and imports
the studio's decision rules, so a headless run makes the same decisions as the UI.

```bash
# in experiments/autopilot/.env:  FLOWISE_API_KEY=...
node experiments/autopilot/run.mjs design support
node experiments/autopilot/run.mjs baseline support --reps 3
node experiments/autopilot/run.mjs search support --strategy evidence_guided_v2 --rep 1
```

All goals, protocols (E1 to E5, the Qwen rerun and the external baselines), commands and result files
are described in [experiments/autopilot/README.md](experiments/autopilot/README.md). Every reply, tool
call, execution trace, assertion result and grader output is stored in the result JSON files; API keys
and credential ids are not.

## Main findings

On six business goals (customer support, IT helpdesk, travel planning, HR leave, restaurant
reservations, insurance claims), measured on the repaired test world (E5):

- Crew search with `gpt-5.4-mini` recommended a new crew in 20 of 54 searches. Re-measured next to
  their baselines, these crews passed on average 0.13 more development and 0.06 more held-out cases.
  The differences between strategies were not significant.
- With Qwen3.5-9B for every role, the generated crews executed as well as with `gpt-5.4-mini` on four
  of six goals, but Qwen was a much weaker optimizer: only 4 of 54 searches recommended a new crew,
  with no held-out gain.
- A single agent with all tools reached about the same pass rate as the multi-agent crew (0.63 vs.
  0.66) at less than half the tokens. The contribution that holds up is the contract and the
  deterministic test world, which make a workflow verifiable, comparable and improvable, rather than
  the multi-agent structure itself.

## Tests

```bash
pnpm --filter flowise test -- src/services/agentflowv2-generator
pnpm --filter flowise-ui test -- src/views/metaagent
```

## License

This fork keeps the Flowise license terms in [LICENSE.md](LICENSE.md): Apache License 2.0, except for
`packages/server/src/enterprise` and files with an explicit copyright notice, which are under the
Flowise commercial license.
