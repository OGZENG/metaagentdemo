import { describe, expect, it } from '@jest/globals'
import { AssertionType, ToolSpecType } from './studioSchemas'
import { repairAssertions } from './testWorldValidator'
import { applyFactVerdicts, evaluateAssertions, factChecksFor } from './assertions'

const assertion = (patch: Record<string, any>) =>
    AssertionType.parse({ id: 'a1', description: 'test assertion', type: 'tool_called', ...patch })

const tools = [
    ToolSpecType.parse({
        name: 'validate_policy_number',
        label: 'Validate',
        description: 'Validate a policy',
        params: [{ name: 'policy_number', type: 'string', description: 'policy', required: true }],
        fixtures: [
            { match: [{ key: 'policy_number', value: 'PN-1001' }], result: [{ key: 'status', value: 'active' }] },
            { match: [{ key: 'policy_number', value: 'PN-9009' }], error: 'timeout' }
        ]
    }),
    ToolSpecType.parse({
        name: 'check_policy_coverage',
        label: 'Coverage',
        description: 'Check coverage',
        params: [{ name: 'policy_number', type: 'string', description: 'policy', required: true }],
        fixtures: [{ match: [{ key: 'policy_number', value: 'POL-1001' }], result: [{ key: 'covered', value: 'yes' }] }]
    })
]
const design = { tools }

describe('repairAssertions', () => {
    it('drops a tool argument that the case contradicts', () => {
        const { assertions, changes } = repairAssertions(
            'c1',
            'I have policy PN-1001 and a windshield crack.',
            [assertion({ tool: 'validate_policy_number', withArgs: [{ key: 'policy_number', value: 'POL-1001' }] })],
            design
        )
        expect(assertions[0].withArgs).toEqual([])
        expect(changes[0].action).toBe('drop_argument')
    })

    it('keeps a tool argument stated in the case', () => {
        const { assertions, changes } = repairAssertions(
            'c1',
            'I have policy PN-1001.',
            [assertion({ tool: 'validate_policy_number', withArgs: [{ key: 'policy_number', value: 'PN-1001' }] })],
            design
        )
        expect(assertions[0].withArgs).toHaveLength(1)
        expect(changes).toHaveLength(0)
    })

    it('turns an unreachable success requirement into a required call', () => {
        const { assertions, changes } = repairAssertions(
            'c1',
            'Policy PN-1001, please check coverage.',
            [assertion({ type: 'tool_succeeded', tool: 'check_policy_coverage' })],
            design
        )
        expect(assertions[0].type).toBe('tool_called')
        expect(changes[0].action).toBe('require_call_only')
    })

    it('keeps a reachable success requirement', () => {
        const { assertions } = repairAssertions(
            'c1',
            'Policy PN-1001.',
            [assertion({ type: 'tool_succeeded', tool: 'validate_policy_number' })],
            design
        )
        expect(assertions[0].type).toBe('tool_succeeded')
    })

    it('drops a pattern that cannot be compiled, but keeps PCRE inline flags', () => {
        const { assertions } = repairAssertions(
            'c1',
            'x',
            [
                assertion({ id: 'bad', type: 'output_matches', pattern: '([unclosed' }),
                assertion({ id: 'good', type: 'output_matches', pattern: '(?i)total cost' })
            ],
            design
        )
        expect(assertions.map((item) => item.id)).toEqual(['good'])
    })
})

describe('semantic fact checks', () => {
    const context = { output: 'No payout amount has been promised. Classified as delivery inquiry.', toolCalls: [] }
    const assertions = [
        assertion({ id: 'contains', type: 'output_contains', anyOf: ['Classified as delivery_question'] }),
        assertion({ id: 'forbidden', type: 'output_not_contains', anyOf: ['payout amount'] }),
        assertion({ id: 'literal-ok', type: 'output_contains', anyOf: ['delivery inquiry'] })
    ]

    it('hands only ambiguous phrase results to the grader', () => {
        const results = evaluateAssertions(assertions, context)
        const checks = factChecksFor(assertions, results, context)
        expect(checks.map((check) => [check.id, check.kind])).toEqual([
            ['contains', 'conveys'],
            ['forbidden', 'affirms']
        ])
    })

    it('applies the verdicts in the right direction', () => {
        const results = evaluateAssertions(assertions, context)
        const checks = factChecksFor(assertions, results, context)
        const judged = applyFactVerdicts(results, checks, [
            { id: 'contains', holds: true },
            { id: 'forbidden', holds: false }
        ])
        expect(judged.every((result) => result.passed)).toBe(true)
        const violated = applyFactVerdicts(results, checks, [{ id: 'forbidden', holds: true }])
        expect(violated.find((result) => result.id === 'forbidden')?.passed).toBe(false)
    })
})
