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
    { id: 'greedy', label: 'Greedy heuristic', description: 'Static priors rank the legal operator set; no extra model call.' },
    { id: 'random', label: 'Random (ablation)', description: 'Uniform sample of the same legal set, seeded for reproducibility.' }
]

/* ------------------------------------------------------------------ *
 * Execution telemetry
 * ------------------------------------------------------------------ */

export const summarizePrediction = (prediction, durationMs) => {
    const executionData = Array.isArray(prediction?.agentFlowExecutedData) ? prediction.agentFlowExecutedData : []
    let totalTokens = 0
    let estimatedCost = 0
    let modelCalls = 0

    for (const node of executionData) {
        const output = node?.data?.output || {}
        const usage = output.usageMetadata || output.usage_metadata
        if (!usage) continue
        const inputTokens = numberValue(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
        const outputTokens = numberValue(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
        totalTokens += numberValue(usage.total_tokens, usage.totalTokens, inputTokens + outputTokens)
        estimatedCost += numberValue(usage.total_cost, usage.totalCost, usage.cost)
        modelCalls += 1
    }

    return { executionId: prediction?.executionId || null, totalTokens, estimatedCost, durationMs, modelCalls }
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

const noWorse = (left, right) =>
    left.summary.quality >= right.summary.quality &&
    left.summary.averageCost <= right.summary.averageCost &&
    left.summary.averageDurationMs <= right.summary.averageDurationMs

const strictlyBetter = (left, right) =>
    left.summary.quality > right.summary.quality ||
    left.summary.averageCost < right.summary.averageCost ||
    left.summary.averageDurationMs < right.summary.averageDurationMs

export const getParetoTrialIds = (
    trials = [],
    qualityFloor = 0,
    minimumPassRate = MIN_OPTIMIZATION_PASS_RATE,
    maximumFailureRate = MAX_OPTIMIZATION_FAILURE_RATE
) => {
    const feasible = trials.filter(
        (trial) =>
            trial.summary && isTrialFeasible(trial.summary, minimumPassRate, maximumFailureRate) && trial.summary.quality >= qualityFloor
    )
    return feasible
        .filter(
            (candidate) =>
                !feasible.some((other) => other.id !== candidate.id && noWorse(other, candidate) && strictlyBetter(other, candidate))
        )
        .map((trial) => trial.id)
}

export const selectNextTrial = (
    trials = [],
    baselineQuality = 0,
    allowedQualityLoss = 0.05,
    minimumPassRate = MIN_OPTIMIZATION_PASS_RATE,
    maximumFailureRate = MAX_OPTIMIZATION_FAILURE_RATE
) => {
    const qualityFloor = Math.max(0, baselineQuality - allowedQualityLoss)
    const paretoIds = new Set(getParetoTrialIds(trials, qualityFloor, minimumPassRate, maximumFailureRate))
    return trials
        .filter((trial) => paretoIds.has(trial.id))
        .sort(
            (left, right) =>
                left.summary.averageCost - right.summary.averageCost ||
                left.summary.averageDurationMs - right.summary.averageDurationMs ||
                right.summary.quality - left.summary.quality
        )[0]
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
