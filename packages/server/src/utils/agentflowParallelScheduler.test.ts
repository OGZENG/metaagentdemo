import { getParallelExecutionBatch, mergeParallelStates } from './agentflowParallelScheduler'

const node = (id: string, updates: any[] = [], extraInputs: Record<string, any> = {}) => ({
    id,
    data: {
        name: 'agentAgentflow',
        inputs: { agentUpdateState: updates, ...extraInputs }
    }
})

describe('agentflowParallelScheduler', () => {
    it('selects ready sibling agents with disjoint state writes', () => {
        const nodes = [node('a', [{ key: 'answerA' }]), node('b', [{ key: 'answerB' }])]
        const edges = [
            { source: 'start', target: 'a' },
            { source: 'start', target: 'b' },
            { source: 'a', target: 'join' },
            { source: 'b', target: 'join' }
        ]
        const queue = [{ nodeId: 'a' }, { nodeId: 'b' }]

        expect(getParallelExecutionBatch(queue, nodes, edges, 4)).toEqual(queue)
    })

    it('falls back to one node for state conflicts, memory, tools, or different frontiers', () => {
        const edges = [
            { source: 'start', target: 'a' },
            { source: 'start', target: 'b' },
            { source: 'a', target: 'join' },
            { source: 'b', target: 'otherJoin' }
        ]
        const queue = [{ nodeId: 'a' }, { nodeId: 'b' }]

        expect(getParallelExecutionBatch(queue, [node('a'), node('b')], edges, 4)).toEqual([queue[0]])
        expect(
            getParallelExecutionBatch(
                queue,
                [node('a', [{ key: 'same' }]), node('b', [{ key: 'same' }])],
                edges.map((edge) => (edge.target === 'otherJoin' ? { ...edge, target: 'join' } : edge)),
                4
            )
        ).toEqual([queue[0]])
        expect(
            getParallelExecutionBatch(
                queue,
                [node('a'), node('b', [], { agentEnableMemory: true })],
                edges.map((edge) => (edge.target === 'otherJoin' ? { ...edge, target: 'join' } : edge)),
                4
            )
        ).toEqual([queue[0]])
        expect(
            getParallelExecutionBatch(
                queue,
                [node('a'), node('b', [], { agentTools: [{ name: 'writer' }] })],
                edges.map((edge) => (edge.target === 'otherJoin' ? { ...edge, target: 'join' } : edge)),
                4
            )
        ).toEqual([queue[0]])
    })

    it('merges independent state deltas and rejects conflicting writes', () => {
        const base = { normalized: 'question', unchanged: 1 }
        expect(
            mergeParallelStates(base, [
                { ...base, direct: 'A' },
                { ...base, verification: 'B' }
            ])
        ).toEqual({ normalized: 'question', unchanged: 1, direct: 'A', verification: 'B' })

        expect(() =>
            mergeParallelStates(base, [
                { ...base, answer: 'A' },
                { ...base, answer: 'B' }
            ])
        ).toThrow('Parallel Flow State conflict on key "answer"')
    })
})
