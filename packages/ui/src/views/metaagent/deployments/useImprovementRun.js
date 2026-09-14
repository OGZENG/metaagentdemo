import { useCallback, useSyncExternalStore } from 'react'

import chatflowsApi from '@/api/chatflows'
import chatmessageApi from '@/api/chatmessage'
import deploymentsApi from '@/api/autopilotDeployments'

import { errorMessage, preflightFlow, runScenariosOnFlow } from '../studioRunner'
import {
    DEFAULT_ACCEPTANCE_SCORE_THRESHOLD,
    buildImprovementSuite,
    buildRunEvidence,
    summarizeResultSubset,
    summarizeStudioResults
} from '../studioUtils'

export const IMPROVEMENT_DEFAULTS = {
    candidates: 2,
    runHeldOut: true,
    concurrency: 2,
    acceptanceScoreThreshold: DEFAULT_ACCEPTANCE_SCORE_THRESHOLD
}

const IDLE = { busy: false, status: '', error: '', progress: { current: 0, total: 0 } }

/**
 * Improvement runs outlive the panel that started them, for the same reason the
 * experiment does: a run is minutes of model calls, and leaving the page must
 * neither lose its progress nor the ability to stop what it started.
 */
const store = { states: {}, listeners: new Set() }

const subscribe = (listener) => {
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
}

const patchState = (deploymentId, patch) => {
    store.states = { ...store.states, [deploymentId]: { ...(store.states[deploymentId] || IDLE), ...patch } }
    for (const listener of [...store.listeners]) listener()
}

const stopRequested = new Set()
/** deploymentId -> (runId -> flowId) for every execution running on the server */
const inFlight = new Map()

const flightsOf = (deploymentId) => {
    if (!inFlight.has(deploymentId)) inFlight.set(deploymentId, new Map())
    return inFlight.get(deploymentId)
}

/**
 * One gated improvement round on a deployed crew:
 *
 * 1. compile the live version into a throwaway flow and run the regression
 *    suite — the original development cases plus accepted online cases;
 * 2. turn the observed failures and accepted rules into search evidence;
 * 3. let the evidence-guided search propose operator-mutated candidates and
 *    measure each on the same suite (held-out cases only for contenders);
 * 4. record the run. The server applies the publish gate; nothing touches the
 *    live flow until a person publishes an eligible candidate.
 *
 * Measuring happens on copies so the live flow's chat history and Token
 * Analytics only ever contain real usage.
 */
export const useImprovementRun = (deploymentId) => {
    const state = useSyncExternalStore(subscribe, () => store.states[deploymentId] || IDLE)

    const stop = useCallback(() => {
        stopRequested.add(deploymentId)
        const flights = flightsOf(deploymentId)
        const pending = [...flights.entries()]
        flights.clear()
        for (const [runId, flowId] of pending) {
            chatmessageApi.abortMessage(flowId, runId).catch(() => undefined)
        }
        patchState(deploymentId, {
            status: pending.length ? `Stopping — aborted ${pending.length} running execution(s).` : 'Stopping after the current step…'
        })
    }, [deploymentId])

    const run = useCallback(
        async (deployment, options = {}) => {
            const settings = { ...IMPROVEMENT_DEFAULTS, ...options }
            const suite = buildImprovementSuite(deployment.design, deployment.onlineCases)
            if (!suite.caseIds.length) {
                patchState(deploymentId, { error: 'Accept at least one collected case before running an improvement.' })
                return null
            }
            const version = deployment.versions.find((item) => item.version === deployment.currentVersion)
            if (!version) {
                patchState(deploymentId, { error: 'The live version could not be found in this deployment.' })
                return null
            }

            stopRequested.delete(deploymentId)
            const shouldStop = () => stopRequested.has(deploymentId)
            const flights = flightsOf(deploymentId)
            const trackRun = (flowId, runId) => flights.set(runId, flowId)
            const untrackRun = (runId) => flights.delete(runId)
            const setStatus = (status) => patchState(deploymentId, { status })

            const wanted = Math.min(4, Math.max(1, Number(settings.candidates) || 1))
            const runId = `improve-${Date.now().toString(36)}`
            const startedAt = new Date().toISOString()
            const onlineIds = new Set(suite.onlineIds)
            // Proposals see the suite the candidates are judged on.
            const suiteDesign = { ...deployment.design, scenarios: [...suite.dev, ...suite.test] }
            const selectedChatModel = deployment.selectedChatModel
            const temporaryFlows = []

            let completed = 0
            let total = suite.dev.length * (1 + wanted)
            const setProgress = () => patchState(deploymentId, { progress: { current: completed, total } })
            const tick = () => {
                completed += 1
                setProgress()
            }

            patchState(deploymentId, {
                busy: true,
                error: '',
                status: 'Compiling the live version as the regression baseline…',
                progress: { current: 0, total }
            })

            const compile = async (crew, label) => {
                const { data: compiled } = await chatflowsApi.compileStudioWorkflow({
                    goal: deployment.goal,
                    design: deployment.design,
                    crew,
                    selectedChatModel,
                    cheapChatModel: deployment.cheapChatModel || undefined,
                    toolBindings: deployment.toolBindings
                })
                const created = await chatflowsApi.createNewChatflow({
                    name: `${deployment.name} [improve · ${label}]`,
                    deployed: false,
                    isPublic: false,
                    flowData: JSON.stringify(compiled.flowData),
                    type: 'AGENTFLOW'
                })
                temporaryFlows.push(created.data.id)
                return { flowId: created.data.id, flowData: compiled.flowData, crew: compiled.crew }
            }

            const measure = (trial, scenarios) =>
                runScenariosOnFlow({
                    trial,
                    scenarios,
                    goal: deployment.goal,
                    design: suiteDesign,
                    selectedChatModel,
                    acceptanceScoreThreshold: settings.acceptanceScoreThreshold,
                    concurrency: settings.concurrency,
                    runPrefix: runId,
                    shouldStop,
                    onStatus: setStatus,
                    onProgress: tick,
                    trackRun,
                    untrackRun
                })

            const scored = (results) => ({
                summary: summarizeStudioResults(results),
                onlineSummary: summarizeResultSubset(results, onlineIds)
            })

            const stopped = () => {
                setStatus('Stopped. Nothing was recorded: a partially measured run cannot be compared fairly.')
                return null
            }

            try {
                const live = await compile(version.crew, `v${version.version}`)
                const liveTrial = { ...live, id: 'current', name: `Version ${version.version} (live)` }
                const liveResults = await measure(liveTrial, suite.dev)
                if (shouldStop()) return stopped()

                const current = {
                    id: 'current',
                    operatorType: '',
                    operatorDescription: `Version ${version.version} (live)`,
                    rationale: '',
                    crew: version.crew,
                    ...scored(liveResults),
                    testSummary: null,
                    error: ''
                }

                const evidence = {
                    ...buildRunEvidence(liveResults, current.summary, deployment.design, version.crew, []),
                    userInstructions: suite.instructions
                }

                setStatus('Proposing candidate crews from the collected evidence…')
                let proposals = []
                let note = ''
                try {
                    const { data } = await chatflowsApi.proposeStudioCandidates({
                        goal: deployment.goal,
                        design: suiteDesign,
                        crew: version.crew,
                        evidence,
                        strategy: 'evidence_guided',
                        count: wanted,
                        seed: Date.now() % 997,
                        selectedChatModel
                    })
                    proposals = data.candidates || []
                    note = data.note || ''
                } catch (proposalError) {
                    note = `No candidate could be proposed: ${errorMessage(proposalError)}`
                }
                total = suite.dev.length * (1 + proposals.length)
                setProgress()

                const candidates = []
                for (let index = 0; index < proposals.length && !shouldStop(); index += 1) {
                    const proposal = proposals[index]
                    const id = `c${index + 1}-${proposal.operator.type}`
                    const base = {
                        id,
                        operatorType: proposal.operator.type,
                        operatorDescription: proposal.description,
                        rationale: proposal.rationale || '',
                        crew: proposal.ir
                    }
                    const before = completed
                    try {
                        setStatus(`Compiling ${proposal.description}…`)
                        const compiled = await compile(proposal.ir, id)
                        const trial = { ...compiled, id, name: proposal.description }
                        await preflightFlow({ trial, scenarios: suite.dev, shouldStop, onStatus: setStatus, trackRun, untrackRun })
                        const results = await measure(trial, suite.dev)
                        candidates.push({ ...base, crew: compiled.crew, trial, ...scored(results), testSummary: null, error: '' })
                    } catch (candidateError) {
                        completed = before + suite.dev.length
                        setProgress()
                        candidates.push({
                            ...base,
                            summary: null,
                            onlineSummary: null,
                            testSummary: null,
                            error: errorMessage(candidateError)
                        })
                    }
                }
                if (shouldStop()) return stopped()

                // Held-out cases are only spent on candidates that could still pass the gate.
                const contenders = candidates.filter(
                    (candidate) =>
                        candidate.summary &&
                        candidate.summary.passRate >= current.summary.passRate &&
                        candidate.summary.failed <= current.summary.failed
                )
                if (settings.runHeldOut && suite.test.length && contenders.length) {
                    total += suite.test.length * (1 + contenders.length)
                    setProgress()
                    setStatus('Held-out evaluation of the live version and the contenders…')
                    current.testSummary = summarizeStudioResults(await measure(liveTrial, suite.test))
                    for (const contender of contenders) {
                        if (shouldStop()) break
                        contender.testSummary = summarizeStudioResults(await measure(contender.trial, suite.test))
                    }
                    if (shouldStop()) return stopped()
                }

                const record = {
                    id: runId,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    status: 'completed',
                    baseVersion: version.version,
                    caseIds: suite.caseIds,
                    instructions: suite.instructions,
                    current,
                    candidates: candidates.map(({ trial: _trial, ...candidate }) => candidate),
                    note: proposals.length ? '' : note || 'No candidate was proposed from this evidence.'
                }
                setStatus('Recording the run; the server applies the publish gate…')
                const { data } = await deploymentsApi.saveImprovementRun(deploymentId, record)
                const eligible = data.run.candidates.filter((candidate) => candidate.eligible).length
                setStatus(
                    eligible
                        ? `Run complete: ${eligible} candidate(s) passed the publish gate. Review and publish.`
                        : 'Run complete: no candidate passed the publish gate, so the live version stays as it is.'
                )
                return data
            } catch (runError) {
                patchState(deploymentId, { error: errorMessage(runError) })
                return null
            } finally {
                patchState(deploymentId, { busy: false })
                flights.clear()
                stopRequested.delete(deploymentId)
                // The copies exist only to be measured.
                await Promise.all(temporaryFlows.map((flowId) => chatflowsApi.deleteChatflow(flowId).catch(() => undefined)))
            }
        },
        [deploymentId]
    )

    return { ...state, run, stop }
}

export default useImprovementRun
