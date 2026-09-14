import { describe, expect, it } from '@jest/globals'
import {
    DeploymentDataType,
    OnlineCaseType,
    addOnlineCase,
    appendVersion,
    currentVersionOf,
    gateImprovementCandidate,
    judgeImprovementRun,
    normalizeOnlineScenario,
    onlineScenariosOf,
    recordImprovementRun,
    referencedToolIds,
    rollbackTo,
    selectPublishableCandidate,
    summarizeDeploymentData,
    updateOnlineCase,
    type DeploymentData,
    type ImprovementCandidate
} from './deploymentModel'

const crew = (goal = 'answer the customer') => ({
    version: 1,
    process: 'sequential',
    agents: [{ id: 'support', name: 'Support', role: 'specialist', goal, tools: ['lookup_order'] }],
    tasks: [
        {
            id: 'reply',
            name: 'Reply',
            description: 'Reply to the customer',
            expectedOutput: 'A reply',
            agentId: 'support',
            outputKey: 'reply'
        }
    ],
    finalTaskId: 'reply'
})

const design = {
    workflowName: 'Support desk',
    summary: 'Answers order questions',
    successCriteria: ['Never invent an order status'],
    tools: [{ name: 'lookup_order', label: 'Lookup order', description: 'Finds an order', params: [], fixtures: [] }],
    scenarios: [{ id: 'core_1_1', title: 'Order status', category: 'core', input: 'Where is order A1?', expectedBehavior: ['Look it up'] }],
    crew: crew()
}

const baseData = (): DeploymentData =>
    DeploymentDataType.parse({
        goal: 'Support',
        design,
        selectedChatModel: { name: 'chatOpenAI' },
        toolIdByName: { lookup_order: 'tool-1' },
        currentVersion: 1,
        versions: [{ version: 1, crew: crew(), createdAt: '2026-09-14T00:00:00.000Z' }]
    })

const metrics = (patch: Record<string, number> = {}) => ({
    total: 10,
    completed: 10,
    failed: 0,
    quality: 0.8,
    passRate: 0.7,
    assertionRate: 0.8,
    criticalViolations: 0,
    averageTokens: 1000,
    averageCost: 0.01,
    averageDurationMs: 4000,
    averageModelCalls: 2,
    ...patch
})

const candidate = (id: string, patch: Partial<ImprovementCandidate> = {}): ImprovementCandidate => ({
    id,
    operatorType: 'rewrite_prompt',
    operatorDescription: 'Sharpen support',
    rationale: '',
    crew: crew(`goal ${id}`) as any,
    summary: metrics(),
    onlineSummary: null,
    testSummary: null,
    error: '',
    eligible: false,
    gateReason: '',
    ...patch
})

const onlineCase = (id: string, patch: Record<string, any> = {}) =>
    OnlineCaseType.parse({
        id,
        createdAt: '2026-09-14T00:00:00.000Z',
        source: 'user_feedback',
        question: 'Where is order A1?',
        scenario: { ...design.scenarios[0], id },
        ...patch
    })

describe('online scenarios', () => {
    it('drops assertions about undeclared tools and forces the dev split', () => {
        const scenario = normalizeOnlineScenario(
            {
                ...design.scenarios[0],
                split: 'test',
                requiredTools: ['lookup_order', 'send_email'],
                assertions: [
                    {
                        id: '',
                        type: 'tool_called',
                        severity: 'major',
                        description: 'd',
                        tool: 'send_email',
                        withArgs: [],
                        anyOf: [],
                        pattern: '',
                        forbidden: []
                    },
                    {
                        id: '',
                        type: 'tool_called',
                        severity: 'major',
                        description: 'd',
                        tool: 'lookup_order',
                        withArgs: [],
                        anyOf: [],
                        pattern: '',
                        forbidden: []
                    },
                    {
                        id: '',
                        type: 'output_contains',
                        severity: 'minor',
                        description: 'd',
                        tool: '',
                        withArgs: [],
                        anyOf: ['A1'],
                        pattern: '',
                        forbidden: []
                    }
                ]
            } as any,
            design as any,
            'online_x',
            'fallback'
        )
        expect(scenario.id).toBe('online_x')
        expect(scenario.split).toBe('dev')
        expect(scenario.requiredTools).toEqual(['lookup_order'])
        expect(scenario.assertions.map((item) => item.tool || item.type)).toEqual(['lookup_order', 'output_contains'])
        expect(scenario.assertions[0].id).toBe('online_x_a1')
    })

    it('only feeds accepted cases with a scenario into the regression suite', () => {
        let data = baseData()
        data = addOnlineCase(data, onlineCase('a', { status: 'accepted' }))
        data = addOnlineCase(data, onlineCase('b'))
        data = addOnlineCase(data, onlineCase('c', { status: 'accepted', scenario: null, instruction: 'Quote the id' }))
        expect(onlineScenariosOf(data).map((item) => item.id)).toEqual(['a'])
    })

    it('refuses to accept a case with neither a scenario nor an instruction', () => {
        const data = addOnlineCase(baseData(), onlineCase('a', { scenario: null }))
        expect(() => updateOnlineCase(data, 'a', { status: 'accepted' })).toThrow(/scenario or an instruction/)
        expect(() => updateOnlineCase(data, 'a', { status: 'incorporated' })).toThrow(/publishing/)
    })
})

describe('publish gate', () => {
    const current = candidate('current')

    it('rejects a candidate that is merely equal', () => {
        expect(gateImprovementCandidate(current, candidate('same')).eligible).toBe(false)
    })

    it('accepts a strictly better pass rate', () => {
        expect(gateImprovementCandidate(current, candidate('better', { summary: metrics({ passRate: 0.8 }) }))).toEqual({
            eligible: true,
            reason: ''
        })
    })

    it('accepts a pure efficiency win without quality loss', () => {
        expect(gateImprovementCandidate(current, candidate('cheaper', { summary: metrics({ averageTokens: 600 }) })).eligible).toBe(true)
    })

    it('rejects regressions on critical violations, failures and online cases', () => {
        expect(
            gateImprovementCandidate(current, candidate('c', { summary: metrics({ passRate: 0.9, criticalViolations: 1 }) })).eligible
        ).toBe(false)
        expect(gateImprovementCandidate(current, candidate('f', { summary: metrics({ passRate: 0.9, failed: 1 }) })).eligible).toBe(false)
        const withOnline = candidate('current', { onlineSummary: metrics({ total: 2, passRate: 0.5 }) })
        expect(
            gateImprovementCandidate(
                withOnline,
                candidate('o', { summary: metrics({ passRate: 0.9 }), onlineSummary: metrics({ total: 2, passRate: 0 }) })
            ).reason
        ).toMatch(/real conversations regressed/)
    })

    it('recommends the eligible candidate that fixes the most online cases', () => {
        const run = judgeImprovementRun({
            id: 'run-1',
            startedAt: '',
            completedAt: '',
            status: 'completed',
            baseVersion: 1,
            caseIds: [],
            instructions: [],
            note: '',
            publishedVersion: null,
            recommendedCandidateId: 'client-picked',
            current: candidate('current', { onlineSummary: metrics({ total: 2, passRate: 0 }) }),
            candidates: [
                candidate('cheap', { summary: metrics({ averageTokens: 500 }), onlineSummary: metrics({ total: 2, passRate: 0.5 }) }),
                candidate('fixes', { summary: metrics({ passRate: 0.8 }), onlineSummary: metrics({ total: 2, passRate: 1 }) })
            ]
        })
        expect(run.recommendedCandidateId).toBe('fixes')
        expect(run.candidates.every((item) => item.eligible)).toBe(true)
    })
})

describe('versions', () => {
    const runInput = {
        id: 'run-1',
        startedAt: '2026-09-14T00:00:00.000Z',
        baseVersion: 1,
        caseIds: ['a'],
        current: candidate('current'),
        candidates: [candidate('better', { summary: metrics({ passRate: 0.9 }) }), candidate('same')],
        // the client cannot smuggle an eligibility verdict past the gate
        recommendedCandidateId: 'same'
    }

    it('re-judges recorded runs on the server and publishes only eligible candidates', () => {
        const data = addOnlineCase(baseData(), onlineCase('a', { status: 'accepted' }))
        const recorded = recordImprovementRun(data, {
            ...runInput,
            candidates: runInput.candidates.map((item) => ({ ...item, eligible: true }))
        })
        expect(recorded.run.recommendedCandidateId).toBe('better')
        expect(() => selectPublishableCandidate(recorded.data, 'run-1', 'same')).toThrow(/cannot be published/)

        const { candidate: chosen } = selectPublishableCandidate(recorded.data, 'run-1', 'better')
        const published = appendVersion(
            recorded.data,
            {
                crew: chosen.crew,
                metrics: chosen.summary,
                heldOutMetrics: null,
                onlineMetrics: null,
                note: '',
                operatorDescriptions: [],
                incorporatedCaseIds: ['a']
            },
            '2026-09-15T00:00:00.000Z',
            { runId: 'run-1' }
        )
        expect(published.currentVersion).toBe(2)
        expect(currentVersionOf(published).crew.agents[0].goal).toBe('goal better')
        expect(published.onlineCases[0].status).toBe('incorporated')
        expect(published.improvementRuns[0].publishedVersion).toBe(2)
        expect(() => selectPublishableCandidate(published, 'run-1', 'better')).toThrow(/already published/)
    })

    it('rejects a run measured against a version that is no longer live', () => {
        const data = { ...baseData(), currentVersion: 2, versions: [...baseData().versions, { ...baseData().versions[0], version: 2 }] }
        expect(() => recordImprovementRun(data, runInput)).toThrow(/version 2 is live/)
    })

    it('rolls back to an existing version only', () => {
        const data = appendVersion(baseData(), {
            crew: crew('v2') as any,
            metrics: null,
            heldOutMetrics: null,
            onlineMetrics: null,
            note: '',
            operatorDescriptions: [],
            incorporatedCaseIds: []
        })
        expect(rollbackTo(data, 1).currentVersion).toBe(1)
        expect(() => rollbackTo(data, 2)).toThrow(/already live/)
        expect(() => rollbackTo(data, 9)).toThrow(/does not exist/)
    })
})

describe('summaries', () => {
    it('reports tool mode and protects referenced tool rows', () => {
        const data = baseData()
        expect(summarizeDeploymentData(data).toolMode).toBe('simulated')
        expect(summarizeDeploymentData({ ...data, toolBindings: { lookup_order: 'real-1' } }).toolMode).toBe('real')
        expect([...referencedToolIds([data, { toolIdByName: { other: 'tool-2' } }])]).toEqual(['tool-1', 'tool-2'])
    })
})
