/**
 * Pure helpers for Workflow Autopilot.
 *
 * Everything here is free of React and of network access so the optimization
 * loop's decision rules can be unit tested directly.
 */

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0)

const numberValue = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '')
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

export const DEFAULT_ACCEPTANCE_SCORE_THRESHOLD = 70
export const MIN_OPTIMIZATION_PASS_RATE = 0.6
export const MAX_OPTIMIZATION_FAILURE_RATE = 0.1

export const SEARCH_STRATEGIES = [
    {
        id: 'evidence_guided',
        label: 'Evidence-guided',
        description: 'The model picks operators from the legal set using observed failures.'
    },
    {
        id: 'evidence_guided_v2',
        label: 'Evidence-guided (checked)',
        description: 'Like evidence-guided, but operators are shown with their effect and each pick must name its operator type.'
    },
    { id: 'greedy', label: 'Greedy heuristic', description: 'Static priors rank the legal operator set; no extra model call.' },
    { id: 'random', label: 'Random (ablation)', description: 'Uniform sample of the same legal set, seeded for reproducibility.' }
]

/* ------------------------------------------------------------------ *
 * Execution telemetry
 * ------------------------------------------------------------------ */

/**
 * Token, cost and call totals for one execution trace, overall and per node.
 * The experiment, the playground monitor and Token Analytics all read the same
 * `usageMetadata`, so a turn in the playground is directly comparable with a
 * case measured during the search.
 */
export const summarizeExecutedData = (executionData = []) => {
    const nodes = Array.isArray(executionData) ? executionData : []
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, modelCalls: 0, toolCalls: 0 }
    const agents = new Map()

    nodes.forEach((node, index) => {
        const output = node?.data?.output || {}
        const usage = output.usageMetadata || output.usage_metadata
        const toolCalls = (output.usedTools || []).filter(Boolean).length
        if (!usage && !toolCalls) return
        const inputTokens = usage ? numberValue(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) : 0
        const outputTokens = usage
            ? numberValue(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
            : 0
        const totalTokens = usage ? numberValue(usage.total_tokens, usage.totalTokens, inputTokens + outputTokens) : 0
        const estimatedCost = usage ? numberValue(usage.total_cost, usage.totalCost, usage.cost) : 0
        const name = node?.nodeLabel || node?.data?.nodeLabel || node?.nodeId || `Node ${index + 1}`
        const agent = agents.get(name) || {
            name,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            toolCalls: 0
        }
        if (usage) {
            // Agent nodes report every call of a tool loop in `model_calls`.
            const calls = Math.max(1, numberValue(usage.model_calls, 1))
            agent.calls += calls
            totals.modelCalls += calls
        }
        agent.inputTokens += inputTokens
        agent.outputTokens += outputTokens
        agent.totalTokens += totalTokens
        agent.estimatedCost += estimatedCost
        agent.toolCalls += toolCalls
        totals.inputTokens += inputTokens
        totals.outputTokens += outputTokens
        totals.totalTokens += totalTokens
        totals.estimatedCost += estimatedCost
        totals.toolCalls += toolCalls
        agents.set(name, agent)
    })

    return { ...totals, agents: [...agents.values()].sort((left, right) => right.totalTokens - left.totalTokens) }
}

export const summarizePrediction = (prediction, durationMs) => {
    const usage = summarizeExecutedData(prediction?.agentFlowExecutedData)
    return {
        executionId: prediction?.executionId || null,
        totalTokens: usage.totalTokens,
        estimatedCost: usage.estimatedCost,
        durationMs,
        modelCalls: usage.modelCalls
    }
}

export const extractStudioOutput = (prediction = {}) => {
    if (typeof prediction.text === 'string' && prediction.text.trim()) return prediction.text
    if (prediction.text !== undefined && prediction.text !== null && typeof prediction.text !== 'string') {
        const serialized = JSON.stringify(prediction.text)
        if (serialized && serialized !== '""' && serialized !== '{}') return serialized
    }
    const executionData = Array.isArray(prediction.agentFlowExecutedData) ? prediction.agentFlowExecutedData : []
    for (let index = executionData.length - 1; index >= 0; index -= 1) {
        const output = executionData[index]?.data?.output
        if (typeof output === 'string' && output.trim()) return output
        if (typeof output?.content === 'string' && output.content.trim()) return output.content
        if (typeof output?.text === 'string' && output.text.trim()) return output.text
    }
    return ''
}

const compactTraceValue = (value, limit = 1200) => {
    if (value === undefined || value === null) return ''
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return String(text || '').slice(0, limit)
}

export const extractStudioTrace = (prediction = {}) =>
    (Array.isArray(prediction.agentFlowExecutedData) ? prediction.agentFlowExecutedData : []).map((entry, index) => ({
        index,
        nodeId: entry?.nodeId || entry?.data?.nodeId || `node-${index + 1}`,
        nodeLabel: entry?.nodeLabel || entry?.data?.nodeLabel || '',
        status: entry?.status || 'UNKNOWN',
        previousNodeIds: entry?.previousNodeIds || [],
        input: compactTraceValue(entry?.data?.input),
        output: compactTraceValue(entry?.data?.output),
        toolCalls: (entry?.data?.output?.usedTools || []).map((tool) => tool?.tool).filter(Boolean)
    }))

/**
 * The simulated environment records every call, which is what makes tool-usage
 * assertions checkable rather than a matter of opinion.
 */
export const extractStudioToolCalls = (prediction = {}) =>
    (Array.isArray(prediction.agentFlowExecutedData) ? prediction.agentFlowExecutedData : []).flatMap((entry) =>
        (entry?.data?.output?.usedTools || []).filter(Boolean).map((usedTool) => ({
            nodeId: entry?.nodeId || '',
            tool: usedTool.tool,
            toolInput: usedTool.toolInput || {},
            toolOutput: usedTool.toolOutput,
            error: usedTool.error || ''
        }))
    )

export const validateStudioOutput = (output = '', scenario = {}) => {
    const text = String(output || '').trim()
    if (!text) return 'execution completed without an extractable final output'
    if (/{{\s*[^{}]+\s*}}/.test(text)) return 'the final response contains an unresolved workflow variable'
    if (/^(undefined|null|\[object Object\])$/i.test(text)) return 'the final response is a runtime placeholder'
    if (text.length < 24) return 'the final response is too short to be a usable workflow result'

    const asksForAlreadyProvidedInput = [
        /please (?:send|share|provide|paste) (?:the )?(?:employee|customer|user|claim|request|incident|issue|ticket)/i,
        /(?:need|require) (?:the )?(?:employee|customer|user|claim|request|incident|issue|ticket) (?:details|text|information)/i,
        /if you (?:already )?have the request,? paste it/i
    ].some((pattern) => pattern.test(text))
    if (String(scenario?.input || '').trim().length >= 20 && asksForAlreadyProvidedInput) {
        return 'the workflow ignored the supplied scenario and requested the same input again'
    }
    return ''
}

/* ------------------------------------------------------------------ *
 * Acceptance suite
 * ------------------------------------------------------------------ */

/** dev cases drive the search; test cases are only ever run for the final report. */
export const splitScenarios = (scenarios = []) => ({
    dev: scenarios.filter((scenario) => scenario.split !== 'test'),
    test: scenarios.filter((scenario) => scenario.split === 'test')
})

export const selectPreflightScenarios = (scenarios = [], limit = 2) => {
    const available = (scenarios || []).filter(Boolean)
    if (!available.length || limit <= 0) return []
    const selected = []
    const add = (scenario) => {
        if (scenario && !selected.some((item) => item.id === scenario.id)) selected.push(scenario)
    }
    add(available.find((scenario) => (scenario.requiredTools || []).length))
    for (const scenario of available) add(scenario)
    return selected.slice(0, Math.min(limit, available.length))
}

export const summarizeStudioResults = (results = []) => {
    const completed = results.filter((result) => !result.error)
    const assertionsTotal = completed.reduce((sum, result) => sum + Number(result.evaluation?.assertionSummary?.total || 0), 0)
    const assertionsPassed = completed.reduce((sum, result) => sum + Number(result.evaluation?.assertionSummary?.passed || 0), 0)
    return {
        total: results.length,
        completed: completed.length,
        failed: results.length - completed.length,
        quality: mean(completed.map((result) => result.evaluation?.score)) / 100,
        assertionRate: assertionsTotal ? assertionsPassed / assertionsTotal : 0,
        passRate: completed.length ? completed.filter((result) => result.evaluation?.passed).length / completed.length : 0,
        criticalViolations: completed.filter((result) => result.evaluation?.criticalViolation).length,
        averageTokens: mean(completed.map((result) => result.totalTokens)),
        averageCost: mean(completed.map((result) => result.estimatedCost)),
        averageDurationMs: mean(completed.map((result) => result.durationMs)),
        averageModelCalls: mean(completed.map((result) => result.modelCalls))
    }
}

/**
 * Condenses one trial into the evidence the operator search reasons over.
 * Everything here is observed, never assumed.
 */
export const buildRunEvidence = (results = [], summary = {}, design = {}, crew = {}, triedOperators = []) => {
    const failed = results.filter((result) => result.error || result.evaluation?.passed === false)
    const failedAssertions = results.flatMap((result) => (result.evaluation?.assertionResults || []).filter((item) => !item.passed))
    const calledTools = new Set(results.flatMap((result) => (result.toolCalls || []).map((call) => call.tool)))
    const declaredTools = (design.tools || []).map((tool) => tool.name)
    const boundTools = new Set((crew.agents || []).flatMap((agent) => agent.tools || []))
    const missingToolCalls = [
        ...new Set(
            failedAssertions.filter((item) => ['tool_called', 'tool_succeeded'].includes(item.type) && item.tool).map((item) => item.tool)
        )
    ]

    return {
        passRate: Number(summary.passRate || 0),
        failureRate: summary.total ? Number(summary.failed || 0) / Number(summary.total) : 0,
        quality: Number(summary.quality || 0),
        averageCost: Number(summary.averageCost || 0),
        averageDurationMs: Number(summary.averageDurationMs || 0),
        averageModelCalls: Number(summary.averageModelCalls || 0),
        failingScenarioIds: failed.map((result) => result.scenarioId).filter(Boolean),
        failedAssertionTypes: [...new Set(failedAssertions.map((item) => item.type))],
        missingToolCalls,
        // A required tool nobody holds is an access problem the search can fix by
        // binding it. A required tool that is bound but never reached is not —
        // more binding would only burn rounds, as it did in the first run.
        unboundRequiredTools: missingToolCalls.filter((tool) => !boundTools.has(tool)),
        unusedTools: declaredTools.filter((tool) => !calledTools.has(tool)),
        errorMessages: [...new Set(failed.map((result) => result.error).filter(Boolean))].slice(0, 8),
        evaluatorIssues: [...new Set(failed.flatMap((result) => result.evaluation?.issues || []))].slice(0, 12),
        triedOperators: [...new Set((triedOperators || []).filter(Boolean))]
    }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

export const isTrialFeasible = (
    summary = {},
    minimumPassRate = MIN_OPTIMIZATION_PASS_RATE,
    maximumFailureRate = MAX_OPTIMIZATION_FAILURE_RATE
) => {
    const total = Number(summary?.total || Number(summary?.completed || 0) + Number(summary?.failed || 0))
    if (!total || Number(summary?.completed || 0) <= 0) return false
    return Number(summary?.failed || 0) / total <= Number(maximumFailureRate) && Number(summary?.passRate || 0) >= Number(minimumPassRate)
}

// Under `pass_first`, pass rate is an objective of its own: a crew that passes
// more cases is never dominated by a cheaper one that passes fewer.
const noWorse = (left, right, withPassRate) =>
    (!withPassRate || Number(left.summary.passRate || 0) >= Number(right.summary.passRate || 0)) &&
    left.summary.quality >= right.summary.quality &&
    left.summary.averageCost <= right.summary.averageCost &&
    left.summary.averageDurationMs <= right.summary.averageDurationMs

const strictlyBetter = (left, right, withPassRate) =>
    (withPassRate && Number(left.summary.passRate || 0) > Number(right.summary.passRate || 0)) ||
    left.summary.quality > right.summary.quality ||
    left.summary.averageCost < right.summary.averageCost ||
    left.summary.averageDurationMs < right.summary.averageDurationMs

export const getParetoTrialIds = (
    trials = [],
    qualityFloor = 0,
    minimumPassRate = MIN_OPTIMIZATION_PASS_RATE,
    maximumFailureRate = MAX_OPTIMIZATION_FAILURE_RATE,
    selectionRule = 'pass_first'
) => {
    const withPassRate = selectionRule !== 'cost_first'
    const feasible = trials.filter(
        (trial) =>
            trial.summary && isTrialFeasible(trial.summary, minimumPassRate, maximumFailureRate) && trial.summary.quality >= qualityFloor
    )
    return feasible
        .filter(
            (candidate) =>
                !feasible.some(
                    (other) =>
                        other.id !== candidate.id &&
                        noWorse(other, candidate, withPassRate) &&
                        strictlyBetter(other, candidate, withPassRate)
                )
        )
        .map((trial) => trial.id)
}

/**
 * Final recommendation among the feasible Pareto crews. `pass_first` (default)
 * puts correctness before cost: highest pass rate, then quality, then cost and
 * latency, on a frontier that includes pass rate. `cost_first` is the earlier
 * rule (frontier over quality, cost and latency only; cheapest, then fastest,
 * then best quality), kept because the thesis experiments were run with it; it
 * traded a passed case for a few percent fewer tokens on healthy crews.
 */
export const SELECTION_RULES = ['pass_first', 'cost_first']

export const selectNextTrial = (
    trials = [],
    baselineQuality = 0,
    allowedQualityLoss = 0.05,
    minimumPassRate = MIN_OPTIMIZATION_PASS_RATE,
    maximumFailureRate = MAX_OPTIMIZATION_FAILURE_RATE,
    selectionRule = 'pass_first'
) => {
    const qualityFloor = Math.max(0, baselineQuality - allowedQualityLoss)
    const paretoIds = new Set(getParetoTrialIds(trials, qualityFloor, minimumPassRate, maximumFailureRate, selectionRule))
    const costFirst = (left, right) =>
        left.summary.averageCost - right.summary.averageCost ||
        left.summary.averageDurationMs - right.summary.averageDurationMs ||
        right.summary.quality - left.summary.quality
    const passFirst = (left, right) =>
        right.summary.passRate - left.summary.passRate || right.summary.quality - left.summary.quality || costFirst(left, right)
    return trials.filter((trial) => paretoIds.has(trial.id)).sort(selectionRule === 'cost_first' ? costFirst : passFirst)[0]
}

/**
 * Hill-climbing parent for the next round: the healthiest trial so far, with the
 * baseline as the floor so a bad round cannot poison the search.
 */
export const selectSearchParent = (trials = []) =>
    [...trials]
        .filter((trial) => trial.summary && trial.summary.completed > 0)
        .sort(
            (left, right) =>
                right.summary.passRate - left.summary.passRate ||
                right.summary.quality - left.summary.quality ||
                left.summary.averageCost - right.summary.averageCost
        )[0] || trials[0]

export const buildSearchTree = (trials = []) => {
    const byId = new Map(trials.map((trial) => [trial.id, { ...trial, children: [] }]))
    const roots = []
    for (const trial of byId.values()) {
        const parent = trial.parentId ? byId.get(trial.parentId) : null
        if (parent) parent.children.push(trial)
        else roots.push(trial)
    }
    return roots
}

export const readFlowData = (flowData) => {
    if (!flowData) return { nodes: [], edges: [] }
    if (typeof flowData !== 'string') return flowData
    try {
        return JSON.parse(flowData)
    } catch (_) {
        return { nodes: [], edges: [] }
    }
}

/* ------------------------------------------------------------------ *
 * Deployed crews
 * ------------------------------------------------------------------ */

/**
 * Pairs each user message with the reply that answered it. The last reply is
 * incomplete while the chat is still streaming; nothing downstream (metrics,
 * automatic review) may treat a half-written answer as the crew's output.
 */
export const buildConversationTurns = (messages = [], loading = false) => {
    const list = Array.isArray(messages) ? messages : []
    const turns = []
    let question = null
    list.forEach((message, position) => {
        if (message?.type === 'userMessage') {
            question = String(message.message ?? '')
            return
        }
        if (message?.type !== 'apiMessage' || question === null) return
        const executedData = Array.isArray(message.agentFlowExecutedData) ? message.agentFlowExecutedData : []
        turns.push({
            index: turns.length,
            key: message.id || `turn-${turns.length}`,
            messageId: message.id || '',
            question,
            answer: String(message.message ?? ''),
            executedData,
            toolCalls: extractStudioToolCalls({ agentFlowExecutedData: executedData }),
            usage: summarizeExecutedData(executedData),
            failed: executedData.some((node) => node?.status === 'ERROR'),
            complete: !(loading && position === list.length - 1)
        })
        question = null
    })
    return turns
}

export const summarizeTurns = (turns = []) => {
    const measured = (turns || []).filter((turn) => turn.complete && turn.executedData.length)
    return {
        turns: measured.length,
        totalTokens: measured.reduce((sum, turn) => sum + turn.usage.totalTokens, 0),
        estimatedCost: measured.reduce((sum, turn) => sum + turn.usage.estimatedCost, 0),
        averageTokens: mean(measured.map((turn) => turn.usage.totalTokens)),
        averageCost: mean(measured.map((turn) => turn.usage.estimatedCost)),
        averageModelCalls: mean(measured.map((turn) => turn.usage.modelCalls))
    }
}

/** A live average this many times the measured one is flagged as drift. */
export const LAB_DRIFT_RATIO = 1.5

const LAB_METRICS = [
    ['averageTokens', 'Tokens / turn'],
    ['averageCost', 'Cost / turn'],
    ['averageModelCalls', 'Model calls / turn'],
    ['averageDurationMs', 'Latency / turn']
]

/**
 * Live usage against what the crew was measured at before it was deployed.
 * Real traffic that costs far more than the acceptance suite predicted is itself
 * evidence: either the suite under-represents real requests or the crew loops.
 */
export const compareToLab = (live = {}, lab = {}, driftRatio = LAB_DRIFT_RATIO) =>
    LAB_METRICS.map(([key, label]) => {
        const expected = Number(lab?.[key] || 0)
        const observed = Number(live?.[key] || 0)
        const ratio = expected > 0 && observed > 0 ? observed / expected : null
        return { key, label, expected, observed, ratio, drift: ratio !== null && ratio >= driftRatio }
    })

/**
 * The regression suite for an improvement run: the original development cases
 * plus every accepted case collected from real conversations. Held-out cases
 * stay held out, exactly as in the experiment.
 */
export const buildImprovementSuite = (design = {}, onlineCases = []) => {
    const accepted = (onlineCases || []).filter((item) => item.status === 'accepted')
    const online = accepted.filter((item) => item.scenario).map((item) => ({ ...item.scenario, id: item.id, split: 'dev' }))
    const { dev, test } = splitScenarios(design?.scenarios || [])
    return {
        dev: [...dev, ...online],
        test,
        onlineIds: online.map((scenario) => scenario.id),
        caseIds: accepted.map((item) => item.id),
        instructions: [...new Set(accepted.map((item) => String(item.instruction || '').trim()).filter(Boolean))]
    }
}

export const summarizeResultSubset = (results = [], ids = new Set()) => {
    const subset = (results || []).filter((result) => ids.has(result.scenarioId))
    return subset.length ? summarizeStudioResults(subset) : null
}
