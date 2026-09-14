import { z } from 'zod/v3'
import { AcceptanceScenarioType, CrewIRType, StudioDesignType, type AcceptanceScenario, type StudioDesign } from './studioSchemas'

/**
 * Deployed crews and the online improvement loop.
 *
 * Everything here is pure: the persistence service reads a row, runs one of
 * these transitions and writes the result back. That keeps the rules that
 * decide what may reach the live flow — the publish gate above all — testable
 * without a database or a model.
 */

const num = z.preprocess((value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}, z.number())

const text = (max: number) =>
    z.preprocess((value) => {
        if (value === undefined || value === null) return ''
        const raw = typeof value === 'string' ? value : String(value)
        return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw
    }, z.string())

const textList = (maxItems: number, maxLength: number) =>
    z.preprocess(
        (value) => (Array.isArray(value) ? value : value ? [value] : []),
        z.array(text(maxLength)).transform((items) => items.filter((item) => item.trim()).slice(0, maxItems))
    )

export const MAX_VERSIONS = 20
export const MAX_ONLINE_CASES = 200
export const MAX_IMPROVEMENT_RUNS = 10

/** The same shape `summarizeStudioResults` produces in the studio. */
export const DeploymentMetricsType = z.object({
    total: num,
    completed: num,
    failed: num,
    quality: num,
    passRate: num,
    assertionRate: num,
    criticalViolations: num,
    averageTokens: num,
    averageCost: num,
    averageDurationMs: num,
    averageModelCalls: num
})

export type DeploymentMetrics = z.infer<typeof DeploymentMetricsType>

const optionalMetrics = z.preprocess((value) => (value && typeof value === 'object' ? value : null), DeploymentMetricsType.nullable())

export const DeploymentVersionType = z.object({
    version: z.number().int().min(1),
    crew: CrewIRType,
    /** development-suite metrics the crew was accepted at */
    metrics: optionalMetrics.default(null),
    heldOutMetrics: optionalMetrics.default(null),
    /** online cases only, measured when the version came out of an improvement run */
    onlineMetrics: optionalMetrics.default(null),
    note: text(2000).default(''),
    operatorDescriptions: textList(12, 600).default([]),
    incorporatedCaseIds: z.array(z.string()).default([]),
    createdAt: z.string()
})

export type DeploymentVersion = z.infer<typeof DeploymentVersionType>

export const ONLINE_CASE_SOURCES = ['user_feedback', 'model_review'] as const
export const ONLINE_CASE_STATUSES = ['pending', 'accepted', 'rejected', 'incorporated'] as const

export const OnlineCaseType = z.object({
    id: z.string().min(1).max(80),
    createdAt: z.string(),
    source: z.enum(ONLINE_CASE_SOURCES),
    status: z.enum(ONLINE_CASE_STATUSES).default('pending'),
    /** the crew version that produced the answer */
    version: z.number().int().min(1).default(1),
    sessionId: text(200).default(''),
    question: text(8000),
    answer: text(12000).default(''),
    feedback: text(4000).default(''),
    summary: text(2000).default(''),
    issues: textList(12, 1000).default([]),
    /** a concrete rule the crew should follow from now on, empty when none */
    instruction: text(1000).default(''),
    scenario: AcceptanceScenarioType.nullable().default(null),
    environmentGaps: textList(8, 600).default([])
})

export type OnlineCase = z.infer<typeof OnlineCaseType>

export const ImprovementCandidateType = z.object({
    id: z.string().min(1),
    operatorType: text(64).default(''),
    operatorDescription: text(600).default(''),
    rationale: text(2000).default(''),
    crew: CrewIRType.nullable().default(null),
    /** every regression case: the development suite plus accepted online cases */
    summary: optionalMetrics.default(null),
    onlineSummary: optionalMetrics.default(null),
    testSummary: optionalMetrics.default(null),
    error: text(2000).default(''),
    /** decided by the server-side gate, never trusted from the client */
    eligible: z.boolean().default(false),
    gateReason: text(600).default('')
})

export type ImprovementCandidate = z.infer<typeof ImprovementCandidateType>

export const ImprovementRunType = z.object({
    id: z.string().min(1).max(80),
    startedAt: z.string(),
    completedAt: z.string().default(''),
    status: z.enum(['completed', 'stopped', 'failed']).default('completed'),
    baseVersion: z.number().int().min(1),
    caseIds: z.array(z.string()).default([]),
    instructions: textList(20, 1000).default([]),
    current: ImprovementCandidateType,
    candidates: z.array(ImprovementCandidateType).max(8).default([]),
    recommendedCandidateId: z.string().default(''),
    note: text(2000).default(''),
    publishedVersion: z.number().int().nullable().default(null)
})

export type ImprovementRun = z.infer<typeof ImprovementRunType>

export const DeploymentDataType = z.object({
    goal: z.string().min(1),
    design: StudioDesignType,
    selectedChatModel: z.record(z.any()),
    cheapChatModel: z.record(z.any()).nullable().default(null),
    /** declared tool name -> id of a real Flowise tool that replaces the simulated one */
    toolBindings: z.record(z.string()).default({}),
    /** declared tool name -> tool row the compiled graph actually calls */
    toolIdByName: z.record(z.string()).default({}),
    sourceTrialId: z.string().default(''),
    currentVersion: z.number().int().min(1),
    versions: z.array(DeploymentVersionType).min(1),
    onlineCases: z.array(OnlineCaseType).default([]),
    improvementRuns: z.array(ImprovementRunType).default([])
})

export type DeploymentData = z.infer<typeof DeploymentDataType>

/* ------------------------------------------------------------------ *
 * Online assessment — what the reviewer model returns for one turn
 * ------------------------------------------------------------------ */

export const OnlineAssessmentType = z.object({
    verdict: z.enum(['ok', 'improvable']),
    summary: z.string().trim().min(1),
    issues: z.array(z.string()).max(8).default([]),
    instruction: z.string().default(''),
    createCase: z.boolean().default(false),
    scenario: AcceptanceScenarioType.optional(),
    environmentGaps: z.array(z.string()).max(6).default([])
})

export type OnlineAssessment = z.infer<typeof OnlineAssessmentType>

const TOOL_ASSERTIONS = new Set(['tool_called', 'tool_not_called', 'tool_succeeded', 'grounded'])

/**
 * A case drafted from a live conversation joins the regression suite, so it has
 * to be executable against the declared environment. Assertions about tools
 * that do not exist can never pass and would block every candidate forever.
 */
export const normalizeOnlineScenario = (
    scenario: AcceptanceScenario,
    design: Pick<StudioDesign, 'tools'>,
    caseId: string,
    fallbackInput: string
): AcceptanceScenario => {
    const toolNames = new Set((design.tools || []).map((tool) => tool.name))
    return AcceptanceScenarioType.parse({
        ...scenario,
        id: caseId,
        split: 'dev',
        category: scenario.category?.trim() || 'online_feedback',
        title: scenario.title?.trim() || 'Case collected from a live conversation',
        input: scenario.input?.trim() || fallbackInput,
        requiredTools: (scenario.requiredTools || []).filter((tool) => toolNames.has(tool)),
        assertions: (scenario.assertions || [])
            .filter((assertion) => !TOOL_ASSERTIONS.has(assertion.type) || toolNames.has(assertion.tool))
            .map((assertion, index) => ({ ...assertion, id: assertion.id || `${caseId}_a${index + 1}` }))
    })
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export const currentVersionOf = (data: DeploymentData): DeploymentVersion =>
    data.versions.find((version) => version.version === data.currentVersion) || data.versions[data.versions.length - 1]

/** Accepted online cases, as regression scenarios. */
export const onlineScenariosOf = (data: DeploymentData): AcceptanceScenario[] =>
    data.onlineCases
        .filter((item) => item.status === 'accepted' && item.scenario)
        .map((item) => ({ ...(item.scenario as AcceptanceScenario), id: item.id, split: 'dev' as const }))

export const addOnlineCase = (data: DeploymentData, onlineCase: OnlineCase): DeploymentData => {
    const cases = [...data.onlineCases, onlineCase]
    // Drop the oldest settled cases first; pending and accepted ones are work in progress.
    while (cases.length > MAX_ONLINE_CASES) {
        const settled = cases.findIndex((item) => item.status === 'rejected' || item.status === 'incorporated')
        cases.splice(settled >= 0 ? settled : 0, 1)
    }
    return { ...data, onlineCases: cases }
}

export const updateOnlineCase = (
    data: DeploymentData,
    caseId: string,
    patch: { status?: string; instruction?: string; scenario?: unknown }
): DeploymentData => {
    const existing = data.onlineCases.find((item) => item.id === caseId)
    if (!existing) throw new Error(`Online case ${caseId} does not exist.`)
    if (existing.status === 'incorporated') throw new Error('An incorporated case is part of a published version and cannot be edited.')
    if (patch.status === 'incorporated') throw new Error('Cases are incorporated by publishing a version, not by hand.')
    const status = patch.status === undefined ? existing.status : z.enum(ONLINE_CASE_STATUSES).parse(patch.status)
    const scenario =
        patch.scenario === undefined
            ? existing.scenario
            : patch.scenario === null
            ? null
            : normalizeOnlineScenario(AcceptanceScenarioType.parse(patch.scenario), data.design, caseId, existing.question)
    if (status === 'accepted' && !scenario && !(patch.instruction ?? existing.instruction).trim()) {
        throw new Error('A case needs an acceptance scenario or an instruction before it can be accepted.')
    }
    return {
        ...data,
        onlineCases: data.onlineCases.map((item) =>
            item.id === caseId
                ? OnlineCaseType.parse({ ...item, status, scenario, instruction: patch.instruction ?? item.instruction })
                : item
        )
    }
}

export const removeOnlineCase = (data: DeploymentData, caseId: string): DeploymentData => {
    const existing = data.onlineCases.find((item) => item.id === caseId)
    if (!existing) throw new Error(`Online case ${caseId} does not exist.`)
    if (existing.status === 'incorporated') throw new Error('An incorporated case is part of a published version and cannot be removed.')
    return { ...data, onlineCases: data.onlineCases.filter((item) => item.id !== caseId) }
}

export const IMPROVEMENT_GATE = {
    /** a candidate may lose at most this much rubric quality on the regression suite */
    allowedQualityLoss: 0.05,
    /** and at most this much pass rate on held-out cases */
    allowedHeldOutLoss: 0.1,
    /** a pure efficiency win must cut tokens or cost by at least this share */
    minimumEfficiencyGain: 0.1
}

const ratioBelow = (candidate: number, current: number, gain: number) => current > 0 && candidate <= current * (1 - gain)

/**
 * The publish gate. A candidate reaches the live flow only when it does not
 * regress on anything that was measured and measurably improves something.
 * "No worse and no better" is rejected: publishing churn without evidence is
 * exactly what the dev/test discipline exists to prevent.
 */
export const gateImprovementCandidate = (
    current: ImprovementCandidate,
    candidate: ImprovementCandidate,
    gate = IMPROVEMENT_GATE
): { eligible: boolean; reason: string } => {
    const reject = (reason: string) => ({ eligible: false, reason })
    if (!candidate.crew) return reject('No crew was recorded for this candidate.')
    if (candidate.error) return reject(candidate.error)
    const now = current.summary
    const next = candidate.summary
    if (!now || !now.total) return reject('The current version was not measured, so nothing can be compared.')
    if (!next || !next.completed) return reject('The candidate completed no regression case.')
    if (next.total < now.total) return reject('The candidate was measured on fewer cases than the current version.')
    if (next.failed > now.failed) return reject(`More execution failures than the current version (${next.failed} vs ${now.failed}).`)
    if (next.criticalViolations > now.criticalViolations) {
        return reject(
            `More critical assertion violations than the current version (${next.criticalViolations} vs ${now.criticalViolations}).`
        )
    }
    if (next.passRate < now.passRate) return reject('The regression pass rate dropped.')
    if (next.quality < now.quality - gate.allowedQualityLoss) return reject('Rubric quality dropped by more than the allowed margin.')

    const onlineNow = current.onlineSummary
    const onlineNext = candidate.onlineSummary
    if (onlineNow?.total && (!onlineNext || onlineNext.passRate < onlineNow.passRate)) {
        return reject('The cases collected from real conversations regressed.')
    }

    const testNow = current.testSummary
    const testNext = candidate.testSummary
    if (testNow?.total && testNext?.total && testNext.passRate < testNow.passRate - gate.allowedHeldOutLoss) {
        return reject('The held-out pass rate dropped by more than the allowed margin.')
    }

    const improvedOnline = Boolean(onlineNow?.total && onlineNext && onlineNext.passRate > onlineNow.passRate)
    const improvedQuality = next.passRate > now.passRate || next.quality > now.quality + 0.02
    const improvedEfficiency =
        next.passRate >= now.passRate &&
        (ratioBelow(next.averageTokens, now.averageTokens, gate.minimumEfficiencyGain) ||
            ratioBelow(next.averageCost, now.averageCost, gate.minimumEfficiencyGain))
    if (!improvedOnline && !improvedQuality && !improvedEfficiency) {
        return reject('No measurable improvement over the current version.')
    }
    return { eligible: true, reason: '' }
}

const rankScore = (candidate: ImprovementCandidate) => [
    Number(candidate.onlineSummary?.passRate || 0),
    Number(candidate.summary?.passRate || 0),
    Number(candidate.summary?.quality || 0),
    -Number(candidate.summary?.averageCost || 0),
    -Number(candidate.summary?.averageTokens || 0)
]

/** Applies the gate to every candidate and picks the best eligible one. */
export const judgeImprovementRun = (run: ImprovementRun, gate = IMPROVEMENT_GATE): ImprovementRun => {
    const candidates = run.candidates.map((candidate) => {
        const verdict = gateImprovementCandidate(run.current, candidate, gate)
        return { ...candidate, eligible: verdict.eligible, gateReason: verdict.reason }
    })
    const best = candidates
        .filter((candidate) => candidate.eligible)
        .sort((left, right) => {
            const a = rankScore(left)
            const b = rankScore(right)
            for (let index = 0; index < a.length; index += 1) {
                if (a[index] !== b[index]) return b[index] - a[index]
            }
            return 0
        })[0]
    return { ...run, candidates, recommendedCandidateId: best?.id || '' }
}

export const recordImprovementRun = (data: DeploymentData, runInput: unknown): { data: DeploymentData; run: ImprovementRun } => {
    const parsed = ImprovementRunType.parse(runInput)
    if (parsed.baseVersion !== data.currentVersion) {
        throw new Error(
            `This run measured version ${parsed.baseVersion}, but version ${data.currentVersion} is live now. Run the improvement again.`
        )
    }
    const run = judgeImprovementRun({ ...parsed, publishedVersion: null })
    const runs = [...data.improvementRuns.filter((item) => item.id !== run.id), run].slice(-MAX_IMPROVEMENT_RUNS)
    return { data: { ...data, improvementRuns: runs }, run }
}

/**
 * Publishing takes the candidate from a recorded, gated run rather than a crew
 * the client sends, so nothing reaches the live flow without having passed the
 * regression suite first.
 */
export const selectPublishableCandidate = (data: DeploymentData, runId: string, candidateId: string) => {
    const run = data.improvementRuns.find((item) => item.id === runId)
    if (!run) throw new Error(`Improvement run ${runId} does not exist.`)
    if (run.publishedVersion) throw new Error(`This run was already published as version ${run.publishedVersion}.`)
    if (run.baseVersion !== data.currentVersion) {
        throw new Error(`This run was measured against version ${run.baseVersion}, but version ${data.currentVersion} is live now.`)
    }
    const judged = judgeImprovementRun(run)
    const candidate = judged.candidates.find((item) => item.id === candidateId)
    if (!candidate) throw new Error(`Candidate ${candidateId} is not part of this run.`)
    if (!candidate.eligible || !candidate.crew) throw new Error(`Candidate cannot be published: ${candidate.gateReason}`)
    return { run: judged, candidate: candidate as ImprovementCandidate & { crew: NonNullable<ImprovementCandidate['crew']> } }
}

export const appendVersion = (
    data: DeploymentData,
    entry: Omit<DeploymentVersion, 'version' | 'createdAt'>,
    now = new Date().toISOString(),
    publishedFrom?: { runId: string }
): DeploymentData => {
    const version = Math.max(...data.versions.map((item) => item.version)) + 1
    const incorporated = new Set(entry.incorporatedCaseIds)
    const versions = [...data.versions, DeploymentVersionType.parse({ ...entry, version, createdAt: now })]
    // Always keep the first version: it is the crew the experiment produced.
    while (versions.length > MAX_VERSIONS) versions.splice(1, 1)
    return {
        ...data,
        currentVersion: version,
        versions,
        onlineCases: data.onlineCases.map((item) => (incorporated.has(item.id) ? { ...item, status: 'incorporated' as const } : item)),
        improvementRuns: data.improvementRuns.map((run) =>
            publishedFrom && run.id === publishedFrom.runId ? { ...run, publishedVersion: version } : run
        )
    }
}

export const rollbackTo = (data: DeploymentData, version: number): DeploymentData => {
    if (!data.versions.some((item) => item.version === version)) throw new Error(`Version ${version} does not exist.`)
    if (version === data.currentVersion) throw new Error(`Version ${version} is already live.`)
    return { ...data, currentVersion: version }
}

/** Tool rows a live flow depends on; purging them would break the deployment. */
export const referencedToolIds = (datas: Pick<DeploymentData, 'toolIdByName'>[]) =>
    new Set(datas.flatMap((data) => Object.values(data.toolIdByName || {})).filter(Boolean))

export const summarizeDeploymentData = (data: DeploymentData) => {
    const version = currentVersionOf(data)
    const bound = Object.keys(data.toolBindings || {}).filter((name) => data.toolBindings[name])
    return {
        workflowName: data.design.workflowName,
        currentVersion: data.currentVersion,
        versionCount: data.versions.length,
        toolMode: !data.design.tools.length
            ? 'none'
            : bound.length === data.design.tools.length
            ? 'real'
            : bound.length
            ? 'mixed'
            : 'simulated',
        pendingCases: data.onlineCases.filter((item) => item.status === 'pending').length,
        acceptedCases: data.onlineCases.filter((item) => item.status === 'accepted').length,
        metrics: version.metrics,
        heldOutMetrics: version.heldOutMetrics
    }
}
