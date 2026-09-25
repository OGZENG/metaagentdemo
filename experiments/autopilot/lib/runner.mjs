import { createChatflow, InfraError, isInfraError, predict, studio } from './api.mjs'
import {
    buildRunEvidence,
    extractStudioOutput,
    extractStudioToolCalls,
    extractStudioTrace,
    getParetoTrialIds,
    selectNextTrial,
    selectPreflightScenarios,
    selectSearchParent,
    splitScenarios,
    summarizeExecutedData,
    summarizePrediction,
    summarizeStudioResults,
    validateStudioOutput
} from '../../../packages/ui/src/views/metaagent/studioUtils.js'

/**
 * Headless port of the studio's experiment loop (useAutopilotRun.js and
 * studioRunner.js). The decision rules are imported from studioUtils.js rather
 * than re-implemented, so a headless run selects exactly what the UI would.
 */

export const DEFAULT_SETTINGS = {
    strategy: 'evidence_guided',
    searchRounds: 2,
    candidatesPerRound: 3,
    acceptanceScoreThreshold: 70,
    minimumPassRate: 0.6,
    maximumFailureRate: 0.1,
    allowedQualityLoss: 0.1,
    concurrency: 2,
    seed: 1,
    runHeldOutSuite: true
}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const errorText = (error) => error?.message || String(error)

export const compileTrial = async ({ goal, design, crew, name, selectedChatModel, cheapChatModel, mutateFlow }) => {
    const data = await studio('compile', { goal, design, crew, selectedChatModel, cheapChatModel })
    const flowData = mutateFlow ? mutateFlow(structuredClone(data.flowData)) : data.flowData
    const created = await createChatflow(name, flowData)
    return {
        flowId: created.id,
        flowData,
        crew: data.crew,
        crewSummary: data.crewSummary,
        toolProvisioning: data.toolProvisioning,
        warnings: data.validation?.warnings || []
    }
}

/** Same as runScenariosOnFlow: prediction, output validation, two-layer evaluation. */
export const runScenarios = async ({ trial, scenarios, goal, design, selectedChatModel, settings, runPrefix }) => {
    const results = new Array(scenarios.length)
    let cursor = 0
    const worker = async () => {
        for (;;) {
            const index = cursor
            cursor += 1
            if (index >= scenarios.length) return
            const scenario = scenarios[index]
            const startedAt = Date.now()
            const runId = `${runPrefix}-${trial.id}-${scenario.id}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '-')
            try {
                const prediction = await predict(trial.flowId, scenario.input, runId)
                const output = extractStudioOutput(prediction)
                const toolCalls = extractStudioToolCalls(prediction)
                const problem = validateStudioOutput(output, scenario)
                if (problem) throw new Error(`Workflow output validation failed: ${problem}.`)
                const evaluation = await studio('evaluate', {
                    goal,
                    scenario,
                    output,
                    toolCalls,
                    successCriteria: design.successCriteria,
                    constraints: design.constraints,
                    acceptanceScoreThreshold: settings.acceptanceScoreThreshold,
                    selectedChatModel
                })
                results[index] = {
                    scenarioId: scenario.id,
                    title: scenario.title,
                    category: scenario.category,
                    split: scenario.split || 'dev',
                    output,
                    toolCalls,
                    trace: extractStudioTrace(prediction),
                    agents: summarizeExecutedData(prediction?.agentFlowExecutedData).agents,
                    evaluation,
                    ...summarizePrediction(prediction, Date.now() - startedAt)
                }
                log(`  ${trial.id} · ${scenario.id}: score ${Math.round(evaluation.score)} ${evaluation.passed ? 'PASS' : 'fail'}`)
            } catch (error) {
                if (isInfraError(error)) throw new InfraError(`infrastructure failure, aborting run: ${errorText(error)}`)
                results[index] = {
                    scenarioId: scenario.id,
                    title: scenario.title,
                    category: scenario.category,
                    split: scenario.split || 'dev',
                    durationMs: Date.now() - startedAt,
                    error: errorText(error)
                }
                log(`  ${trial.id} · ${scenario.id}: ERROR ${errorText(error).slice(0, 160)}`)
            }
        }
    }
    const modelNodes = (trial.flowData?.nodes || []).filter((node) =>
        ['agentAgentflow', 'llmAgentflow', 'conditionAgentAgentflow'].includes(node?.data?.name)
    ).length
    const workers = modelNodes >= 6 ? 1 : Math.max(1, Math.min(Number(settings.concurrency), scenarios.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    return results.filter(Boolean)
}

export const preflight = async (trial, scenarios) => {
    for (const scenario of selectPreflightScenarios(scenarios)) {
        const prediction = await predict(trial.flowId, scenario.input, `${trial.id}-preflight-${scenario.id}-${Date.now()}`)
        const problem = validateStudioOutput(extractStudioOutput(prediction), scenario)
        if (problem) throw new Error(`preflight failed on "${scenario.title}": ${problem}`)
    }
}

/**
 * One complete search as the studio runs it: baseline on dev, `searchRounds`
 * rounds of operator candidates, held-out evaluation of the Pareto frontier,
 * final selection. `baseline` may carry pre-measured devResults to share one
 * baseline measurement across strategies.
 */
export const runSearch = async ({ goal, design, baseline, selectedChatModel, cheapChatModel, settings: overrides = {}, runPrefix }) => {
    const settings = { ...DEFAULT_SETTINGS, ...overrides }
    const { dev, test } = splitScenarios(design.scenarios)
    const common = { goal, design, selectedChatModel, settings, runPrefix }
    const startedAt = Date.now()

    let trials = []
    const rounds = []
    if (baseline.devResults?.length) {
        trials = [{ ...baseline }]
    } else {
        log(`baseline on ${dev.length} dev cases`)
        const devResults = await runScenarios({ ...common, trial: baseline, scenarios: dev })
        trials = [{ ...baseline, devResults, summary: summarizeStudioResults(devResults) }]
    }

    for (let round = 1; round <= settings.searchRounds; round += 1) {
        const parent = selectSearchParent(trials)
        const evidence = buildRunEvidence(
            parent.devResults,
            parent.summary,
            design,
            parent.crew,
            trials.map((trial) => trial.operatorSignature)
        )
        let proposals = []
        let proposalNote = ''
        try {
            const data = await studio('candidates', {
                goal,
                design,
                crew: parent.crew,
                evidence,
                strategy: settings.strategy,
                count: settings.candidatesPerRound,
                seed: Number(settings.seed) + round,
                selectedChatModel
            })
            proposals = data.candidates || []
            proposalNote = data.note || ''
            rounds.push({ round, parentId: parent.id, proposed: proposals.length, inconsistentSelections: data.inconsistentSelections || [], note: proposalNote })
        } catch (error) {
            if (isInfraError(error)) throw error
            proposalNote = `proposal failed: ${errorText(error)}`
        }
        log(`round ${round}: parent ${parent.id}, ${proposals.length} proposal(s) ${proposalNote}`)

        for (let index = 0; index < proposals.length; index += 1) {
            const proposal = proposals[index]
            const id = `r${round}-c${index + 1}-${proposal.operator.type}`
            const base = {
                id,
                name: `${design.workflowName} [${runPrefix} R${round}C${index + 1} · ${proposal.operator.type}]`,
                parentId: parent.id,
                round,
                operator: proposal.operator,
                operatorSignature: proposal.signature,
                operatorDescription: proposal.description,
                rationale: proposal.rationale
            }
            let compiled
            try {
                compiled = await compileTrial({ goal, design, crew: proposal.ir, name: base.name, selectedChatModel, cheapChatModel })
                await preflight({ ...compiled, id }, dev)
            } catch (error) {
                if (isInfraError(error)) throw error
                log(`  ${id}: rejected (${errorText(error).slice(0, 160)})`)
                trials.push({ ...base, crew: proposal.ir, status: 'rejected', rejectionReason: errorText(error), devResults: [], summary: null })
                continue
            }
            const candidate = { ...base, ...compiled }
            const devResults = await runScenarios({ ...common, trial: candidate, scenarios: dev })
            const summary = summarizeStudioResults(devResults)
            const parentSummary = parent.summary || {}
            const improved =
                summary.passRate > Number(parentSummary.passRate || 0) ||
                (summary.passRate >= Number(parentSummary.passRate || 0) &&
                    summary.averageCost <= Number(parentSummary.averageCost || Infinity))
            trials.push({ ...candidate, devResults, summary, status: improved ? 'accepted' : 'kept_for_comparison' })
            log(`  ${id}: pass ${summary.passRate.toFixed(2)} quality ${summary.quality.toFixed(2)} tokens ${Math.round(summary.averageTokens)}`)
        }
    }

    const baselineQuality = Number(trials[0].summary?.quality || 0)
    const qualityFloor = Math.max(0, baselineQuality - settings.allowedQualityLoss)
    let paretoTrialIds = getParetoTrialIds(trials, qualityFloor, settings.minimumPassRate, settings.maximumFailureRate)
    if (settings.runHeldOutSuite && test.length) {
        const heldOut = [...new Set([trials[0].id, ...paretoTrialIds])].map((id) => trials.find((trial) => trial.id === id)).filter(Boolean)
        for (const trial of heldOut) {
            if (trial.testResults?.length) continue
            log(`held-out: ${trial.id}`)
            const testResults = await runScenarios({ ...common, trial, scenarios: test })
            Object.assign(trial, { testResults, testSummary: summarizeStudioResults(testResults) })
        }
    }
    const selected = selectNextTrial(trials, baselineQuality, settings.allowedQualityLoss, settings.minimumPassRate, settings.maximumFailureRate)

    return {
        settings,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        paretoTrialIds,
        selectedTrialId: selected?.id || null,
        rounds,
        trials: trials.map(({ flowData: _flowData, ...trial }) => trial)
    }
}
