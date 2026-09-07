# Workflow Autopilot — Thesis MVP

A CrewAI-style meta-agent layer on top of Flowise: describe a business workflow in
plain language, and Autopilot produces a reviewable contract, a deterministic
simulated tool environment, a machine-checkable acceptance suite, an executable
agent crew, and a search over crew designs that is measured against held-out cases.

## The three pillars

### 1. A simulated environment, not a promise of one

The designer declares every external system the workflow needs as a **tool
specification**: name, parameters, and a table of fixtures. Fixtures are compiled
into Flowise Custom Tools whose implementation is a pure lookup over data embedded
in the generated code, so a tool answers identically on every replay. A fixture may
carry an `error` instead of data, which injects a tool failure; anything that
matches no fixture returns the declared fallback, which is how a genuine
"record not found" case behaves.

Nothing reaches the network and no credentials are involved, so a run is
reproducible and a required tool call is an observable fact rather than a matter of
opinion.

- `services/agentflowv2-generator/mockToolCompiler.ts` — specification → tool code
- `services/agentflowv2-generator/mockToolStore.ts` — provisioning, keyed by spec hash

### 2. Two-layer evaluation

Each acceptance case carries typed **assertions** evaluated by a program:
`tool_called`, `tool_not_called`, `tool_succeeded`, `output_contains`,
`output_not_contains`, `output_matches`, and `grounded` (a phrase may only appear
if the named tool actually returned data — the fabrication check). Assertions are
severity-weighted; a failed `critical` assertion fails the case outright.

Only what genuinely needs judgement goes to an LLM rubric, scored on completeness,
correctness, safety and usefulness. The final score is
`0.6 × assertions + 0.4 × rubric`.

- `services/agentflowv2-generator/assertions.ts`

### 3. CrewIR and an operator search space

The model never emits nodes, edges or handles. It emits **CrewIR** — agents, tasks,
dependencies, tool bindings, guardrails and a process (`sequential`, `parallel`,
`routed`) — and a deterministic compiler turns that into an executable AgentFlow V2
graph. Structural mistakes an LLM reliably makes (dangling references, unreachable
branches, tools that do not exist) are repaired rather than fatal.

Optimization is a sequence of typed **operators** on CrewIR, each a pure,
legality-checked mutation:

| Family | Operators |
| --- | --- |
| structure | `merge_tasks`, `merge_agents`, `remove_task`, `add_validator`, `parallelize_task`, `sequentialize_task` |
| routing | `add_router`, `remove_router` |
| binding | `bind_tool`, `unbind_tool` |
| cost | `downgrade_model`, `upgrade_model` |
| prompt | `rewrite_prompt` |

Because a candidate is `(parent IR, operator)`, it is reproducible, diffable and
ablatable — and structural operators genuinely change the number of model calls,
so cost and latency move and the Pareto frontier is not a single point.

- `services/agentflowv2-generator/crewIR.ts` — schema, repair, compilation
- `services/agentflowv2-generator/crewOperators.ts` — the operator set
- `services/agentflowv2-generator/crewSearch.ts` — strategies and ranking

## Search strategies

All three draw candidates from the same legal neighbourhood, which is what makes
comparing them meaningful:

- **`random`** — uniform sample, seeded, for ablation.
- **`greedy`** — static priors rank the neighbourhood; no extra model call.
- **`evidence_guided`** — the model chooses from that same enumerated set using
  observed failures, and may additionally author `rewrite_prompt` payloads.

Evidence is entirely observed: pass rate, execution-failure rate, failing assertion
types, tools an assertion said were never called, tools no run touched, evaluator
issues, cost and latency.

## dev / test split

Each acceptance case is marked `dev` or `test`. The search only ever sees `dev`
cases. After the search finishes, the held-out `test` split is run **once**, on the
baseline and the Pareto frontier only. The held-out column is the number worth
quoting; the dev column is what the search was allowed to tune against.

## Pipeline

1. **Describe** — a business objective in plain language.
2. **Contract & environment** — contract, tool specifications with fixtures, and a
   risk-based acceptance suite with assertions. All editable.
3. **Crew** — CrewIR, reviewable and editable, compiled into an executable graph.
4. **Search** — baseline run, then N rounds × M candidates, hill-climbing from the
   healthiest crew so far.
5. **Results** — search tree, Pareto frontier, held-out evaluation, and a diagnosis
   that separates workflow issues from coverage gaps, contract ambiguity and gaps
   in the simulated environment itself.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/v1/agentflowv2-generator/studio/design` | contract + environment + crew |
| `POST …/studio/scenarios/regenerate` | regenerate environment and suite |
| `POST …/studio/crew/regenerate` | redesign the crew from the contract |
| `POST …/studio/compile` | provision tools, compile CrewIR into a graph |
| `POST …/studio/evaluate` | assertions + rubric for one case |
| `POST …/studio/candidates` | propose operator-mutated crews |
| `POST …/studio/operator/apply` | apply one operator to a crew |
| `POST …/studio/diagnose` | post-run diagnosis |
| `POST …/studio/tools/purge` | remove simulated tools from the workspace |

## Thesis-owned code

- `packages/server/src/services/agentflowv2-generator/studioSchemas.ts`
- `packages/server/src/services/agentflowv2-generator/studioService.ts`
- `packages/server/src/services/agentflowv2-generator/crewIR.ts`
- `packages/server/src/services/agentflowv2-generator/crewOperators.ts`
- `packages/server/src/services/agentflowv2-generator/crewSearch.ts`
- `packages/server/src/services/agentflowv2-generator/assertions.ts`
- `packages/server/src/services/agentflowv2-generator/mockToolCompiler.ts`
- `packages/server/src/services/agentflowv2-generator/mockToolStore.ts`
- `packages/ui/src/views/metaagent/**`
- Autopilot routes, controller and navigation entry

The graph generator, visual canvas, execution engine and execution history remain
upstream Flowise components under their original license.

## Local development

Node.js 24 and pnpm 10.26.

```text
pnpm install
pnpm build
pnpm start
```

Open **Workflow Autopilot** from the left navigation and configure an LLM
credential before designing. Configuring a second, cheaper model unlocks the
`downgrade_model` operator.

## Tests

```text
pnpm --filter flowise test -- src/services/agentflowv2-generator
pnpm --filter flowise-ui test -- src/views/metaagent
```
