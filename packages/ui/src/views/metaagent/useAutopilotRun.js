import { useCallback, useSyncExternalStore } from 'react'

import chatflowsApi from '@/api/chatflows'
import chatmessageApi from '@/api/chatmessage'
import predictionApi from '@/api/prediction'

import {
    DEFAULT_ACCEPTANCE_SCORE_THRESHOLD,
    buildRunEvidence,
    extractStudioOutput,
    extractStudioToolCalls,
    extractStudioTrace,
    getParetoTrialIds,
    selectNextTrial,
    selectPreflightScenarios,
    selectSearchParent,
    splitScenarios,
    summarizePrediction,
    summarizeStudioResults,
    validateStudioOutput
} from './studioUtils'

/**
 * A crew execution is several chained model calls, so it is legitimately slow —
 * but never unbounded. Without this a hung execution leaves the run spinning
 * with no error and no way out but a page reload.
 */
const EXECUTION_TIMEOUT = 8 * 60 * 1000

const SESSION_KEY = 'workflowAutopilotSessionV2'
const SETTINGS_KEY = 'workflowAutopilotSettingsV2'
const STOP_KEY = 'workflowAutopilotStopRequestedV2'
const GOAL_KEY = 'workflowAutopilotGoal'
/** Written by StudioModelPicker; read here so a remount restores the choice at once. */
const MODEL_KEY = 'workflowAutopilotModel'
const CHEAP_MODEL_KEY = 'workflowAutopilotCheapModel'

export const INITIAL_SETTINGS = {
    strategy: 'evidence_guided',
    searchRounds: 2,
    candidatesPerRound: 3,
    acceptanceScoreThreshold: DEFAULT_ACCEPTANCE_SCORE_THRESHOLD,
    minimumPassRate: 0.6,
    maximumFailureRate: 0.1,
    allowedQualityLoss: 0.1,
    concurrency: 2,
    seed: 1,
    runHeldOutSuite: true
}

const loadStored = (key, fallback) => {
    try {
        const stored = JSON.parse(localStorage.getItem(key) || 'null')
        return stored && typeof stored === 'object' ? { ...fallback, ...stored } : fallback
    } catch (_) {
        return fallback
    }
}

/** Model replies are the bulk of the payload and are never needed after a run. */
const compactTrials = (trials = []) =>
    trials.map((trial) => ({
        ...trial,
        devResults: (trial.devResults || []).map(({ output: _output, ...result }) => result),
        testResults: (trial.testResults || []).map(({ output: _output, ...result }) => result)
    }))

const compactSession = (session = {}) => {
    const compact = JSON.parse(JSON.stringify(session || {}))
    compact.trials = compactTrials(compact.trials)
    if (compact.archivedRun?.trials) {
        // The archive doubles the payload, and localStorage is a few megabytes.
        // Its graphs are the first thing worth dropping: they only feed the
        // crew diagram, which the archive view simply omits when it is absent.
        compact.archivedRun.trials = compactTrials(compact.archivedRun.trials).map(({ flowData: _flowData, ...trial }) => trial)
    }
    return compact
}

/**
 * Applying a recommendation edits the acceptance suite, so every score measured
 * against the old one stops being quotable. Deleting the run outright was too
 * blunt: it also locked the Results step and threw away the only "before" the
 * next run could be compared against. Keep a snapshot, labelled for what it is.
 */
const archiveRun = (session) =>
    (session.trials || []).some((trial) => trial.summary)
        ? {
              trials: session.trials,
              diagnosis: session.diagnosis || '',
              paretoTrialIds: session.paretoTrialIds || [],
              selectedTrialId: session.selectedTrialId || null,
              completedAt: session.completedAt || '',
              archivedAt: new Date().toISOString(),
              scenarioCount: (session.design?.scenarios || []).length
          }
        : session.archivedRun || null

const errorMessage = (error) => {
    // Axios reports a timeout as "timeout of 480000ms exceeded", which tells a
    // user nothing about what to do next.
    if (error?.code === 'ECONNABORTED') {
        return `The request timed out after ${Math.round(
            Number(error?.config?.timeout || 0) / 1000
        )}s. The model or the workflow stalled; nothing is still running.`
    }
    return error?.response?.data?.message || error?.message || String(error)
}

/**
 * Autopilot state lives in a module-level store the hook subscribes to, not in
 * component state.
 *
 * A run is a long chain of awaited HTTP calls, and this panel unmounts the
 * moment the user opens another page. Held in `useState`, the progress, the
 * status line, the stop flag and the list of in-flight executions went with it,
 * while the run itself carried on spending tokens on the server: coming back
 * showed an idle panel that could neither report on that run nor stop it.
 */
const store = {
    state: {
        goal: localStorage.getItem(GOAL_KEY) || '',
        settings: loadStored(SETTINGS_KEY, INITIAL_SETTINGS),
        session: loadStored(SESSION_KEY, {}),
        // The picker used to restore these itself, but only after the chat-model
        // list had loaded — so a remount showed an unconfigured model, and the
        // page complained that the model needed configuring before generating.
        selectedChatModel: loadStored(MODEL_KEY, {}),
        cheapChatModel: loadStored(CHEAP_MODEL_KEY, {}),
        busy: false,
        phase: '',
        status: '',
        progress: { current: 0, total: 0 },
        error: ''
    },
    listeners: new Set()
}

const getState = () => store.state

const subscribe = (listener) => {
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
}

const setState = (patch) => {
    store.state = { ...store.state, ...patch }
    for (const listener of [...store.listeners]) listener()
}

const setBusy = (busy) => setState({ busy })
const setPhase = (phase) => setState({ phase })
const setStatus = (status) => setState({ status })
const setProgress = (progress) => setState({ progress })
const setError = (error) => setState({ error })

const setGoal = (goal) => {
    setState({ goal })
    if (goal) localStorage.setItem(GOAL_KEY, goal)
}

const setSelectedChatModel = (selectedChatModel) => setState({ selectedChatModel: selectedChatModel || {} })
const setCheapChatModel = (cheapChatModel) => setState({ cheapChatModel: cheapChatModel || {} })

const patchSettings = (patch) => {
    const settings = { ...store.state.settings, ...patch }
    setState({ settings })
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

const currentSession = () => store.state.session

const persistSession = (next) => {
    setState({ session: next })
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(compactSession(next)))
    } catch (_) {
        // Session persistence is best effort; the run itself must continue.
    }
}

/** Outside React for the same reason: navigating away does not stop the run. */
let stopRequested = false
/** runId -> flowId for every execution currently running on the server. */
const inFlight = new Map()

const shouldStop = () => stopRequested || localStorage.getItem(STOP_KEY) === '1'

const trackRun = (flowId, runId) => inFlight.set(runId, flowId)
const untrackRun = (runId) => inFlight.delete(runId)

export const useAutopilotRun = () => {
    const { goal, settings, session, selectedChatModel, cheapChatModel, busy, phase, status, progress, error } = useSyncExternalStore(
        subscribe,
        getState
    )

    /**
     * Abandoning the HTTP request is not enough: the server keeps executing the
     * crew, so a multi-agent trial carries on spending tokens long after the UI
     * stopped waiting for it. Abort every in-flight execution explicitly.
     */
    const requestStop = useCallback(() => {
        stopRequested = true
        localStorage.setItem(STOP_KEY, '1')
        const pending = [...inFlight.entries()]
        inFlight.clear()
        for (const [runId, flowId] of pending) {
            chatmessageApi.abortMessage(flowId, runId).catch(() => undefined)
        }
        setStatus(
            pending.length
                ? `Stopping — aborted ${pending.length} running execution(s) on the server.`
                : 'Stopping after the current step finishes…'
        )
    }, [])

    const clearSession = useCallback(() => {
        persistSession({})
        setStatus('')
        setError('')
        setProgress({ current: 0, total: 0 })
    }, [])

    /* -------------------------------------------------------------- *
     * Design
     * -------------------------------------------------------------- */

    const designWorkflow = useCallback(
        async (selectedChatModel) => {
            if (!goal.trim()) return
            setBusy(true)
            setPhase('design')
            setError('')
            setStatus('Designing the product contract, the simulated environment and the crew…')
            try {
                const { data } = await chatflowsApi.designStudioWorkflow({ goal: goal.trim(), selectedChatModel })
                persistSession({
                    id: `autopilot-${new Date().toISOString()}`,
                    goal: goal.trim(),
                    design: data.design,
                    crewValidation: data.validation,
                    crewSummary: data.crewSummary,
                    contractStatus: 'draft',
                    createdAt: new Date().toISOString(),
                    trials: [],
                    recommendations: []
                })
                setStatus('Draft contract, simulated tools and acceptance suite are ready. Review them, then compile the baseline.')
            } catch (requestError) {
                setError(errorMessage(requestError))
            } finally {
                setBusy(false)
                setPhase('')
            }
        },
        [goal]
    )

    const updateDesign = useCallback((updater) => {
        const current = currentSession()
        if (!current.design) return
        const design = updater(JSON.parse(JSON.stringify(current.design)))
        persistSession({ ...current, design, contractStatus: 'draft' })
    }, [])

    const regenerateScenarios = useCallback(async (selectedChatModel) => {
        const current = currentSession()
        if (!current.design) return
        setBusy(true)
        setPhase('scenarios')
        setError('')
        setStatus('Regenerating the simulated environment and the acceptance suite…')
        try {
            const { data } = await chatflowsApi.regenerateStudioScenarios({
                goal: current.goal,
                design: current.design,
                selectedChatModel
            })
            persistSession({
                ...current,
                design: { ...current.design, tools: data.tools, scenarios: data.scenarios },
                contractStatus: 'draft'
            })
            const emptyTools = (data.tools || []).filter((tool) => !tool.fixtures?.length)
            setStatus(
                [
                    `Regenerated ${data.scenarios.length} acceptance cases across ${data.tools.length} simulated tools.`,
                    // The server reports these; dropping them is how an empty
                    // world reached a compile unnoticed.
                    ...(data.warnings || []),
                    emptyTools.length ? `Fix the ${emptyTools.length} tool(s) without fixtures before compiling.` : ''
                ]
                    .filter(Boolean)
                    .join(' ')
            )
        } catch (requestError) {
            setError(errorMessage(requestError))
        } finally {
            setBusy(false)
            setPhase('')
        }
    }, [])

    const regenerateCrew = useCallback(async (selectedChatModel) => {
        const current = currentSession()
        if (!current.design) return
        const guidance = current.crewGuidance || []
        setBusy(true)
        setPhase('crew')
        setError('')
        setStatus(
            guidance.length
                ? `Redesigning the crew against ${guidance.length} accepted diagnosis/diagnoses…`
                : 'Redesigning the crew from the confirmed contract…'
        )
        try {
            const { data } = await chatflowsApi.regenerateStudioCrew({
                goal: current.goal,
                design: current.design,
                guidance,
                selectedChatModel
            })
            persistSession({
                ...current,
                design: { ...current.design, crew: data.crew },
                crewValidation: data.validation,
                crewSummary: data.crewSummary,
                contractStatus: 'draft',
                // The guidance is kept so a second redesign still sees it, so the
                // flag — not the list — is what says it has reached a crew.
                crewGuidanceApplied: true
            })
            setStatus(`New crew: ${data.crewSummary.agentCount} agents, ${data.crewSummary.taskCount} tasks.`)
        } catch (requestError) {
            setError(errorMessage(requestError))
        } finally {
            setBusy(false)
            setPhase('')
        }
    }, [])

    /* -------------------------------------------------------------- *
     * Recommendations
     * -------------------------------------------------------------- */

    const setRecommendationStatus = useCallback((id, status) => {
        const current = currentSession()
        persistSession({
            ...current,
            recommendations: (current.recommendations || []).map((item) => (item.id === id ? { ...item, status } : item))
        })
    }, [])

    /**
     * Turns accepted diagnoses into actual changes.
     *
     * Coverage and contract findings edit the suite and the criteria directly.
     * Workflow findings become guidance for the next crew redesign, because the
     * diagnosis names a defect in prose rather than a typed operator. Either way
     * the measured results are discarded: the moment the suite or the contract
     * moves, every earlier number was scored against a different yardstick.
     */
    const applyRecommendations = useCallback(() => {
        const current = currentSession()
        const accepted = (current.recommendations || []).filter((item) => item.status === 'accepted')
        if (!accepted.length || !current.design) return { scenariosAdded: 0, criteriaAdded: 0, guidance: 0 }

        const design = JSON.parse(JSON.stringify(current.design))
        const existingScenarioIds = new Set(design.scenarios.map((scenario) => scenario.id))
        const newScenarios = accepted
            .flatMap((item) => item.suggestedScenarios || [])
            .filter((scenario) => scenario && !existingScenarioIds.has(scenario.id))
        design.scenarios = [...design.scenarios, ...newScenarios]

        const existingCriteria = new Set(design.successCriteria)
        const newCriteria = accepted.flatMap((item) => item.suggestedCriteria || []).filter((item) => item && !existingCriteria.has(item))
        design.successCriteria = [...design.successCriteria, ...newCriteria]

        const guidance = accepted
            .filter((item) => ['workflow_issue', 'environment_gap'].includes(item.type))
            .map((item) => `${item.title}: ${item.proposedChange}`)

        persistSession({
            ...current,
            design,
            crewGuidance: guidance,
            crewGuidanceApplied: false,
            contractStatus: 'draft',
            archivedRun: archiveRun(current),
            trials: [],
            paretoTrialIds: [],
            selectedTrialId: null,
            diagnosis: '',
            completedAt: '',
            recommendations: (current.recommendations || []).map((item) =>
                item.status === 'accepted' ? { ...item, status: 'applied' } : item
            )
        })
        setStatus(
            `Applied ${accepted.length} recommendation(s): +${newScenarios.length} case(s), +${newCriteria.length} criterion/criteria, ` +
                `${guidance.length} crew guidance note(s). The suite changed, so the baseline must be re-measured — the previous run is ` +
                `kept on the Results step for comparison.`
        )
        return { scenariosAdded: newScenarios.length, criteriaAdded: newCriteria.length, guidance: guidance.length }
    }, [])

    /* -------------------------------------------------------------- *
     * Compilation
     * -------------------------------------------------------------- */

    const compileTrial = useCallback(async (currentSession, crew, name, selectedChatModel, cheapChatModel) => {
        const { data } = await chatflowsApi.compileStudioWorkflow({
            goal: currentSession.goal,
            design: currentSession.design,
            crew,
            selectedChatModel,
            cheapChatModel
        })
        const created = await chatflowsApi.createNewChatflow({
            name,
            deployed: false,
            isPublic: false,
            flowData: JSON.stringify(data.flowData),
            type: 'AGENTFLOW'
        })
        return {
            flowId: created.data.id,
            flowData: data.flowData,
            crew: data.crew,
            crewSummary: data.crewSummary,
            toolProvisioning: data.toolProvisioning,
            warnings: data.validation?.warnings || []
        }
    }, [])

    const compileBaseline = useCallback(
        async (selectedChatModel, cheapChatModel) => {
            const current = currentSession()
            if (!current.design) return
            setBusy(true)
            setPhase('compile')
            setError('')
            setStatus('Provisioning the simulated tools and compiling the baseline crew…')
            try {
                const compiled = await compileTrial(
                    current,
                    current.design.crew,
                    `${current.design.workflowName} [Baseline]`,
                    selectedChatModel,
                    cheapChatModel
                )
                const baseline = {
                    id: 'baseline',
                    name: `${current.design.workflowName} [Baseline]`,
                    parentId: null,
                    round: 0,
                    operator: null,
                    operatorDescription: 'Generated crew, unmodified',
                    rationale: 'The crew the designer produced from the confirmed contract.',
                    ...compiled,
                    devResults: [],
                    testResults: [],
                    summary: null,
                    testSummary: null
                }
                persistSession({
                    ...current,
                    contractStatus: 'confirmed',
                    trials: [baseline],
                    paretoTrialIds: [],
                    selectedTrialId: null,
                    diagnosis: '',
                    recommendations: []
                })
                const provisioned = compiled.toolProvisioning
                setStatus(
                    `Baseline compiled: ${compiled.crewSummary.agentCount} agents, ${compiled.crewSummary.taskCount} tasks, ` +
                        `${provisioned.created.length + provisioned.reused.length} simulated tools bound. Run the acceptance suite next.`
                )
            } catch (requestError) {
                setError(errorMessage(requestError))
            } finally {
                setBusy(false)
                setPhase('')
            }
        },
        [compileTrial]
    )

    /* -------------------------------------------------------------- *
     * Execution
     * -------------------------------------------------------------- */

    const runScenarios = useCallback(
        async (trial, scenarios, selectedChatModel, onProgress) => {
            const current = currentSession()
            const design = current.design
            const results = new Array(scenarios.length)
            let cursor = 0

            const worker = async () => {
                while (!shouldStop()) {
                    const index = cursor
                    cursor += 1
                    if (index >= scenarios.length) return
                    const scenario = scenarios[index]
                    const startedAt = Date.now()
                    setStatus(`${trial.name} · ${scenario.title}`)
                    const runId = `${current.id || 'autopilot'}-${trial.id}-${scenario.id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
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
                            goal: current.goal,
                            scenario,
                            output,
                            toolCalls,
                            successCriteria: design.successCriteria,
                            constraints: design.constraints,
                            acceptanceScoreThreshold: Number(settings.acceptanceScoreThreshold),
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
            const concurrency = modelNodes >= 6 ? 1 : Math.max(1, Math.min(Number(settings.concurrency), scenarios.length))
            await Promise.all(Array.from({ length: concurrency }, () => worker()))
            return results.filter(Boolean)
        },
        [settings.acceptanceScoreThreshold, settings.concurrency]
    )

    const preflight = useCallback(async (trial, scenarios) => {
        const smoke = selectPreflightScenarios(scenarios)
        if (!smoke.length) return
        setStatus(`${trial.name} · ${smoke.length} executable-readiness checks…`)
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /* -------------------------------------------------------------- *
     * The search loop
     * -------------------------------------------------------------- */

    const runAutopilot = useCallback(
        async (selectedChatModel, cheapChatModel) => {
            const current = currentSession()
            if (!current.design || !current.trials?.length) return
            const { dev, test } = splitScenarios(current.design.scenarios)
            if (!dev.length) {
                setError('The acceptance suite has no development cases. Mark at least one case as "dev".')
                return
            }

            setBusy(true)
            setPhase('run')
            setError('')
            stopRequested = false
            localStorage.removeItem(STOP_KEY)

            const rounds = Math.max(0, Number(settings.searchRounds) || 0)
            const perRound = Math.max(1, Number(settings.candidatesPerRound) || 1)
            let completed = 0
            let total = dev.length * (1 + rounds * perRound)
            setProgress({ current: 0, total })
            const tick = () => {
                completed += 1
                setProgress({ current: completed, total })
            }

            let trials = []
            try {
                const baseline = current.trials[0]
                setStatus('Running the development suite on the baseline crew…')
                const baselineResults = await runScenarios(baseline, dev, selectedChatModel, tick)
                trials = [{ ...baseline, devResults: baselineResults, summary: summarizeStudioResults(baselineResults) }]
                persistSession({ ...currentSession(), trials })

                for (let round = 1; round <= rounds && !shouldStop(); round += 1) {
                    const parent = selectSearchParent(trials)
                    const evidence = buildRunEvidence(
                        parent.devResults,
                        parent.summary,
                        current.design,
                        parent.crew,
                        trials.map((trial) => trial.operatorSignature)
                    )
                    setStatus(`Round ${round}: proposing candidate crews from ${parent.name}…`)

                    let proposals = []
                    try {
                        const { data } = await chatflowsApi.proposeStudioCandidates({
                            goal: current.goal,
                            design: current.design,
                            crew: parent.crew,
                            evidence,
                            strategy: settings.strategy,
                            count: perRound,
                            seed: Number(settings.seed) + round,
                            selectedChatModel
                        })
                        proposals = data.candidates || []
                        if (!proposals.length && data.note) setStatus(`Round ${round}: ${data.note}`)
                    } catch (proposalError) {
                        setStatus(`Round ${round}: no candidate could be proposed (${errorMessage(proposalError)}).`)
                    }
                    if (!proposals.length) {
                        total -= dev.length * perRound
                        setProgress({ current: completed, total })
                        continue
                    }
                    if (proposals.length < perRound) {
                        total -= dev.length * (perRound - proposals.length)
                        setProgress({ current: completed, total })
                    }

                    for (let index = 0; index < proposals.length && !shouldStop(); index += 1) {
                        const proposal = proposals[index]
                        const name = `${current.design.workflowName} [R${round}C${index + 1} · ${proposal.operator.type}]`
                        const candidateId = `r${round}-c${index + 1}-${proposal.operator.type}`
                        let compiled
                        try {
                            if (shouldStop()) break
                            setStatus(`Round ${round}: compiling ${proposal.description}…`)
                            compiled = await compileTrial(current, proposal.ir, name, selectedChatModel, cheapChatModel)
                            await preflight({ ...compiled, id: candidateId, name }, dev)
                        } catch (compileError) {
                            trials = [
                                ...trials,
                                {
                                    id: candidateId,
                                    name,
                                    parentId: parent.id,
                                    round,
                                    operator: proposal.operator,
                                    operatorSignature: proposal.signature,
                                    operatorDescription: proposal.description,
                                    rationale: proposal.rationale,
                                    crew: proposal.ir,
                                    crewSummary: proposal.crewSummary,
                                    status: 'rejected',
                                    rejectionReason: errorMessage(compileError),
                                    devResults: [],
                                    summary: null
                                }
                            ]
                            completed += dev.length
                            setProgress({ current: completed, total })
                            persistSession({ ...currentSession(), trials })
                            continue
                        }

                        const candidate = {
                            id: candidateId,
                            name,
                            parentId: parent.id,
                            round,
                            operator: proposal.operator,
                            operatorSignature: proposal.signature,
                            operatorDescription: proposal.description,
                            rationale: proposal.rationale,
                            ...compiled,
                            devResults: [],
                            testResults: [],
                            summary: null,
                            testSummary: null
                        }
                        const results = await runScenarios(candidate, dev, selectedChatModel, tick)
                        const summary = summarizeStudioResults(results)
                        const parentSummary = parent.summary || {}
                        const improved =
                            summary.passRate > Number(parentSummary.passRate || 0) ||
                            (summary.passRate >= Number(parentSummary.passRate || 0) &&
                                summary.averageCost <= Number(parentSummary.averageCost || Infinity))
                        trials = [
                            ...trials,
                            {
                                ...candidate,
                                devResults: results,
                                summary,
                                status: improved ? 'accepted' : 'kept_for_comparison'
                            }
                        ]
                        persistSession({ ...currentSession(), trials })
                    }
                }

                // Held-out evaluation. Only the frontier is measured on test cases,
                // and only once, so the reported number is not something the search
                // was allowed to optimize against.
                const qualityFloor = Math.max(0, Number(trials[0].summary?.quality || 0) - Number(settings.allowedQualityLoss))
                let paretoTrialIds = getParetoTrialIds(
                    trials,
                    qualityFloor,
                    Number(settings.minimumPassRate),
                    Number(settings.maximumFailureRate)
                )
                if (settings.runHeldOutSuite && test.length && !shouldStop()) {
                    const heldOut = [...new Set(['baseline', ...paretoTrialIds])]
                        .map((id) => trials.find((trial) => trial.id === id))
                        .filter((trial) => trial && trial.flowId)
                    total += test.length * heldOut.length
                    setProgress({ current: completed, total })
                    for (const trial of heldOut) {
                        if (shouldStop()) break
                        setStatus(`Held-out evaluation: ${trial.name}…`)
                        const testResults = await runScenarios(trial, test, selectedChatModel, tick)
                        // A stop leaves the suite unfinished. Scoring what did run
                        // would publish "0% held-out" for a crew that was never
                        // measured — the worst kind of wrong number.
                        if (testResults.length < test.length) break
                        trials = trials.map((candidate) =>
                            candidate.id === trial.id
                                ? { ...candidate, testResults, testSummary: summarizeStudioResults(testResults) }
                                : candidate
                        )
                        persistSession({ ...currentSession(), trials })
                    }
                    paretoTrialIds = getParetoTrialIds(
                        trials,
                        qualityFloor,
                        Number(settings.minimumPassRate),
                        Number(settings.maximumFailureRate)
                    )
                }

                const selected = selectNextTrial(
                    trials,
                    Number(trials[0].summary?.quality || 0),
                    Number(settings.allowedQualityLoss),
                    Number(settings.minimumPassRate),
                    Number(settings.maximumFailureRate)
                )

                // Diagnosis is another long model call. A stopped run must not
                // start one, and its evidence would be incomplete anyway.
                let diagnosis = { summary: 'Diagnosis was skipped because the run was stopped.', recommendations: [] }
                if (!shouldStop()) {
                    setStatus('Diagnosing failures, coverage gaps and environment gaps…')
                    try {
                        const { data } = await chatflowsApi.diagnoseStudioRun({
                            goal: current.goal,
                            design: current.design,
                            trials: trials.map((trial) => ({
                                id: trial.id,
                                operator: trial.operator,
                                summary: trial.summary,
                                testSummary: trial.testSummary,
                                results: (trial.devResults || []).map((result) => ({
                                    scenarioId: result.scenarioId,
                                    error: result.error,
                                    evaluation: result.evaluation,
                                    toolCalls: (result.toolCalls || []).map((call) => ({ tool: call.tool, input: call.toolInput })),
                                    trace: result.trace
                                }))
                            })),
                            selectedChatModel
                        })
                        diagnosis = data
                    } catch (diagnosisError) {
                        diagnosis = { summary: `Diagnosis was unavailable: ${errorMessage(diagnosisError)}`, recommendations: [] }
                    }
                }

                persistSession({
                    ...currentSession(),
                    trials,
                    paretoTrialIds,
                    selectedTrialId: selected?.id || null,
                    diagnosis: diagnosis.summary,
                    recommendations: (diagnosis.recommendations || []).map((item) => ({ ...item, status: 'pending' })),
                    completedAt: new Date().toISOString()
                })
                setStatus(
                    shouldStop()
                        ? 'Stopped after the active calls finished.'
                        : selected
                        ? `Completed. Recommended crew: ${selected.name}`
                        : 'Completed. No crew met the configured feasibility gate.'
                )
            } catch (runError) {
                setError(errorMessage(runError))
                if (trials.length) persistSession({ ...currentSession(), trials })
            } finally {
                setBusy(false)
                setPhase('')
                inFlight.clear()
                localStorage.removeItem(STOP_KEY)
            }
        },
        [compileTrial, preflight, runScenarios, settings]
    )

    return {
        goal,
        setGoal,
        settings,
        patchSettings,
        session,
        persistSession,
        updateDesign,
        selectedChatModel,
        setSelectedChatModel,
        cheapChatModel,
        setCheapChatModel,
        busy,
        phase,
        status,
        progress,
        error,
        setError,
        designWorkflow,
        regenerateScenarios,
        regenerateCrew,
        compileBaseline,
        runAutopilot,
        setRecommendationStatus,
        applyRecommendations,
        requestStop,
        clearSession
    }
}

export default useAutopilotRun
