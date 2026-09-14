import chatflowsApi from '@/api/chatflows'
import predictionApi from '@/api/prediction'

import {
    extractStudioOutput,
    extractStudioToolCalls,
    extractStudioTrace,
    selectPreflightScenarios,
    summarizePrediction,
    validateStudioOutput
} from './studioUtils'

/**
 * Executes acceptance cases against a compiled flow and scores them.
 *
 * Shared by the experiment and by the improvement loop on a deployed crew, so a
 * candidate is measured the same way whether it came from the search or from
 * feedback on real conversations — otherwise the two numbers would not compare.
 */

/**
 * A crew execution is several chained model calls, so it is legitimately slow —
 * but never unbounded. Without this a hung execution leaves the run spinning
 * with no error and no way out but a page reload.
 */
export const EXECUTION_TIMEOUT = 8 * 60 * 1000

export const errorMessage = (error) => {
    // Axios reports a timeout as "timeout of 480000ms exceeded", which tells a
    // user nothing about what to do next.
    if (error?.code === 'ECONNABORTED') {
        return `The request timed out after ${Math.round(
            Number(error?.config?.timeout || 0) / 1000
        )}s. The model or the workflow stalled; nothing is still running.`
    }
    return error?.response?.data?.message || error?.message || String(error)
}

const noop = () => undefined

export const runScenariosOnFlow = async ({
    trial,
    scenarios,
    goal,
    design,
    selectedChatModel,
    acceptanceScoreThreshold,
    concurrency,
    runPrefix,
    shouldStop = () => false,
    onStatus = noop,
    onProgress,
    trackRun = noop,
    untrackRun = noop
}) => {
    const results = new Array(scenarios.length)
    let cursor = 0

    const worker = async () => {
        while (!shouldStop()) {
            const index = cursor
            cursor += 1
            if (index >= scenarios.length) return
            const scenario = scenarios[index]
            const startedAt = Date.now()
            onStatus(`${trial.name} · ${scenario.title}`)
            const runId = `${runPrefix}-${trial.id}-${scenario.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
            try {
                trackRun(trial.flowId, runId)
                const { data: prediction } = await predictionApi.sendMessageAndGetPrediction(
                    trial.flowId,
                    {
                        question: scenario.input,
                        streaming: false,
                        chatId: runId,
                        overrideConfig: { sessionId: runId }
                    },
                    { timeout: EXECUTION_TIMEOUT }
                )
                untrackRun(runId)
                // An aborted execution returns whatever it had reached;
                // recording that would poison the trial's metrics.
                if (shouldStop()) return
                const output = extractStudioOutput(prediction)
                const toolCalls = extractStudioToolCalls(prediction)
                const outputProblem = validateStudioOutput(output, scenario)
                if (outputProblem) throw new Error(`Workflow output validation failed: ${outputProblem}.`)
                const { data: evaluation } = await chatflowsApi.evaluateStudioOutput({
                    goal,
                    scenario,
                    output,
                    toolCalls,
                    successCriteria: design.successCriteria,
                    constraints: design.constraints,
                    acceptanceScoreThreshold: Number(acceptanceScoreThreshold),
                    selectedChatModel
                })
                results[index] = {
                    scenarioId: scenario.id,
                    title: scenario.title,
                    split: scenario.split || 'dev',
                    output,
                    toolCalls,
                    trace: extractStudioTrace(prediction),
                    evaluation,
                    ...summarizePrediction(prediction, Date.now() - startedAt)
                }
            } catch (caseError) {
                untrackRun(runId)
                if (shouldStop()) return
                results[index] = {
                    scenarioId: scenario.id,
                    title: scenario.title,
                    split: scenario.split || 'dev',
                    error: errorMessage(caseError)
                }
            }
            onProgress?.()
        }
    }

    // A crew fans one case out to several model calls. Running large crews
    // fully concurrently produces provider bursts that show up as random
    // execution failures, which would be indistinguishable from a bad
    // candidate — so serialize once the graph is large.
    const modelNodes = (trial.flowData?.nodes || []).filter((node) =>
        ['agentAgentflow', 'llmAgentflow', 'conditionAgentAgentflow'].includes(node?.data?.name)
    ).length
    const workers = modelNodes >= 6 ? 1 : Math.max(1, Math.min(Number(concurrency), scenarios.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    return results.filter(Boolean)
}

export const preflightFlow = async ({
    trial,
    scenarios,
    shouldStop = () => false,
    onStatus = noop,
    trackRun = noop,
    untrackRun = noop
}) => {
    const smoke = selectPreflightScenarios(scenarios)
    if (!smoke.length) return
    onStatus(`${trial.name} · ${smoke.length} executable-readiness checks…`)
    for (const scenario of smoke) {
        if (shouldStop()) return
        const runId = `${trial.id}-preflight-${scenario.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
        let prediction
        try {
            trackRun(trial.flowId, runId)
            const response = await predictionApi.sendMessageAndGetPrediction(
                trial.flowId,
                {
                    question: scenario.input,
                    streaming: false,
                    chatId: runId,
                    overrideConfig: { sessionId: runId }
                },
                { timeout: EXECUTION_TIMEOUT }
            )
            prediction = response.data
        } finally {
            untrackRun(runId)
        }
        if (shouldStop()) return
        const problem = validateStudioOutput(extractStudioOutput(prediction), scenario)
        if (problem) throw new Error(`preflight failed on "${scenario.title}": ${problem}`)
    }
}
