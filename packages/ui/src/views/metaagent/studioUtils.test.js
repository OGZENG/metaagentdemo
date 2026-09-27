import {
    buildConversationTurns,
    buildImprovementSuite,
    compareToLab,
    summarizeExecutedData,
    summarizeResultSubset,
    summarizeTurns,
    buildRunEvidence,
    buildSearchTree,
    extractStudioToolCalls,
    extractStudioTrace,
    getParetoTrialIds,
    isTrialFeasible,
    selectNextTrial,
    selectPreflightScenarios,
    selectSearchParent,
    splitScenarios,
    summarizePrediction,
    summarizeStudioResults,
    validateStudioOutput
} from './studioUtils'

const prediction = (nodes) => ({ agentFlowExecutedData: nodes })

const usedToolNode = (nodeId, usedTools, usage) => ({
    nodeId,
    data: { output: { usedTools, ...(usage ? { usageMetadata: usage } : {}) } }
})

const result = (patch) => ({
    scenarioId: patch.scenarioId || 'case_1',
    title: 'case',
    split: 'dev',
    toolCalls: [],
    totalTokens: 100,
    estimatedCost: 0.01,
    durationMs: 1000,
    modelCalls: 2,
    ...patch
})

const evaluation = (patch = {}) => ({
    score: 80,
    passed: true,
    criticalViolation: false,
    assertionResults: [],
    assertionSummary: { total: 2, passed: 2 },
    issues: [],
    ...patch
})

describe('telemetry extraction', () => {
    it('sums token usage and counts model calls', () => {
        const summary = summarizePrediction(
            prediction([
                usedToolNode('a', [], { input_tokens: 100, output_tokens: 50 }),
                usedToolNode('b', [], { total_tokens: 300, total_cost: 0.02 }),
                usedToolNode('c', [], null)
            ]),
            1500
        )
        expect(summary.totalTokens).toBe(450)
        expect(summary.estimatedCost).toBeCloseTo(0.02)
        expect(summary.modelCalls).toBe(2)
        expect(summary.durationMs).toBe(1500)
    })

    it('flattens tool calls from every node of the trace', () => {
        const calls = extractStudioToolCalls(
            prediction([
                usedToolNode('router', []),
                usedToolNode('agent_1', [
                    { tool: 'check_order', toolInput: { order_id: 'A-1' }, toolOutput: '{"ok":true}' },
                    { tool: 'issue_refund', toolInput: { amount: 40 }, toolOutput: '{"ok":true}' }
                ])
            ])
        )
        expect(calls).toHaveLength(2)
        expect(calls[0]).toMatchObject({ nodeId: 'agent_1', tool: 'check_order', toolInput: { order_id: 'A-1' } })
    })

    it('records which tools each trace step used', () => {
        const trace = extractStudioTrace(prediction([usedToolNode('agent_1', [{ tool: 'check_order', toolInput: {}, toolOutput: '{}' }])]))
        expect(trace[0].toolCalls).toEqual(['check_order'])
    })
})

describe('validateStudioOutput', () => {
    it('rejects an unresolved template variable', () => {
        expect(validateStudioOutput('Here is {{ llmAgentflow_0.output.content }} for you', {})).toContain('unresolved')
    })

    it('rejects a reply that asks for the input it was already given', () => {
        const problem = validateStudioOutput('Please share the customer request so I can help you further.', {
            input: 'My order A-1187 has not arrived and I want a refund.'
        })
        expect(problem).toContain('requested the same input again')
    })

    it('accepts a normal reply', () => {
        expect(validateStudioOutput('Your order A-1187 is pending a carrier update; I have opened a lookup request.', {})).toBe('')
    })
})

describe('acceptance suite handling', () => {
    it('separates dev cases from held-out cases', () => {
        const { dev, test } = splitScenarios([{ id: '1' }, { id: '2', split: 'test' }, { id: '3', split: 'dev' }])
        expect(dev.map((item) => item.id)).toEqual(['1', '3'])
        expect(test.map((item) => item.id)).toEqual(['2'])
    })

    it('keeps every category represented in both splits', () => {
        // The server splits per category so the search trains on every kind of
        // case. This guards the consumer side: dev must never come back empty
        // for a category that exists.
        const suite = [
            { id: 'a1', category: 'order', split: 'dev' },
            { id: 'a2', category: 'order', split: 'dev' },
            { id: 'a3', category: 'order', split: 'test' },
            { id: 'b1', category: 'refund', split: 'dev' },
            { id: 'b2', category: 'refund', split: 'test' }
        ]
        const { dev, test } = splitScenarios(suite)
        for (const category of ['order', 'refund']) {
            expect(dev.some((item) => item.category === category)).toBe(true)
            expect(test.some((item) => item.category === category)).toBe(true)
        }
    })

    it('preflights a tool-using case first', () => {
        const chosen = selectPreflightScenarios(
            [
                { id: 'a', requiredTools: [] },
                { id: 'b', requiredTools: ['check_order'] }
            ],
            2
        )
        expect(chosen[0].id).toBe('b')
    })

    it('summarizes pass rate, assertion rate and cost', () => {
        const summary = summarizeStudioResults([
            result({ scenarioId: '1', evaluation: evaluation({ score: 90 }) }),
            result({ scenarioId: '2', evaluation: evaluation({ score: 40, passed: false, assertionSummary: { total: 2, passed: 1 } }) }),
            result({ scenarioId: '3', error: 'boom' })
        ])
        expect(summary.total).toBe(3)
        expect(summary.completed).toBe(2)
        expect(summary.failed).toBe(1)
        expect(summary.passRate).toBeCloseTo(0.5)
        expect(summary.quality).toBeCloseTo(0.65)
        expect(summary.assertionRate).toBeCloseTo(0.75)
    })
})

describe('buildRunEvidence', () => {
    const design = { tools: [{ name: 'check_order' }, { name: 'issue_refund' }] }

    it('reports tools that a failing assertion said were never called', () => {
        const results = [
            result({
                scenarioId: 'case_1',
                evaluation: evaluation({
                    passed: false,
                    assertionResults: [{ id: 'a1', type: 'tool_called', tool: 'check_order', passed: false, severity: 'critical' }],
                    issues: ['no order lookup happened']
                })
            })
        ]
        const evidence = buildRunEvidence(results, summarizeStudioResults(results), design)
        expect(evidence.missingToolCalls).toEqual(['check_order'])
        expect(evidence.failedAssertionTypes).toEqual(['tool_called'])
        expect(evidence.failingScenarioIds).toEqual(['case_1'])
        expect(evidence.evaluatorIssues).toContain('no order lookup happened')
    })

    it('reports declared tools that no run ever touched', () => {
        const results = [result({ toolCalls: [{ tool: 'check_order' }], evaluation: evaluation() })]
        const evidence = buildRunEvidence(results, summarizeStudioResults(results), design)
        expect(evidence.unusedTools).toEqual(['issue_refund'])
    })

    it('carries execution errors through', () => {
        const results = [result({ error: 'Model is required' })]
        const evidence = buildRunEvidence(results, summarizeStudioResults(results), design)
        expect(evidence.errorMessages).toEqual(['Model is required'])
        expect(evidence.failureRate).toBe(1)
    })
})

describe('selection', () => {
    const trial = (id, summary) => ({ id, summary })
    const healthy = { total: 4, completed: 4, failed: 0, passRate: 1, quality: 0.9, averageCost: 0.02, averageDurationMs: 4000 }

    it('treats a trial with execution failures as infeasible', () => {
        expect(isTrialFeasible({ total: 4, completed: 3, failed: 1, passRate: 1 })).toBe(false)
        expect(isTrialFeasible(healthy)).toBe(true)
    })

    it('keeps only non-dominated trials on the frontier', () => {
        const trials = [
            trial('baseline', healthy),
            trial('cheaper', { ...healthy, averageCost: 0.01 }),
            trial('dominated', { ...healthy, quality: 0.8, averageCost: 0.03, averageDurationMs: 5000 })
        ]
        const pareto = getParetoTrialIds(trials, 0)
        expect(pareto).toContain('cheaper')
        expect(pareto).not.toContain('dominated')
    })

    it('recommends the cheapest trial on the frontier when pass rates are equal', () => {
        const trials = [trial('baseline', healthy), trial('cheaper', { ...healthy, averageCost: 0.01 })]
        expect(selectNextTrial(trials, 0.9, 0.1)?.id).toBe('cheaper')
    })

    it('does not trade a passed case for lower cost by default', () => {
        const trials = [
            trial('baseline', { ...healthy, passRate: 0.83 }),
            trial('cheaper', { ...healthy, passRate: 0.67, quality: 0.95, averageCost: 0.01 })
        ]
        expect(selectNextTrial(trials, 0.9, 0.1)?.id).toBe('baseline')
        expect(selectNextTrial(trials, 0.9, 0.1, 0.6, 0.1, 'cost_first')?.id).toBe('cheaper')
    })

    it('picks the highest pass rate as the next search parent', () => {
        const parent = selectSearchParent([
            trial('baseline', { ...healthy, passRate: 0.5 }),
            trial('candidate', { ...healthy, passRate: 0.9 })
        ])
        expect(parent.id).toBe('candidate')
    })

    it('nests candidates under the parent they were derived from', () => {
        const tree = buildSearchTree([
            { id: 'baseline', parentId: null },
            { id: 'c1', parentId: 'baseline' },
            { id: 'c2', parentId: 'c1' }
        ])
        expect(tree).toHaveLength(1)
        expect(tree[0].children[0].id).toBe('c1')
        expect(tree[0].children[0].children[0].id).toBe('c2')
    })
})

describe('deployed crew telemetry', () => {
    const executed = (label, usage, tools = [], status = 'FINISHED') => ({
        nodeId: label,
        nodeLabel: label,
        status,
        data: { output: { usageMetadata: usage, usedTools: tools } }
    })

    it('breaks usage down per agent and counts tool calls', () => {
        const summary = summarizeExecutedData([
            executed('Router', { input_tokens: 10, output_tokens: 5 }),
            executed('Support', { total_tokens: 100, total_cost: 0.01 }, [{ tool: 'lookup_order' }]),
            executed('Support', { input_tokens: 20, output_tokens: 20 }),
            { nodeId: 'start', data: { output: {} } }
        ])
        expect(summary.totalTokens).toBe(155)
        expect(summary.modelCalls).toBe(3)
        expect(summary.toolCalls).toBe(1)
        expect(summary.agents.map((agent) => [agent.name, agent.calls, agent.totalTokens])).toEqual([
            ['Support', 2, 140],
            ['Router', 1, 15]
        ])
    })

    it('pairs questions with replies and leaves a streaming reply incomplete', () => {
        const messages = [
            { type: 'apiMessage', message: 'Hi there! How can I help?' },
            { type: 'userMessage', message: 'Where is A1?' },
            { type: 'apiMessage', id: 'm1', message: 'Shipped', agentFlowExecutedData: [executed('Support', { total_tokens: 50 })] },
            { type: 'userMessage', message: 'And A2?' },
            { type: 'apiMessage', message: 'Look' }
        ]
        const turns = buildConversationTurns(messages, true)
        expect(turns.map((turn) => [turn.key, turn.question, turn.complete])).toEqual([
            ['m1', 'Where is A1?', true],
            ['turn-1', 'And A2?', false]
        ])
        expect(summarizeTurns(turns)).toMatchObject({ turns: 1, totalTokens: 50, averageTokens: 50 })
    })

    it('flags live usage that drifts far above the measured crew', () => {
        const rows = compareToLab({ averageTokens: 3000, averageCost: 0 }, { averageTokens: 1000, averageCost: 0.01 })
        expect(rows.find((row) => row.key === 'averageTokens')).toMatchObject({ ratio: 3, drift: true })
        expect(rows.find((row) => row.key === 'averageCost')).toMatchObject({ ratio: null, drift: false })
    })

    it('adds accepted online cases to the development split only', () => {
        const suite = buildImprovementSuite(
            {
                scenarios: [
                    { id: 'a', split: 'dev' },
                    { id: 'b', split: 'test' }
                ]
            },
            [
                { id: 'online_1', status: 'accepted', instruction: 'Quote the order id', scenario: { id: 'x', split: 'test' } },
                { id: 'online_2', status: 'accepted', instruction: 'Quote the order id', scenario: null },
                { id: 'online_3', status: 'pending', scenario: { id: 'y' } }
            ]
        )
        expect(suite.dev.map((scenario) => [scenario.id, scenario.split])).toEqual([
            ['a', 'dev'],
            ['online_1', 'dev']
        ])
        expect(suite.test.map((scenario) => scenario.id)).toEqual(['b'])
        expect(suite.caseIds).toEqual(['online_1', 'online_2'])
        expect(suite.instructions).toEqual(['Quote the order id'])
        expect(summarizeResultSubset([{ scenarioId: 'a' }], new Set(['online_1']))).toBeNull()
    })
})

describe('tool-loop usage', () => {
    it('counts every model call an agent node reports', () => {
        const summary = summarizeExecutedData([
            {
                nodeLabel: 'Support',
                data: { output: { usageMetadata: { input_tokens: 4845, output_tokens: 217, total_tokens: 5062, model_calls: 3 } } }
            }
        ])
        expect(summary).toMatchObject({ inputTokens: 4845, outputTokens: 217, totalTokens: 5062, modelCalls: 3 })
        expect(summary.agents[0].calls).toBe(3)
    })
})
