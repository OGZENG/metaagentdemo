import { describe, expect, it } from '@jest/globals'
import {
    AcceptanceScenarioType,
    AssertionType,
    CrewAgentType,
    CrewRouteType,
    CrewTaskType,
    MockToolFixtureType,
    StudioContractType,
    ToolSpecType
} from './studioSchemas'
import { buildToolFunc } from './mockToolCompiler'

/**
 * Shape tolerance.
 *
 * A real generation was rejected with hundreds of `expected array, received
 * object` issues because the model returned `match` and `result` as maps. A map
 * is the natural representation, the whole call costs minutes, and the
 * distinction carries no meaning — so both shapes are accepted.
 */
describe('lenient parsing of model output', () => {
    describe('key/value fields', () => {
        it('accepts a map where a pair array is declared', () => {
            const fixture = MockToolFixtureType.parse({
                match: { order_id: 'A-1187' },
                result: { status: 'shipped', carrier: 'DHL' }
            })
            expect(fixture.match).toEqual([{ key: 'order_id', value: 'A-1187' }])
            expect(fixture.result).toEqual([
                { key: 'status', value: 'shipped' },
                { key: 'carrier', value: 'DHL' }
            ])
        })

        it('still accepts the declared pair array', () => {
            const fixture = MockToolFixtureType.parse({ match: [{ key: 'order_id', value: 'A-1187' }] })
            expect(fixture.match).toEqual([{ key: 'order_id', value: 'A-1187' }])
        })

        it('stringifies non-string values so numbers and booleans survive', () => {
            const fixture = MockToolFixtureType.parse({ match: { amount: 450, urgent: true } })
            expect(fixture.match).toEqual([
                { key: 'amount', value: '450' },
                { key: 'urgent', value: 'true' }
            ])
        })

        it('accepts an array of single-entry objects', () => {
            const fixture = MockToolFixtureType.parse({ match: [{ order_id: 'A-1187' }, { locale: 'en' }] })
            expect(fixture.match).toEqual([
                { key: 'order_id', value: 'A-1187' },
                { key: 'locale', value: 'en' }
            ])
        })

        it('keeps every field of a multi-field record, not just the first', () => {
            // Collapsing to the first pair emptied the simulated world: an order
            // lookup returned nothing but the id it had been given.
            const fixture = MockToolFixtureType.parse({
                match: [{ order_id: 'ORD-1001' }],
                result: [{ order_id: 'ORD-1001', status: 'shipped', carrier: 'DHL', eta: '2026-08-28' }]
            })
            expect(fixture.result).toEqual([
                { key: 'order_id', value: 'ORD-1001' },
                { key: 'status', value: 'shipped' },
                { key: 'carrier', value: 'DHL' },
                { key: 'eta', value: '2026-08-28' }
            ])
        })

        it('preserves a nested value as JSON rather than dropping it', () => {
            const fixture = MockToolFixtureType.parse({ result: [{ product: { name: 'ZX-500', multipoint: true } }] })
            expect(fixture.result).toEqual([{ key: 'product', value: '{"name":"ZX-500","multipoint":true}' }])
        })

        it('accepts `name` as an alias for `key`', () => {
            const fixture = MockToolFixtureType.parse({ match: [{ name: 'order_id', value: 'A-1187' }] })
            expect(fixture.match).toEqual([{ key: 'order_id', value: 'A-1187' }])
        })

        it('treats `name` as a data field when the object is a record, not a pair', () => {
            // A catalog fixture came back as `{ name, multipoint, price }`. Reading
            // `name` as a pair label produced `{ key: 'Zephyr ZX-500', value: '' }`
            // and silently dropped every specification.
            const fixture = MockToolFixtureType.parse({
                result: [{ name: 'Zephyr ZX-500 Wireless Headset', multipoint: true, price: 199, stock: 'in_stock' }]
            })
            expect(fixture.result).toEqual([
                { key: 'name', value: 'Zephyr ZX-500 Wireless Headset' },
                { key: 'multipoint', value: 'true' },
                { key: 'price', value: '199' },
                { key: 'stock', value: 'in_stock' }
            ])
        })

        it('still reads a genuine two-field pair as a pair', () => {
            expect(MockToolFixtureType.parse({ match: [{ name: 'order_id', value: 'A-1187' }] }).match).toEqual([
                { key: 'order_id', value: 'A-1187' }
            ])
            expect(MockToolFixtureType.parse({ match: [{ key: 'order_id', value: 'A-1187' }] }).match).toEqual([
                { key: 'order_id', value: 'A-1187' }
            ])
        })

        it('accepts an error object where a message string is declared', () => {
            expect(MockToolFixtureType.parse({ error: { message: 'The order service timed out.' } }).error).toBe(
                'The order service timed out.'
            )
        })
    })

    describe('string lists', () => {
        it('accepts a bare string where a list is declared', () => {
            expect(AssertionType.parse({ id: 'a1', type: 'output_contains', description: 'x', anyOf: 'shipped' }).anyOf).toEqual([
                'shipped'
            ])
        })

        it('accepts a map of strings', () => {
            const agent = CrewAgentType.parse({
                id: 'order_agent',
                name: 'Order',
                role: 'specialist',
                goal: 'g',
                guardrails: { first: 'never guess', second: 'always escalate' }
            })
            expect(agent.guardrails).toEqual(['never guess', 'always escalate'])
        })

        it('normalises a scenario written with object-shaped lists', () => {
            const scenario = AcceptanceScenarioType.parse({
                id: 'case_1',
                title: 'Known order',
                category: 'core',
                input: 'Where is A-1187?',
                expectedBehavior: 'Looks the order up.',
                requiredTools: ['check_order'],
                mustNot: { a: 'invent a date' }
            })
            expect(scenario.expectedBehavior).toEqual(['Looks the order up.'])
            expect(scenario.mustNot).toEqual(['invent a date'])
        })

        it('normalises contract lists', () => {
            const contract = StudioContractType.parse({
                workflowName: 'Desk',
                summary: 'x',
                successCriteria: 'Answer completely.',
                constraints: { one: 'never invent an order status' }
            })
            expect(contract.successCriteria).toEqual(['Answer completely.'])
            expect(contract.constraints).toEqual(['never invent an order status'])
        })
    })

    describe('over-strict limits', () => {
        it('truncates a long routing condition instead of rejecting the generation', () => {
            // A 340-character condition threw away a four-minute crew design.
            const long = 'x'.repeat(900)
            const crew = CrewRouteType.parse({ taskId: 'handle_order', when: long })
            expect(crew.when.length).toBeLessThanOrEqual(600)
            expect(crew.when.endsWith('…')).toBe(true)
        })

        it('maps an invented model tier onto the default rather than failing', () => {
            const base = { id: 'a', name: 'A', role: 'specialist', goal: 'g' }
            expect(CrewAgentType.parse({ ...base, modelTier: 'medium' }).modelTier).toBe('default')
            expect(CrewAgentType.parse({ ...base, modelTier: 'MINI' }).modelTier).toBe('cheap')
            expect(CrewAgentType.parse({ ...base, modelTier: 'something-new' }).modelTier).toBe('default')
            expect(CrewAgentType.parse({ ...base, modelTier: 'cheap' }).modelTier).toBe('cheap')
        })

        it('truncates a long task description', () => {
            const task = CrewTaskType.parse({
                id: 'do_it',
                name: 'Do it',
                description: 'y'.repeat(4000),
                expectedOutput: 'z'.repeat(4000),
                agentId: 'a',
                outputKey: 'result'
            })
            expect(task.description.length).toBeLessThanOrEqual(1200)
            expect(task.expectedOutput.length).toBeLessThanOrEqual(600)
        })
    })

    it('compiles a map-shaped fixture into working tool code', async () => {
        const spec = ToolSpecType.parse({
            name: 'check_order',
            label: 'Check order',
            description: 'Look up an order.',
            params: [{ name: 'order_id', type: 'string', description: 'id', required: true }],
            fixtures: [{ match: { order_id: 'A-1187' }, result: { status: 'shipped' } }]
        })
        const code = buildToolFunc(spec)
        // eslint-disable-next-line no-new-func
        const run = new Function('$order_id', `return (async () => {${code}})()`)
        expect(JSON.parse(await run('A-1187'))).toMatchObject({ ok: true, data: { status: 'shipped' } })
    })
})
