import { describe, expect, it } from '@jest/globals'
import { normalizeCrewIR } from './crewIR'
import { CrewOperatorType, OperatorNotApplicable, applyOperator, describeOperatorEffect, enumerateOperators, estimateCrewCost } from './crewOperators'
import { checkSelections, rankOperators, selectOperators } from './crewSearch'
import { RunEvidenceType } from './crewSearch'
import type { CrewIR } from './studioSchemas'

const agent = (id: string, patch: Record<string, any> = {}) => ({
    id,
    name: id,
    role: 'specialist',
    goal: `goal ${id}`,
    backstory: '',
    tools: [],
    guardrails: [],
    modelTier: 'default',
    ...patch
})

const task = (id: string, agentId: string, patch: Record<string, any> = {}) => ({
    id,
    name: id,
    description: `do ${id}`,
    expectedOutput: `${id} output`,
    agentId,
    dependsOn: [],
    outputKey: `${id}_result`,
    ...patch
})

/** Two independent specialists converging on a synthesis task. */
const fanIn = (): CrewIR =>
    normalizeCrewIR(
        {
            version: 1,
            process: 'parallel',
            agents: [agent('a_agent'), agent('b_agent'), agent('synth_agent', { role: 'orchestrator' })],
            tasks: [
                task('a_task', 'a_agent'),
                task('b_task', 'b_agent'),
                task('synth', 'synth_agent', { dependsOn: ['a_task', 'b_task'] })
            ],
            routerAgentId: '',
            routes: [],
            finalTaskId: 'synth'
        },
        ['check_order']
    ).ir

const operator = (patch: Record<string, any>) => CrewOperatorType.parse(patch)

describe('operators', () => {
    it('merge_tasks removes one model call and keeps the crew valid', () => {
        const source = fanIn()
        const { ir } = applyOperator(source, operator({ type: 'merge_tasks', taskIds: ['a_task', 'b_task'] }))
        expect(ir.tasks).toHaveLength(2)
        expect(estimateCrewCost(ir).modelCalls).toBe(estimateCrewCost(source).modelCalls - 1)
        expect(ir.tasks.find((item) => item.id === 'synth')?.dependsOn).toEqual(['a_task'])
    })

    it('merge_tasks unions the tool bindings of both agents', () => {
        const source = fanIn()
        source.agents[1].tools = ['check_order']
        const { ir } = applyOperator(source, operator({ type: 'merge_tasks', taskIds: ['a_task', 'b_task'] }), ['check_order'])
        expect(ir.agents.find((item) => item.id === 'a_agent')?.tools).toEqual(['check_order'])
    })

    it('merge_tasks refuses tasks that depend on one another', () => {
        expect(() => applyOperator(fanIn(), operator({ type: 'merge_tasks', taskIds: ['a_task', 'synth'] }))).toThrow(OperatorNotApplicable)
    })

    it('remove_task rewires dependents onto the removed task dependencies', () => {
        const source = normalizeCrewIR({
            version: 1,
            process: 'sequential',
            agents: [agent('a_agent'), agent('b_agent'), agent('c_agent')],
            tasks: [
                task('first', 'a_agent'),
                task('middle', 'b_agent', { dependsOn: ['first'] }),
                task('last', 'c_agent', { dependsOn: ['middle'] })
            ],
            routerAgentId: '',
            routes: [],
            finalTaskId: 'last'
        }).ir
        const { ir } = applyOperator(source, operator({ type: 'remove_task', taskIds: ['middle'] }))
        expect(ir.tasks.map((item) => item.id)).toEqual(['first', 'last'])
        expect(ir.tasks.find((item) => item.id === 'last')?.dependsOn).toEqual(['first'])
    })

    it('remove_task refuses to delete the final task', () => {
        expect(() => applyOperator(fanIn(), operator({ type: 'remove_task', taskIds: ['synth'] }))).toThrow(OperatorNotApplicable)
    })

    it('add_validator becomes the new final task', () => {
        const { ir } = applyOperator(fanIn(), operator({ type: 'add_validator' }))
        expect(ir.finalTaskId).toBe('validate_output')
        expect(ir.tasks.find((item) => item.id === 'validate_output')?.dependsOn).toEqual(['synth'])
        expect(() => applyOperator(ir, operator({ type: 'add_validator' }))).toThrow(OperatorNotApplicable)
    })

    it('parallelize_task shortens the critical path without orphaning work', () => {
        const source = normalizeCrewIR({
            version: 1,
            process: 'sequential',
            agents: [agent('a_agent'), agent('b_agent'), agent('c_agent')],
            tasks: [
                task('first', 'a_agent'),
                task('second', 'b_agent', { dependsOn: ['first'] }),
                task('final', 'c_agent', { dependsOn: ['second'] })
            ],
            routerAgentId: '',
            routes: [],
            finalTaskId: 'final'
        }).ir
        const { ir } = applyOperator(source, operator({ type: 'parallelize_task', taskIds: ['second'] }))
        expect(ir.tasks.find((item) => item.id === 'second')?.dependsOn).toEqual([])
        expect(ir.tasks.find((item) => item.id === 'final')?.dependsOn).toEqual(expect.arrayContaining(['second', 'first']))
        expect(estimateCrewCost(ir).criticalPath).toBeLessThan(estimateCrewCost(source).criticalPath)
    })

    it('add_router turns independent entry tasks into gated branches', () => {
        const { ir } = applyOperator(fanIn(), operator({ type: 'add_router' }))
        expect(ir.process).toBe('routed')
        expect(ir.routes.map((route) => route.taskId)).toEqual(['a_task', 'b_task'])
        expect(estimateCrewCost(ir).modelCalls).toBe(4)
    })

    it('remove_router reverses add_router', () => {
        const routed = applyOperator(fanIn(), operator({ type: 'add_router' })).ir
        const { ir } = applyOperator(routed, operator({ type: 'remove_router' }))
        expect(ir.process).toBe('parallel')
        expect(ir.agents.some((item) => item.role === 'router')).toBe(false)
    })

    it('bind_tool and unbind_tool are inverses', () => {
        const bound = applyOperator(fanIn(), operator({ type: 'bind_tool', agentIds: ['a_agent'], tool: 'check_order' }), [
            'check_order'
        ]).ir
        expect(bound.agents.find((item) => item.id === 'a_agent')?.tools).toEqual(['check_order'])
        const unbound = applyOperator(bound, operator({ type: 'unbind_tool', agentIds: ['a_agent'], tool: 'check_order' }), [
            'check_order'
        ]).ir
        expect(unbound.agents.find((item) => item.id === 'a_agent')?.tools).toEqual([])
    })

    it('rewrite_prompt replaces the goal and appends guardrails', () => {
        const { ir } = applyOperator(
            fanIn(),
            operator({ type: 'rewrite_prompt', agentIds: ['a_agent'], goal: 'new goal', guardrails: ['never guess an order status'] })
        )
        const patched = ir.agents.find((item) => item.id === 'a_agent')
        expect(patched?.goal).toBe('new goal')
        expect(patched?.guardrails).toContain('never guess an order status')
    })

    it('never leaves the crew invalid', () => {
        const source = fanIn()
        for (const candidate of enumerateOperators(source, ['check_order'])) {
            const { ir } = applyOperator(source, candidate, ['check_order'])
            expect(normalizeCrewIR(ir, ['check_order']).validation.valid).toBe(true)
        }
    })
})

describe('operator search', () => {
    const evidence = (patch: Record<string, any> = {}) => RunEvidenceType.parse(patch)

    it('enumerates only legal operators', () => {
        const candidates = enumerateOperators(fanIn(), ['check_order'])
        expect(candidates.length).toBeGreaterThan(0)
        expect(candidates.some((item) => item.type === 'merge_tasks')).toBe(true)
        expect(candidates.some((item) => item.type === 'remove_router')).toBe(false)
    })

    it('prioritises binding a tool the suite required but no agent holds', () => {
        const ranked = rankOperators(
            fanIn(),
            ['check_order'],
            evidence({ missingToolCalls: ['check_order'], unboundRequiredTools: ['check_order'], quality: 0.4 })
        )
        expect(ranked[0].operator.type).toBe('bind_tool')
        expect(ranked[0].operator.tool).toBe('check_order')
    })

    it('does not propose more binding when the tool is bound but was never reached', () => {
        // The first real run burned two rounds on exactly this: the tools were
        // bound, but an upstream node dropped the request before reaching them.
        const source = fanIn()
        source.agents[0].tools = ['check_order']
        const ranked = rankOperators(source, ['check_order'], evidence({ missingToolCalls: ['check_order'], quality: 0.35 }))
        const bind = ranked.find((item) => item.operator.type === 'bind_tool')
        expect(bind && bind.score).toBeLessThan(0)
        expect(['remove_task', 'merge_tasks']).toContain(ranked[0].operator.type)
    })

    it('never offers a router agent a tool', () => {
        const routed = applyOperator(fanIn(), operator({ type: 'add_router' }), ['check_order']).ir
        const offered = enumerateOperators(routed, ['check_order']).filter(
            (item) => item.type === 'bind_tool' && item.agentIds[0] === routed.routerAgentId
        )
        expect(offered).toEqual([])
        expect(() =>
            applyOperator(routed, operator({ type: 'bind_tool', agentIds: [routed.routerAgentId], tool: 'check_order' }), ['check_order'])
        ).toThrow(OperatorNotApplicable)
    })

    it('never re-proposes an operator the search already measured', () => {
        const source = fanIn()
        const first = rankOperators(source, ['check_order'], evidence({ quality: 0.9, passRate: 1 }))
        const tried = [first[0].operator].map((item) =>
            [item.type, [...item.taskIds].sort().join('|'), [...item.agentIds].sort().join('|'), item.tool]
                .filter((part) => part !== '')
                .join(':')
        )
        const second = rankOperators(source, ['check_order'], evidence({ quality: 0.9, passRate: 1, triedOperators: tried }))
        expect(second.length).toBe(first.length - 1)
        expect(second.map((item) => item.description)).not.toContain(first[0].description)
    })

    it('buys efficiency once the baseline is healthy', () => {
        const ranked = rankOperators(fanIn(), [], evidence({ quality: 0.9, passRate: 1, failureRate: 0 }))
        expect(ranked[0].operator.type).toBe('merge_tasks')
    })

    it('tolerates partial evidence instead of crashing mid-search', () => {
        // A first round holds only coarse metrics; missing arrays must read as
        // "nothing observed", not as an undefined dereference.
        expect(() => rankOperators(fanIn(), ['check_order'], { quality: 0.5, passRate: 0.5 } as any)).not.toThrow()
        expect(rankOperators(fanIn(), ['check_order']).length).toBeGreaterThan(0)
    })

    it('random selection is reproducible for a given seed', () => {
        const source = fanIn()
        const first = selectOperators(source, ['check_order'], evidence(), 'random', 3, 42)
        const second = selectOperators(source, ['check_order'], evidence(), 'random', 3, 42)
        expect(first.map((item) => item.description)).toEqual(second.map((item) => item.description))
    })

    it('v2 discards selections whose operator type contradicts the index', () => {
        const source = fanIn()
        source.agents[0].tools = ['check_order']
        const legal = rankOperators(source, ['check_order'], evidence())
        expect(legal.some((item) => item.operator.type === 'unbind_tool')).toBe(true)
        const unbindIndex = legal.findIndex((item) => item.operator.type === 'unbind_tool')
        const otherIndex = legal.findIndex((item) => item.operator.type !== 'unbind_tool')
        const { accepted, rejected } = checkSelections(legal, [
            { index: unbindIndex, operatorType: 'bind_tool' },
            { index: otherIndex, operatorType: legal[otherIndex].operator.type },
            { index: 999, operatorType: 'merge_tasks' }
        ])
        expect(accepted.map((item) => item.index)).toEqual([otherIndex])
        expect(rejected).toHaveLength(2)
        expect(rejected[0].reason).toContain('unbind_tool')
    })

    it('spells out that unbinding removes the ability to call a tool', () => {
        const effect = describeOperatorEffect(operator({ type: 'unbind_tool', agentIds: ['a_agent'], tool: 'check_order' }))
        expect(effect).toContain('LOSES')
        expect(effect).toContain('check_order')
    })

    it('greedy selection keeps the candidate set diverse', () => {
        const chosen = selectOperators(fanIn(), ['check_order'], evidence({ quality: 0.9, passRate: 1 }), 'greedy', 3)
        const families = new Set(chosen.map((item) => item.operator.type))
        expect(families.size).toBeGreaterThan(1)
    })
})
