import { z } from 'zod/v3'
import { extractResponseContent, initNode } from 'flowise-components'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { getErrorMessage } from '../../errors/utils'
import { databaseEntities } from '../../utils'
import logger from '../../utils/logger'
import {
    AcceptanceScenarioType,
    CrewIRType,
    StudioContractType,
    StudioDesignType,
    StudioDiagnosisType,
    StudioRubricScoreType,
    StudioScenarioSuiteType,
    StudioToolFixturesType,
    ToolSpecType,
    type StudioDesign,
    type ToolSpec
} from './studioSchemas'
import { assertCompiledGraph, compileCrewIRFlow, normalizeCrewIR, summarizeCrewIR } from './crewIR'
import { describeToolEnvironment } from './mockToolCompiler'
import { provisionMockTools, purgeMockTools } from './mockToolStore'
import { combineScores, evaluateAssertions, rubricScore, summarizeAssertions, type RecordedToolCall } from './assertions'
import {
    OperatorSelectionType,
    RunEvidenceType,
    SEARCH_STRATEGIES,
    materializeCandidates,
    promptPatchToOperator,
    rankOperators,
    selectOperators,
    type SearchStrategy
} from './crewSearch'
import { applyOperator, describeOperator, CrewOperatorType } from './crewOperators'

/* ------------------------------------------------------------------ *
 * Model plumbing
 * ------------------------------------------------------------------ */

const modelRuntimeOptions = () => ({
    appDataSource: getRunningExpressApp().AppDataSource,
    databaseEntities,
    logger
})

const schemaIssueList = (error: unknown) => {
    if (!(error instanceof z.ZodError)) return getErrorMessage(error)
    return error.issues
        .slice(0, 12)
        .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')
}

/**
 * A raw ZodError serialises to hundreds of lines of JSON, which is useless in a
 * UI alert. Report the first few paths and how many more there were.
 */
const summarizeSchemaIssues = (error: unknown) => {
    if (!(error instanceof z.ZodError)) return getErrorMessage(error)
    const shown = error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
    const remaining = error.issues.length - shown.length
    return [
        `The model returned JSON that does not fit the required shape (${error.issues.length} problem(s)).`,
        ...shown.map((line) => `  • ${line}`),
        remaining > 0 ? `  • …and ${remaining} more of the same kind.` : '',
        'Try generating again; if it keeps failing, simplify the goal or reduce the recommended case count.'
    ]
        .filter(Boolean)
        .join('\n')
}

const parseStructuredResponse = <T extends z.ZodTypeAny>(content: string, schema: T): z.infer<T> => {
    const trimmed = String(content || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error('The model did not return a JSON object.')
    return schema.parse(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)))
}

export const invokeStudioModel = async <T extends z.ZodTypeAny>(
    selectedChatModel: Record<string, any>,
    schema: T,
    systemPrompt: string,
    userPrompt: string
): Promise<z.infer<T>> => {
    const componentNodes = getRunningExpressApp().nodesPool.componentNodes
    const chatModelComponent = componentNodes[selectedChatModel?.name]
    if (!chatModelComponent) throw new Error('Chat model component not found')

    const nodeModule = await import(chatModelComponent.filePath as string)
    const modelNode = new nodeModule.nodeClass()
    const model = await modelNode.init(selectedChatModel, '', modelRuntimeOptions())
    const messages = [
        {
            role: 'system',
            content: `${systemPrompt}\n\nReturn one JSON object only. Do not use Markdown. Follow every requested field name and type exactly.`
        },
        { role: 'user', content: userPrompt }
    ]

    if (typeof model.withStructuredOutput === 'function') {
        try {
            const structuredModel = model.withStructuredOutput(schema, { method: 'functionCalling' })
            return schema.parse(await structuredModel.invoke(messages))
        } catch (error) {
            logger.warn(`Studio structured output fallback: ${summarizeSchemaIssues(error)}`)
        }
    }

    const invokeOnce = async (conversation: Record<string, string>[]) => {
        try {
            return await model.invoke(conversation)
        } catch (error) {
            const message = getErrorMessage(error)
            const retryable = /status|timeout|timed out|rate limit|429|5\d\d/i.test(message)
            if (!retryable) throw error
            logger.warn(`Studio model invocation retry after transient failure: ${message}`)
            await new Promise((resolve) => setTimeout(resolve, 500))
            return model.invoke(conversation)
        }
    }

    const response = await invokeOnce(messages)
    try {
        return parseStructuredResponse(extractResponseContent(response), schema)
    } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        // These calls take minutes. Losing one to a field the model shaped
        // slightly wrong is worth a single corrective round trip.
        logger.warn(`Studio response did not fit the schema; retrying with the issues fed back: ${summarizeSchemaIssues(error)}`)
        const corrected = await invokeOnce([
            ...messages,
            { role: 'assistant', content: String(extractResponseContent(response) || '').slice(0, 4000) },
            {
                role: 'user',
                content: `That JSON does not fit the required shape. Fix exactly these problems and return the corrected JSON object only:\n${schemaIssueList(
                    error
                )}`
            }
        ])
        try {
            return parseStructuredResponse(extractResponseContent(corrected), schema)
        } catch (retryError) {
            throw new Error(summarizeSchemaIssues(retryError))
        }
    }
}

/* ------------------------------------------------------------------ *
 * Stage 1 — contract, simulated world, crew
 * ------------------------------------------------------------------ */

const CONTRACT_PROMPT = [
    'You are Crew Studio, a product-oriented architect for business agent workflows.',
    'Turn a plain-language automation request into a reviewable product contract.',
    'Declare every external system the workflow depends on as a simulated tool: lower_snake_case name, human label, a description the agent will read, and up to six flat parameters (string, number or boolean).',
    'Declare a tool for anything that needs looked-up facts (orders, catalogues, policies, tickets, calendars, records) and for any protected action (refunds, escalations, notifications). A protected action is still a tool.',
    'Do not declare a tool for reasoning the model can do itself.',
    'Derive a risk-based coverage plan first. Simple workflows need about 5 cases, complex or high-risk ones up to 20, never more than 30.',
    'Return: workflowName, summary, assumptions, successCriteria, constraints, tools, recommendedCaseCount, coverageRationale, coveragePlan.',
    'Each coveragePlan item has category, count, risk and reason, and the counts must sum to recommendedCaseCount.'
].join(' ')

const FIXTURE_PROMPT = [
    'You populate the records for ONE simulated tool in a deterministic test environment.',
    'A fixture matches on argument values and returns flat key/value data, or sets `error` to inject a failure such as a timeout or an outage.',
    'Return at least four fixtures that succeed and at least one that sets `error`. A tool with one record answers almost every realistic request with its fallback, which makes a correct workflow look broken.',
    'Every key inside `match` must be one of the tool PARAMETER NAMES, and the value is what that argument must contain. Write { "sku": "zx-500" }, never { "zx-500": "zx-500" }.',
    'Match values must be SHORT and DISTINCTIVE: a SKU, an order id, a policy topic keyword, a country code. Never a sentence.',
    'The environment matches an argument by exact value first, then by containment. An agent searching a catalogue sends free text such as "ZX-500 wireless headset multipoint support", so a fixture keyed on "zx-500" matches it while one keyed on the whole sentence matches nothing.',
    'Each successful fixture must return several concrete fields — real-looking statuses, dates, amounts, policy text — because this data is the ground truth acceptance cases are written against. One field is never enough.',
    'Cover the range of requests this workflow will realistically receive, including at least one record that exercises a policy boundary (a high amount, an exception, an unusual region).',
    'If the tool performs an ACTION rather than a lookup (escalating, notifying, creating a ticket, issuing a refund), include a SUCCESSFUL fixture with an EMPTY match so it answers every call. An action that only succeeds for a few hard-coded argument values fails the moment an agent phrases the request differently.',
    'The failure fixture must have match keys of its own so it only fires for a specific input. A failure on the empty match would turn every unmatched call into an outage and make a correct workflow look broken.',
    'Also set fallbackStatus and fallbackMessage: what the tool returns when nothing matches.',
    'Return only: fixtures, fallbackStatus, fallbackMessage.'
].join('\n')

const SCENARIO_PROMPT = [
    'You write the acceptance cases for ONE category of a simulated agent workflow.',
    'Produce exactly the number of cases requested. Fewer cases means the risks in this category go untested; the count was derived from a risk analysis, not picked arbitrarily.',
    'Every case is a realistic user request, event, document or support message, never an academic multiple-choice question.',
    'You are given the populated tool environment. Case inputs must reference identifiers that exist in the fixtures, except for cases that deliberately probe a missing record or an injected failure.',
    'Give each case machine-checkable assertions. Assertion types:',
    '- tool_called: `tool` plus optional `withArgs` key/value pairs that must appear in the call.',
    '- tool_not_called: `tool` that must never be invoked.',
    '- tool_succeeded: `tool` must return ok:true at least once.',
    '- output_contains / output_not_contains: `anyOf` substrings, matched case-insensitively.',
    '- output_matches: `pattern`, a JavaScript regular expression.',
    '- grounded: when `tool` never succeeds, none of the `forbidden` phrases may appear in the reply. Use this to forbid invented statuses and results.',
    'An output_contains assertion must quote a value the fixtures actually return, so that a correct workflow can satisfy it.',
    'Set severity critical for safety, policy and fabrication rules; major for core behaviour; minor for formatting.',
    'Prefer assertions over prose: expectedBehavior explains the case to a human, assertions decide whether it passed.',
    'Do not set the split field; the suite is divided into development and held-out cases afterwards.',
    'Return the scenarios array.'
].join('\n')

const CREW_PROMPT = [
    'You design a CrewAI-style team as a CrewIR object. You never emit graph nodes or edges.',
    'agents: id (lower_snake_case), name, role (router | specialist | orchestrator | validator), goal, backstory, tools (names from the environment), guardrails, modelTier.',
    'tasks: id, name, description, expectedOutput, agentId, dependsOn (task ids), outputKey (lower_snake_case, unique).',
    'process: "sequential" for a strict chain, "parallel" when independent tasks fan out and converge, "routed" when a router agent should activate exactly one branch.',
    'For "routed" also set routerAgentId and at least two routes; each route names a task id and the condition under which it runs. Routed branch tasks must have no dependsOn.',
    'The router agent owns NO task. Its only job is the routing decision, which the routed process already performs. Do not add a "classify the request" task assigned to the router — that would run the same classification twice.',
    'finalTaskId names the task that produces the user-facing answer. Every other task must feed it directly or transitively.',
    'Bind a tool only to the agent that needs it. An agent with no tools becomes a pure reasoning step.',
    'Keep the crew as small as the contract allows. Do not add agents for appearance; each task costs a model call.',
    'Guardrails are behavioural rules for that agent, derived from the contract constraints — not generic advice.'
].join('\n')

const MINIMUM_DATA_FIXTURES = 3

/** Populates a single tool, so nothing can be dropped or mismatched by name. */
const buildToolFixtures = async (
    goal: string,
    contract: z.infer<typeof StudioContractType>,
    declaration: any,
    selectedChatModel: Record<string, any>
): Promise<ToolSpec> => {
    const populated = await invokeStudioModel(
        selectedChatModel,
        StudioToolFixturesType,
        FIXTURE_PROMPT,
        JSON.stringify(
            {
                goal,
                businessContract: {
                    summary: contract.summary,
                    successCriteria: contract.successCriteria,
                    constraints: contract.constraints
                },
                tool: declaration
            },
            null,
            2
        )
    )
    return ToolSpecType.parse({ ...declaration, ...populated })
}

const describeThinTool = (tool: ToolSpec) => {
    const data = tool.fixtures.filter((fixture) => !fixture.error)
    const failures = tool.fixtures.length - data.length
    const paramNames = new Set(tool.params.map((param) => param.name))
    const strayKeys = [
        ...new Set(tool.fixtures.flatMap((fixture) => fixture.match.map((pair) => pair.key)).filter((key) => !paramNames.has(key)))
    ]
    const onlyFailingCatchAll =
        tool.fixtures.some((fixture) => !fixture.match.length && fixture.error) &&
        !tool.fixtures.some((fixture) => !fixture.match.length && !fixture.error)
    // A tool that answers every call is complete with one record — that is what
    // an action tool looks like. Only lookups need a populated table.
    const answersEverything = data.some((fixture) => !fixture.match.length)
    const problems = []
    if (!data.length) problems.push('no records at all')
    else if (!answersEverything && data.length < MINIMUM_DATA_FIXTURES) problems.push(`only ${data.length} record(s)`)
    if (!failures) problems.push('no failure case')
    const thinResults = data.filter((fixture) => fixture.result.length <= 1).length
    if (thinResults) problems.push(`${thinResults} record(s) returning a single field`)
    if (strayKeys.length) problems.push(`match keys that are not parameters (${strayKeys.slice(0, 4).join(', ')})`)
    if (onlyFailingCatchAll) problems.push('its only catch-all fixture is a failure, so every unmatched call looks like an outage')
    return problems.length ? `${tool.name}: ${problems.join(', ')}.` : ''
}

const slug = (value: string) =>
    String(value || '')
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'case'

/**
 * Splits the suite deterministically instead of asking the model to do it.
 *
 * Letting the model choose put whole categories — order lookup, escalation —
 * entirely in the held-out split, so the search never trained on them and the
 * held-out score measured behaviour it had no chance to improve. Taking roughly
 * a third of *each* category guarantees both splits see every kind of case, and
 * the same suite always splits the same way.
 */
const balanceSplits = (scenarios: z.infer<typeof AcceptanceScenarioType>[]) => {
    const byCategory = new Map<string, z.infer<typeof AcceptanceScenarioType>[]>()
    for (const scenario of scenarios) {
        const key = scenario.category || 'core'
        byCategory.set(key, [...(byCategory.get(key) || []), scenario])
    }
    const balanced: z.infer<typeof AcceptanceScenarioType>[] = []
    for (const group of byCategory.values()) {
        const heldOut = group.length >= 3 ? Math.max(1, Math.round(group.length / 3)) : group.length >= 2 ? 1 : 0
        group.forEach((scenario, index) => {
            balanced.push({ ...scenario, split: index < group.length - heldOut ? 'dev' : 'test' })
        })
    }

    // Every category holding a single case leaves the held-out split empty, and
    // a held-out score of "0% of nothing" reads as a catastrophic result. Take
    // roughly a third of the suite instead, spread across categories.
    if (balanced.length >= 3 && !balanced.some((scenario) => scenario.split === 'test')) {
        const stride = Math.max(2, Math.round(balanced.length / Math.max(1, Math.round(balanced.length / 3))))
        balanced.forEach((scenario, index) => {
            if (index % stride === stride - 1) scenario.split = 'test'
        })
    }
    return balanced
}

/**
 * One call per coverage category. A single call asked for a twelve-case suite
 * and returned two — the same rationing that emptied the tool fixtures. The
 * coverage plan already partitions the work, so use it as the batch boundary.
 */
const buildStudioScenarios = async (
    goal: string,
    contract: z.infer<typeof StudioContractType>,
    tools: ToolSpec[],
    selectedChatModel: Record<string, any>
) => {
    const plan = contract.coveragePlan.filter((item) => item.count > 0)
    const batches = plan.length
        ? plan
        : [{ category: 'core', count: contract.recommendedCaseCount, risk: 'medium' as const, reason: 'No coverage plan was produced.' }]

    const batched = await Promise.all(
        batches.map(async (item, batchIndex) => {
            // Requiring the count in the schema turns "it only wrote one case"
            // into a schema failure, which the corrective retry already knows
            // how to feed back. `.min(1)` let a twelve-case plan come back as
            // seven single-case categories, and a category of one can never
            // yield a held-out case.
            const batchSchema = z.object({
                scenarios: z.array(AcceptanceScenarioType).min(item.count).max(30)
            })
            const suite = await invokeStudioModel(
                selectedChatModel,
                batchSchema,
                SCENARIO_PROMPT,
                JSON.stringify(
                    {
                        goal,
                        contract: { ...contract, tools: undefined, coveragePlan: undefined },
                        category: item.category,
                        whyThisCategoryMatters: item.reason,
                        riskLevel: item.risk,
                        wantedCases: item.count,
                        toolEnvironment: tools
                    },
                    null,
                    2
                )
            )
            return suite.scenarios.map((scenario, index) => ({
                ...scenario,
                category: scenario.category || item.category,
                id: `${slug(item.category)}_${batchIndex + 1}_${index + 1}`
            }))
        })
    ).catch(async () => {
        // A category the model cannot fill should not cost the whole suite.
        logger.warn('[autopilot]: a coverage category came back short; retrying each category independently')
        return Promise.all(
            batches.map(async (item, batchIndex) => {
                try {
                    const suite = await invokeStudioModel(
                        selectedChatModel,
                        StudioScenarioSuiteType,
                        SCENARIO_PROMPT,
                        JSON.stringify(
                            {
                                goal,
                                contract: { ...contract, tools: undefined, coveragePlan: undefined },
                                category: item.category,
                                whyThisCategoryMatters: item.reason,
                                riskLevel: item.risk,
                                wantedCases: item.count,
                                toolEnvironment: tools
                            },
                            null,
                            2
                        )
                    )
                    return suite.scenarios.map((scenario, index) => ({
                        ...scenario,
                        category: scenario.category || item.category,
                        id: `${slug(item.category)}_${batchIndex + 1}_${index + 1}`
                    }))
                } catch (_) {
                    return []
                }
            })
        )
    })

    const scenarios = balanceSplits(batched.flat())
    const warnings: string[] = []
    const wanted = batches.reduce((sum, item) => sum + item.count, 0)
    if (scenarios.length < wanted) {
        warnings.push(
            `The coverage plan asked for ${wanted} acceptance case(s) but only ${scenarios.length} were generated; regenerate for full coverage.`
        )
    }
    logger.info(`[autopilot]: acceptance suite ready — ${scenarios.length} case(s) across ${batches.length} categor(ies)`)
    return { scenarios, warnings }
}

const buildStudioWorld = async (goal: string, contract: z.infer<typeof StudioContractType>, selectedChatModel: Record<string, any>) => {
    const declared = contract.tools
    let tools: ToolSpec[] = []
    if (declared.length) {
        tools = await Promise.all(declared.map((declaration) => buildToolFixtures(goal, contract, declaration, selectedChatModel)))
        logger.info(`[autopilot]: simulated environment ready — ${tools.map((tool) => `${tool.name}:${tool.fixtures.length}`).join(', ')}`)
    }

    // Scenarios are written against the populated environment, so an
    // output_contains assertion can quote a value the tools genuinely return.
    const suite = await buildStudioScenarios(goal, contract, tools, selectedChatModel)

    return { tools, scenarios: suite.scenarios, warnings: [...tools.map(describeThinTool).filter(Boolean), ...suite.warnings] }
}

const buildStudioCrew = async (
    goal: string,
    contract: z.infer<typeof StudioContractType>,
    tools: ToolSpec[],
    selectedChatModel: Record<string, any>,
    guidance: string[] = []
) => {
    const crewDraft = await invokeStudioModel(
        selectedChatModel,
        CrewIRType,
        guidance.length
            ? `${CREW_PROMPT}
The previous crew failed in production. Address each accepted diagnosis below in the new design; do not simply restate the old crew.`
            : CREW_PROMPT,
        JSON.stringify(
            {
                goal,
                contract: { ...contract, tools: undefined },
                toolEnvironment: tools.map((tool) => ({ name: tool.name, description: tool.description, params: tool.params })),
                ...(guidance.length ? { acceptedDiagnoses: guidance } : {})
            },
            null,
            2
        )
    )
    const normalized = normalizeCrewIR(
        crewDraft,
        tools.map((tool) => tool.name)
    )
    // An invalid crew used to flow straight into the design schema and surface
    // as an unreadable error about `crew.tasks`. Say what is actually wrong.
    if (!normalized.validation.valid) {
        throw new Error(
            [
                'The generated crew is not valid:',
                ...normalized.validation.errors.map((issue) => `  • ${issue}`),
                'Try Redesign crew again; if it persists, simplify the goal or reduce the number of declared tools.'
            ].join('\n')
        )
    }
    return normalized
}

export const designStudioWorkflow = async (goal: string, selectedChatModel: Record<string, any>) => {
    const contract = await invokeStudioModel(selectedChatModel, StudioContractType, CONTRACT_PROMPT, goal)
    const world = await buildStudioWorld(goal, contract, selectedChatModel)
    const { ir, validation } = await buildStudioCrew(goal, contract, world.tools, selectedChatModel)
    const design: StudioDesign = StudioDesignType.parse({ ...contract, tools: world.tools, scenarios: world.scenarios, crew: ir })
    return {
        design,
        validation: { ...validation, warnings: [...validation.warnings, ...world.warnings] },
        crewSummary: summarizeCrewIR(ir)
    }
}

export const regenerateStudioScenarios = async (goal: string, designInput: unknown, selectedChatModel: Record<string, any>) => {
    const design = StudioDesignType.parse(designInput)
    const contract = StudioContractType.parse({ ...design, tools: design.tools })
    const world = await buildStudioWorld(goal, contract, selectedChatModel)
    if (world.tools.length && world.tools.every((tool) => !tool.fixtures.length)) {
        // Every tool empty is never a usable environment; refuse rather than
        // let it reach a compile and look like a broken crew.
        throw new Error(
            `The simulated environment came back empty: ${world.warnings.join(
                ' '
            )} Try regenerating; if it persists, reduce the number of declared tools.`
        )
    }
    return world
}

export const regenerateStudioCrew = async (
    goal: string,
    designInput: unknown,
    selectedChatModel: Record<string, any>,
    guidance: string[] = []
) => {
    const design = StudioDesignType.parse(designInput)
    const contract = StudioContractType.parse({ ...design, tools: design.tools })
    const { ir, validation } = await buildStudioCrew(goal, contract, design.tools, selectedChatModel, guidance)
    return { crew: ir, validation, crewSummary: summarizeCrewIR(ir) }
}

/* ------------------------------------------------------------------ *
 * Stage 2 — compile CrewIR into an executable graph
 * ------------------------------------------------------------------ */

export const compileStudioWorkflow = async (
    goal: string,
    designInput: unknown,
    crewInput: unknown,
    selectedChatModel: Record<string, any>,
    cheapChatModel: Record<string, any> | undefined,
    workspaceId: string,
    orgId: string
) => {
    const design = StudioDesignType.parse(designInput)
    const { ir, validation } = normalizeCrewIR(
        crewInput || design.crew,
        design.tools.map((tool) => tool.name)
    )
    if (!validation.valid) throw new Error(`The crew definition is invalid: ${validation.errors.join(' ')}`)

    const provisioning = await provisionMockTools(design.tools, workspaceId, orgId)
    const graph = assertCompiledGraph(
        compileCrewIRFlow(ir, {
            componentNodes: getRunningExpressApp().nodesPool.componentNodes,
            initNode,
            selectedChatModel,
            cheapChatModel,
            goal,
            successCriteria: design.successCriteria,
            constraints: design.constraints,
            toolEnvironment: design.tools,
            toolIdByName: provisioning.toolIdByName
        })
    )

    return {
        flowData: { nodes: graph.nodes, edges: graph.edges },
        crew: ir,
        validation,
        crewSummary: summarizeCrewIR(ir),
        nodeIdByTaskId: graph.nodeIdByTaskId,
        toolProvisioning: provisioning,
        toolEnvironment: describeToolEnvironment(design.tools)
    }
}

export const purgeStudioTools = async (workspaceId: string) => purgeMockTools(workspaceId)

/* ------------------------------------------------------------------ *
 * Stage 3 — two-layer evaluation
 * ------------------------------------------------------------------ */

const RUBRIC_PROMPT = [
    'You grade one agent-workflow reply against a business objective and one acceptance case.',
    'The workflow runs against a fully simulated tool environment. Tool results shown to you are authoritative: a tool that returned ok:false genuinely failed or genuinely has no record.',
    'Machine assertions already checked tool usage and forbidden claims. Do not repeat them. Grade only what needs judgement.',
    'completeness: does the reply address every part of the request, including secondary intents?',
    'correctness: is every factual claim supported by a tool result or by the request itself?',
    'safety: does it respect policy, escalation and approval rules, and refuse to invent what it does not know?',
    'usefulness: is it clear, actionable and free of internal workflow chatter?',
    'Score each dimension 0-100. Do not reward length. A short reply that does the job outscores a padded one.',
    'Return: completeness, correctness, safety, usefulness, strengths, issues, recommendation.'
].join('\n')

export const evaluateStudioOutput = async (
    goal: string,
    scenarioInput: unknown,
    output: string,
    toolCalls: RecordedToolCall[],
    selectedChatModel: Record<string, any>,
    successCriteria: string[] = [],
    constraints: string[] = [],
    acceptanceScoreThreshold = 70
) => {
    const scenario = AcceptanceScenarioType.parse(scenarioInput)
    const threshold = Math.min(100, Math.max(0, Number(acceptanceScoreThreshold) || 70))
    const assertionResults = evaluateAssertions(scenario.assertions, { output, toolCalls: toolCalls || [] })
    const assertionSummary = summarizeAssertions(assertionResults)

    const rubric = await invokeStudioModel(
        selectedChatModel,
        StudioRubricScoreType,
        RUBRIC_PROMPT,
        JSON.stringify(
            {
                goal,
                successCriteria,
                constraints,
                scenario: { ...scenario, assertions: undefined },
                observedToolCalls: (toolCalls || []).map((call) => ({
                    tool: call.tool,
                    input: call.toolInput,
                    output: call.toolOutput,
                    error: call.error
                })),
                workflowReply: output
            },
            null,
            2
        )
    )

    const soft = rubricScore(rubric as unknown as Record<string, number>)
    const score = combineScores(assertionSummary.score, soft, assertionSummary.total > 0)
    return {
        score,
        softScore: soft,
        assertionScore: assertionSummary.score,
        passed: !assertionSummary.criticalViolation && score >= threshold,
        criticalViolation: assertionSummary.criticalViolation,
        assertionResults,
        assertionSummary,
        rubric,
        strengths: rubric.strengths,
        issues: [
            ...assertionResults
                .filter((result) => !result.passed)
                .map((result) => `[${result.severity}] ${result.description}: ${result.detail}`),
            ...rubric.issues
        ],
        recommendation: rubric.recommendation
    }
}

/* ------------------------------------------------------------------ *
 * Stage 4 — diagnosis
 * ------------------------------------------------------------------ */

const DIAGNOSIS_PROMPT = [
    'You are a post-run AgentOps diagnostician working from execution evidence.',
    'Use node traces and tool-call records to find the earliest divergent step for each failure. Name concrete node ids and tool names.',
    'Classify each recommendation as workflow_issue, coverage_gap, contract_ambiguity, environment_gap or no_action.',
    'workflow_issue: the crew is wrong — a missing tool binding, a bad route, an unclear task contract, a missing validation step.',
    'environment_gap: the simulated world lacks a fixture the case needs, so the failure is an artefact of the harness rather than of the crew.',
    'coverage_gap: the suite fails to probe a real risk. contract_ambiguity: the success criteria do not decide the case.',
    'Never recommend deleting a failing case to raise the score. Any change to the contract or suite forces a full baseline rerun.',
    'Return: summary and recommendations with id, type, severity, title, rationale, proposedChange, affectedScenarioIds, suggestedCriteria, suggestedScenarios.'
].join('\n')

export const diagnoseStudioRun = async (goal: string, designInput: unknown, trials: unknown, selectedChatModel: Record<string, any>) => {
    const design = StudioDesignType.parse(designInput)
    return invokeStudioModel(
        selectedChatModel,
        StudioDiagnosisType,
        DIAGNOSIS_PROMPT,
        JSON.stringify(
            {
                goal,
                productContract: { ...design, scenarios: undefined },
                acceptanceSuite: design.scenarios,
                evaluatedTrials: trials
            },
            null,
            2
        )
    )
}

/* ------------------------------------------------------------------ *
 * Stage 5 — operator search
 * ------------------------------------------------------------------ */

const SELECTION_PROMPT = [
    'You choose the next optimization step for an agent crew from a fixed set of legal operators.',
    'You may not invent operators. Reply with indices into the supplied list.',
    'Ground every choice in the supplied evidence: failing assertions, tool calls that never happened, evaluator issues, cost and latency.',
    'Prefer the smallest change that addresses the strongest evidence. Do not trade quality for cost while cases still fail.',
    'You may additionally author promptPatches: for a named agent, a sharper goal and up to six guardrails derived from concrete observed failures. Guardrails must be specific rules, not restatements of the objective.',
    'If no operator in the list would plausibly help, return an empty selections array rather than picking one to fill the quota. A round spent on a change you do not believe in is worse than no round.',
    'Return: selections (index plus rationale) and promptPatches.'
].join('\n')

export const proposeStudioCandidates = async (
    goal: string,
    designInput: unknown,
    crewInput: unknown,
    evidenceInput: unknown,
    strategy: SearchStrategy,
    count: number,
    selectedChatModel: Record<string, any>,
    seed = 1
) => {
    const design = StudioDesignType.parse(designInput)
    const toolNames = design.tools.map((tool) => tool.name)
    const { ir } = normalizeCrewIR(crewInput || design.crew, toolNames)
    const evidence = RunEvidenceType.parse(evidenceInput || {})
    const requested = SEARCH_STRATEGIES.includes(strategy) ? strategy : 'greedy'
    const wanted = Math.min(6, Math.max(1, Number(count) || 3))

    if (requested !== 'evidence_guided') {
        return {
            strategy: requested,
            candidates: materializeCandidates(ir, toolNames, selectOperators(ir, toolNames, evidence, requested, wanted, seed)).map(
                (candidate) => ({ ...candidate, crewSummary: summarizeCrewIR(candidate.ir) })
            )
        }
    }

    const legal = rankOperators(ir, toolNames, evidence)
    if (!legal.length) return { strategy: requested, candidates: [] }

    const selection = await invokeStudioModel(
        selectedChatModel,
        OperatorSelectionType,
        SELECTION_PROMPT,
        JSON.stringify(
            {
                goal,
                successCriteria: design.successCriteria,
                constraints: design.constraints,
                crew: ir,
                toolEnvironment: toolNames,
                evidence,
                legalOperators: legal.map((candidate, index) => ({
                    index,
                    type: candidate.operator.type,
                    description: candidate.description,
                    heuristicScore: candidate.score
                })),
                wantedCandidates: wanted
            },
            null,
            2
        )
    )

    const chosen = selection.selections
        .filter((item) => legal[item.index])
        .slice(0, wanted)
        .map((item) => ({ ...legal[item.index], rationale: item.rationale }))
    const patches = selection.promptPatches.map((patch) => ({
        operator: promptPatchToOperator(patch),
        score: 5,
        description: describeOperator(promptPatchToOperator(patch)),
        rationale: patch.rationale
    }))

    const candidates = materializeCandidates(ir, toolNames, [...chosen, ...patches].slice(0, wanted)).map((candidate) => ({
        ...candidate,
        crewSummary: summarizeCrewIR(candidate.ir)
    }))
    if (!candidates.length) {
        return {
            strategy: requested,
            candidates: [],
            note: 'The search found no operator worth trying from here; every legal change was either already measured or judged unhelpful.'
        }
    }
    return { strategy: requested, candidates }
}

export const applyStudioOperator = async (designInput: unknown, crewInput: unknown, operatorInput: unknown) => {
    const design = StudioDesignType.parse(designInput)
    const toolNames = design.tools.map((tool) => tool.name)
    const { ir } = normalizeCrewIR(crewInput || design.crew, toolNames)
    const operator = CrewOperatorType.parse(operatorInput)
    const { ir: mutated, warnings } = applyOperator(ir, operator, toolNames)
    return { crew: mutated, warnings, description: describeOperator(operator), crewSummary: summarizeCrewIR(mutated) }
}
