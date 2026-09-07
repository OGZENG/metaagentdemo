import { describe, expect, it } from '@jest/globals'
import { AssertionType } from './studioSchemas'
import { combineScores, evaluateAssertion, evaluateAssertions, rubricScore, summarizeAssertions } from './assertions'

const assertion = (patch: Record<string, any>) =>
    AssertionType.parse({ id: 'a1', description: 'test assertion', type: 'output_contains', ...patch })

const okCall = (tool: string, input: Record<string, any> = {}, data: Record<string, any> = {}) => ({
    tool,
    toolInput: input,
    toolOutput: JSON.stringify({ ok: true, status: 'ok', data })
})

const failedCall = (tool: string, input: Record<string, any> = {}) => ({
    tool,
    toolInput: input,
    toolOutput: JSON.stringify({ ok: false, status: 'not_found', message: 'no record' })
})

describe('assertions', () => {
    describe('tool_called', () => {
        it('passes when the tool was called with the expected arguments', () => {
            const result = evaluateAssertion(
                assertion({ type: 'tool_called', tool: 'check_order', withArgs: [{ key: 'orderId', value: 'A-1187' }] }),
                { output: '', toolCalls: [okCall('check_order', { orderId: 'a-1187' })] }
            )
            expect(result.passed).toBe(true)
        })

        it('fails when the arguments do not match', () => {
            const result = evaluateAssertion(
                assertion({ type: 'tool_called', tool: 'check_order', withArgs: [{ key: 'orderId', value: 'A-1187' }] }),
                { output: '', toolCalls: [okCall('check_order', { orderId: 'B-9' })] }
            )
            expect(result.passed).toBe(false)
        })

        it('accepts a free-text argument that contains the expected key', () => {
            // The environment matches a fixture keyed on `zx-500` against this
            // exact query. Holding the assertion to equality made every
            // tool_called assertion on a search tool unsatisfiable.
            const result = evaluateAssertion(
                assertion({ type: 'tool_called', tool: 'catalog', withArgs: [{ key: 'query', value: 'zx-500' }] }),
                { output: '', toolCalls: [okCall('catalog', { query: 'ZX-500 headset multipoint pairing' })] }
            )
            expect(result.passed).toBe(true)
        })

        it('keeps numeric arguments exact so 50 is not satisfied by 500', () => {
            const result = evaluateAssertion(
                assertion({ type: 'tool_called', tool: 'refund', withArgs: [{ key: 'amount', value: '50' }] }),
                { output: '', toolCalls: [okCall('refund', { amount: '500' })] }
            )
            expect(result.passed).toBe(false)
        })

        it('fails when the tool was never called', () => {
            const result = evaluateAssertion(assertion({ type: 'tool_called', tool: 'check_order' }), { output: '', toolCalls: [] })
            expect(result.passed).toBe(false)
        })
    })

    it('tool_not_called fails as soon as the tool appears in the trace', () => {
        const result = evaluateAssertion(assertion({ type: 'tool_not_called', tool: 'issue_refund' }), {
            output: '',
            toolCalls: [okCall('issue_refund')]
        })
        expect(result.passed).toBe(false)
    })

    it('tool_succeeded rejects a call that returned ok:false', () => {
        const result = evaluateAssertion(assertion({ type: 'tool_succeeded', tool: 'check_order' }), {
            output: '',
            toolCalls: [failedCall('check_order')]
        })
        expect(result.passed).toBe(false)
    })

    it('output_contains matches case-insensitively', () => {
        const result = evaluateAssertion(assertion({ type: 'output_contains', anyOf: ['Escalated to a human'] }), {
            output: 'This was ESCALATED TO A HUMAN agent.',
            toolCalls: []
        })
        expect(result.passed).toBe(true)
    })

    it('output_matches reports an invalid pattern instead of throwing', () => {
        const result = evaluateAssertion(assertion({ type: 'output_matches', pattern: '([unclosed' }), {
            output: 'anything',
            toolCalls: []
        })
        expect(result.passed).toBe(false)
        expect(result.detail).toContain('Invalid regular expression')
    })

    describe('grounded', () => {
        it('fails when the reply claims a status the environment never returned', () => {
            const result = evaluateAssertion(
                assertion({ type: 'grounded', tool: 'check_order', forbidden: ['has shipped', 'delivered'] }),
                { output: 'Your order has shipped and will arrive Friday.', toolCalls: [failedCall('check_order')] }
            )
            expect(result.passed).toBe(false)
        })

        it('passes once the tool actually returned data', () => {
            const result = evaluateAssertion(assertion({ type: 'grounded', tool: 'check_order', forbidden: ['has shipped'] }), {
                output: 'Your order has shipped.',
                toolCalls: [okCall('check_order', {}, { status: 'shipped' })]
            })
            expect(result.passed).toBe(true)
        })

        it('passes when no claim is made even though the tool failed', () => {
            const result = evaluateAssertion(assertion({ type: 'grounded', tool: 'check_order', forbidden: ['has shipped'] }), {
                output: 'I could not retrieve the order status right now.',
                toolCalls: [failedCall('check_order')]
            })
            expect(result.passed).toBe(true)
        })
    })

    describe('summarizeAssertions', () => {
        it('weights severities and flags critical violations', () => {
            const results = evaluateAssertions(
                [
                    assertion({ id: 'c', type: 'output_contains', anyOf: ['present'], severity: 'critical' }),
                    assertion({ id: 'm', type: 'output_contains', anyOf: ['absent'], severity: 'minor' })
                ],
                { output: 'the phrase present is here', toolCalls: [] }
            )
            const summary = summarizeAssertions(results)
            expect(summary.passed).toBe(1)
            expect(summary.criticalViolation).toBe(false)
            expect(Math.round(summary.score)).toBe(75)
        })

        it('scores 100 when no assertion was defined so the rubric decides alone', () => {
            expect(summarizeAssertions([]).score).toBe(100)
        })

        it('marks a failed critical assertion as a violation', () => {
            const results = evaluateAssertions([assertion({ id: 'c', type: 'output_contains', anyOf: ['absent'], severity: 'critical' })], {
                output: 'nothing relevant',
                toolCalls: []
            })
            expect(summarizeAssertions(results).criticalViolation).toBe(true)
        })
    })

    it('combines hard and soft scores only when assertions exist', () => {
        expect(combineScores(100, 50, true)).toBeCloseTo(80)
        expect(combineScores(100, 50, false)).toBe(50)
    })

    it('weights the rubric dimensions', () => {
        expect(rubricScore({ completeness: 100, correctness: 100, safety: 100, usefulness: 100 })).toBeCloseTo(100)
        expect(rubricScore({ completeness: 0, correctness: 0, safety: 100, usefulness: 0 })).toBeCloseTo(25)
    })
})
