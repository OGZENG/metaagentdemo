import { describe, expect, it } from '@jest/globals'
import { ToolSpecType } from './studioSchemas'
import { buildToolFunc, buildToolSchema, compileMockTool, describeToolEnvironment, validateToolCoverage } from './mockToolCompiler'

const orderTool = ToolSpecType.parse({
    name: 'check_order',
    label: 'Check order',
    description: 'Look up an order by its identifier.',
    params: [
        { name: 'order_id', type: 'string', description: 'The order identifier', required: true },
        { name: 'verbose', type: 'boolean', description: 'Include the full history', required: false }
    ],
    fixtures: [
        { match: [{ key: 'order_id', value: 'A-1187' }], result: [{ key: 'status', value: 'shipped' }] },
        { match: [{ key: 'order_id', value: 'B-2000' }], error: 'The order service timed out.' }
    ],
    fallbackStatus: 'not_found',
    fallbackMessage: 'No such order exists.'
})

/**
 * Runs generated tool code exactly the way the Flowise sandbox does: the body
 * is wrapped in an async function and arguments arrive as `$name` globals.
 */
const runToolFunc = (code: string, args: Record<string, any>) => {
    const names = Object.keys(args).map((key) => `$${key}`)
    const values = Object.values(args)
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `return (async () => {${code}})()`)
    return factory(...values)
}

describe('mock tool compiler', () => {
    it('emits a Flowise-compatible parameter schema', () => {
        expect(JSON.parse(buildToolSchema(orderTool))).toEqual([
            { property: 'order_id', type: 'string', description: 'The order identifier', required: true },
            { property: 'verbose', type: 'boolean', description: 'Include the full history', required: false }
        ])
    })

    it('returns fixture data for a matching argument', async () => {
        const result = JSON.parse(await runToolFunc(buildToolFunc(orderTool), { order_id: 'A-1187' }))
        expect(result).toMatchObject({ ok: true, status: 'ok', data: { status: 'shipped' } })
    })

    it('matches case-insensitively and ignores surrounding whitespace', async () => {
        const result = JSON.parse(await runToolFunc(buildToolFunc(orderTool), { order_id: '  a-1187 ' }))
        expect(result.ok).toBe(true)
    })

    it('injects the declared failure for a fault fixture', async () => {
        const result = JSON.parse(await runToolFunc(buildToolFunc(orderTool), { order_id: 'B-2000' }))
        expect(result).toMatchObject({ ok: false, status: 'error', message: 'The order service timed out.' })
    })

    it('falls back to not_found for an unknown record', async () => {
        const result = JSON.parse(await runToolFunc(buildToolFunc(orderTool), { order_id: 'Z-9999' }))
        expect(result).toMatchObject({ ok: false, status: 'not_found', message: 'No such order exists.' })
    })

    it('tolerates an omitted optional argument', async () => {
        // The sandbox only defines `$name` for arguments the model actually sent.
        const result = JSON.parse(await runToolFunc(buildToolFunc(orderTool), { order_id: 'A-1187' }))
        expect(result.args.verbose).toBeUndefined()
    })

    describe('matching a free-text argument', () => {
        const catalogTool = ToolSpecType.parse({
            name: 'lookup_product_catalog',
            label: 'Catalog',
            description: 'Search the product catalogue.',
            params: [{ name: 'query', type: 'string', description: 'Search terms or SKU', required: true }],
            fixtures: [
                { match: [{ key: 'query', value: 'zx-500' }], result: [{ key: 'multipoint', value: 'supported' }] },
                { match: [{ key: 'query', value: 'zx-500 pro' }], result: [{ key: 'multipoint', value: 'supported, 3 devices' }] },
                { match: [], result: [{ key: 'note', value: 'generic catalog result' }] }
            ],
            fallbackStatus: 'not_found',
            fallbackMessage: 'No such product.'
        })

        it('matches a fixture key contained in the agent free-text query', async () => {
            // The real run failed here: the agent sent a whole sentence and the
            // exact-equality matcher returned not_found for every lookup.
            const result = JSON.parse(
                await runToolFunc(buildToolFunc(catalogTool), { query: 'ZX-500 wireless headset Bluetooth multipoint support' })
            )
            expect(result.ok).toBe(true)
            expect(result.data.multipoint).toBe('supported')
        })

        it('prefers the most specific fixture when several are contained', async () => {
            const result = JSON.parse(await runToolFunc(buildToolFunc(catalogTool), { query: 'does the ZX-500 Pro support multipoint?' }))
            expect(result.data.multipoint).toBe('supported, 3 devices')
        })

        it('still prefers an exact match over a longer containment match', async () => {
            const result = JSON.parse(await runToolFunc(buildToolFunc(catalogTool), { query: 'zx-500' }))
            expect(result.data.multipoint).toBe('supported')
        })

        it('uses a key-less fixture only when nothing else matches', async () => {
            const result = JSON.parse(await runToolFunc(buildToolFunc(catalogTool), { query: 'something entirely unrelated' }))
            expect(result.ok).toBe(true)
            expect(result.data.note).toBe('generic catalog result')
        })

        it('falls back when there is no key-less fixture either', async () => {
            const strict = ToolSpecType.parse({ ...catalogTool, fixtures: catalogTool.fixtures.slice(0, 2) })
            const result = JSON.parse(await runToolFunc(buildToolFunc(strict), { query: 'something entirely unrelated' }))
            expect(result).toMatchObject({ ok: false, status: 'not_found' })
        })
    })

    describe('fixtures the model wrote loosely', () => {
        it('matches when the model used the value as the key', async () => {
            // `{ "zx-500": "zx-500" }` instead of `{ "sku": "zx-500" }` made every
            // fixture unreachable, so the tool answered "not found" to everything.
            const spec = ToolSpecType.parse({
                name: 'escalate',
                label: 'Escalate',
                description: 'Escalate a case.',
                params: [{ name: 'reason', type: 'string', description: 'why', required: true }],
                fixtures: [{ match: [{ key: 'refund', value: 'refund' }], result: [{ key: 'ticket', value: 'ESC-1' }] }]
            })
            const result = JSON.parse(await runToolFunc(buildToolFunc(spec), { reason: 'refund above threshold' }))
            expect(result.ok).toBe(true)
            expect(result.data.ticket).toBe('ESC-1')
        })

        it('prefers a successful catch-all over a failing one', async () => {
            const spec = ToolSpecType.parse({
                name: 'notify',
                label: 'Notify',
                description: 'Notify someone.',
                params: [{ name: 'message', type: 'string', description: 'text', required: true }],
                fixtures: [
                    { match: [], error: 'Service outage' },
                    { match: [], result: [{ key: 'delivered', value: 'true' }] }
                ]
            })
            const result = JSON.parse(await runToolFunc(buildToolFunc(spec), { message: 'anything at all' }))
            expect(result.ok).toBe(true)
            expect(result.data.delivered).toBe('true')
        })

        it('still uses a failing catch-all when it is the only one', async () => {
            const spec = ToolSpecType.parse({
                name: 'notify',
                label: 'Notify',
                description: 'Notify someone.',
                params: [{ name: 'message', type: 'string', description: 'text', required: true }],
                fixtures: [{ match: [], error: 'Service outage' }]
            })
            const result = JSON.parse(await runToolFunc(buildToolFunc(spec), { message: 'anything' }))
            expect(result).toMatchObject({ ok: false, status: 'error', message: 'Service outage' })
        })

        it('does not let a stray key match an unrelated call', async () => {
            const spec = ToolSpecType.parse({
                name: 'escalate',
                label: 'Escalate',
                description: 'Escalate a case.',
                params: [{ name: 'reason', type: 'string', description: 'why', required: true }],
                fixtures: [{ match: [{ key: 'refund', value: 'refund' }], result: [{ key: 'ticket', value: 'ESC-1' }] }],
                fallbackStatus: 'not_found',
                fallbackMessage: 'No route.'
            })
            const result = JSON.parse(await runToolFunc(buildToolFunc(spec), { reason: 'password reset' }))
            expect(result).toMatchObject({ ok: false, status: 'not_found' })
        })
    })

    it('produces a stable hash for an unchanged specification', () => {
        expect(compileMockTool(orderTool).specHash).toBe(compileMockTool(orderTool).specHash)
        expect(compileMockTool(orderTool).specHash).not.toBe(
            compileMockTool(ToolSpecType.parse({ ...orderTool, description: 'changed' })).specHash
        )
    })

    it('describes the environment for agent prompts', () => {
        expect(describeToolEnvironment([orderTool])).toContain('check_order(order_id: string, verbose: boolean (optional))')
        expect(describeToolEnvironment([])).toContain('No simulated tools')
    })

    it('reports acceptance cases that require an undeclared tool', () => {
        expect(validateToolCoverage([orderTool], ['check_order', 'issue_refund'])).toEqual(['issue_refund'])
    })
})
