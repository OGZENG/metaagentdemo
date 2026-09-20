/* eslint-disable no-console */
/**
 * Creates the demo connector tools a deployed crew can be bound to.
 *
 * Workflow Autopilot designs and measures a crew against *simulated* tools it
 * generates itself. At deployment each declared tool can instead be bound to a
 * real workspace tool. These eight stand for the shop's own systems: same
 * parameter names as the simulated ones, an answer table embedded in the tool,
 * and a `source` field on every reply so a demo can show which system answered.
 *
 * They are connectors pointed at demo data, not live systems — swap the table
 * in any of them for a real API call once that system exists.
 *
 *   node packages/server/scripts/create-demo-connector-tools.js <workspaceId>
 *   node packages/server/scripts/create-demo-connector-tools.js --list
 *
 * The workspace id can also come from AUTOPILOT_DEMO_WORKSPACE_ID. Re-running
 * is safe: tools that already exist in that workspace are left untouched.
 */

const os = require('os')
const path = require('path')
const { randomUUID } = require('crypto')

const sqlite3 = require(path.join(__dirname, '..', 'node_modules', 'sqlite3'))

const DATABASE_PATH = process.env.DATABASE_PATH
    ? path.join(process.env.DATABASE_PATH, 'database.sqlite')
    : path.join(os.homedir(), '.flowise', 'database.sqlite')
const COLOR = '#1B6E3C'

/** An argument only exists in the sandbox when the model sent it. */
const arg = (name) => `typeof $${name} === 'undefined' || $${name} === null ? '' : String($${name})`

/** A lookup connector: match the query against an embedded table. */
const lookupFunc = (system, queryParam, records, fallback) => `/* ${system} — demo connector, replace the table with a real API call */
const QUERY = (${arg(queryParam)}).trim().toLowerCase()
const RECORDS = ${JSON.stringify(records, null, 4)}

const hit = RECORDS.find((record) => record.keys.some((key) => QUERY === key || QUERY.includes(key)))
if (!hit) {
    return JSON.stringify({ ok: false, status: 'not_found', source: '${system}', message: ${JSON.stringify(fallback)}, query: QUERY })
}
return JSON.stringify({ ok: true, status: 'ok', source: '${system}', data: hit.data })
`

const TOOLS = [
    {
        name: 'shop_support_classifier',
        description: 'Support intent classifier of the customer-support platform. Classifies an incoming customer message into a category.',
        params: [['customer_message', 'The full customer message to classify']],
        func: `/* shop-support-platform — demo connector, replace with a real API call */
const MESSAGE = (${arg('customer_message')}).trim()
const lower = MESSAGE.toLowerCase()

const orderId = (MESSAGE.match(/ORD-\\d+/i) || [])[0] || ''
let category = 'other support intent'
if (orderId) category = 'order lookup'
else if (/(refund|money back|reimburse)/.test(lower)) category = 'refund request'
else if (/(deliver|shipping|ship|tracking)/.test(lower)) category = 'delivery question'
else if (/(warranty|return policy|policy|guarantee)/.test(lower)) category = 'policy question'
else if (/(broken|damaged|complain|angry|terrible)/.test(lower)) category = 'complaint'
else if (/(zx-500|hd-200|pl-200|px-20|arc-7|spec|compatib|price)/.test(lower)) category = 'product question'

return JSON.stringify({
    ok: true,
    status: 'ok',
    source: 'shop-support-platform',
    data: { category, order_id: orderId, needs_order_lookup: Boolean(orderId), classified_at: new Date().toISOString() }
})
`
    },
    {
        name: 'shop_product_catalog',
        description: 'Product catalogue service of the shop. Returns specs, price, availability and warranty for a product.',
        params: [['product_query', 'Product name, SKU or a question about a product']],
        system: 'shop-product-catalog',
        fallback: 'No product in the catalogue matches this query.',
        records: [
            {
                keys: ['zx-500', 'zx500', 'wireless headset'],
                data: {
                    sku: 'ZX-500',
                    name: 'ZX-500 Wireless Headset',
                    category: 'audio',
                    price_eur: '79.90',
                    availability: 'in_stock',
                    compatibility: 'Bluetooth 5.2, USB-C dongle, Windows/macOS/iOS/Android',
                    features: 'Multipoint pairing, active noise cancellation, 30-hour battery',
                    warranty: '24 months',
                    delivery_estimate: '2-4 business days'
                }
            },
            {
                keys: ['hd-200', 'usb-c dock', 'dock'],
                data: {
                    sku: 'HD-200',
                    name: 'HD-200 USB-C Dock',
                    category: 'accessories',
                    price_eur: '129.00',
                    availability: 'preorder',
                    compatibility: 'USB-C laptops with DisplayPort alt mode',
                    features: 'Dual HDMI, Ethernet, 100W pass-through charging',
                    warranty: '12 months',
                    delivery_estimate: '5-7 business days'
                }
            },
            {
                keys: ['pl-200', 'portable charger', 'power bank'],
                data: {
                    sku: 'PL-200',
                    name: 'PL-200 Portable Charger 20W',
                    category: 'power',
                    price_eur: '29.95',
                    availability: 'low_stock',
                    compatibility: 'USB-C and USB-A devices',
                    features: '10000 mAh, 20W fast charge, pass-through charging',
                    warranty: '24 months',
                    delivery_estimate: '1-3 business days'
                }
            },
            {
                keys: ['px-20', 'keyboard'],
                data: {
                    sku: 'PX-20',
                    name: 'PX-20 Mechanical Keyboard',
                    category: 'input',
                    price_eur: '129.00',
                    availability: 'in_stock',
                    compatibility: 'USB-C, Windows/macOS/Linux',
                    features: 'Hot-swappable switches, per-key backlight',
                    warranty: '24 months',
                    delivery_estimate: '2-4 business days'
                }
            },
            {
                keys: ['arc-7', 'monitor arm'],
                data: {
                    sku: 'ARC-7',
                    name: 'ARC-7 Monitor Arm',
                    category: 'ergonomics',
                    price_eur: '79.25',
                    availability: 'in_stock',
                    compatibility: 'VESA 75x75 and 100x100, up to 9 kg',
                    features: 'Gas spring, cable routing, desk clamp and grommet mount',
                    warranty: '36 months',
                    delivery_estimate: '2-4 business days'
                }
            }
        ]
    },
    {
        name: 'shop_delivery_policy',
        description: 'Delivery policy service of the shop. Returns shipping times, tracking behaviour and destination rules.',
        params: [['delivery_question', 'The delivery or shipping question to answer']],
        system: 'shop-delivery-policy',
        fallback: 'No delivery policy fact matches this question.',
        records: [
            {
                keys: ['shipping time', 'delivery time', 'how long', 'when', 'eta', 'dispatch'],
                data: {
                    topic: 'delivery_time',
                    standard_delivery: '2-4 business days within the EU',
                    express_delivery: '1 business day',
                    cutoff_time: '16:00 local time, orders after that ship the next business day',
                    guarantee: 'Delivery dates are estimates; carrier delays are possible',
                    updated: '2026-09-01'
                }
            },
            {
                keys: ['tracking', 'track', 'where is'],
                data: {
                    topic: 'tracking',
                    behaviour: 'A tracking link is emailed after dispatch',
                    first_scan: 'Usually visible within 24 hours of dispatch',
                    updated: '2026-09-01'
                }
            },
            {
                keys: ['international', 'abroad', 'non-eu', 'customs', 'norway', 'switzerland'],
                data: {
                    topic: 'international',
                    coverage: 'All EU countries; selected non-EU destinations',
                    extra_time: 'Non-EU destinations add 1-2 business days for customs',
                    charges: 'Import VAT and customs handling are paid by the customer',
                    updated: '2026-09-01'
                }
            },
            {
                keys: ['po box', 'pobox', 'packstation'],
                data: {
                    topic: 'address_restrictions',
                    rule: 'Tracked couriers cannot deliver to PO boxes',
                    action: 'Ask the customer for a street address',
                    updated: '2026-09-01'
                }
            },
            {
                keys: ['free shipping', 'shipping cost', 'delivery cost'],
                data: {
                    topic: 'shipping_cost',
                    free_shipping_threshold_eur: '50.00',
                    standard_cost_eur: '4.90',
                    express_cost_eur: '11.90',
                    updated: '2026-09-01'
                }
            }
        ]
    },
    {
        name: 'shop_order_service',
        description: 'Order service of the shop. Returns the status of one order; requires a valid order ID.',
        params: [['order_id', 'The order ID, for example ORD-1001']],
        system: 'shop-order-service',
        fallback: 'No order with this ID exists in the order service.',
        records: [
            {
                keys: ['ord-1001'],
                data: {
                    order_id: 'ORD-1001',
                    status: 'shipped',
                    order_date: '2026-08-29',
                    ship_date: '2026-08-30',
                    carrier: 'DHL',
                    tracking_number: 'DHL78451293',
                    items: 'ZX-500 Wireless Headset x1',
                    payment_state: 'captured',
                    order_total_eur: '79.99',
                    estimated_delivery: '2026-09-03'
                }
            },
            {
                keys: ['ord-1002'],
                data: {
                    order_id: 'ORD-1002',
                    status: 'delivered',
                    order_date: '2026-08-20',
                    delivery_date: '2026-08-24',
                    carrier: 'UPS',
                    tracking_number: '1Z4X8A2213',
                    items: 'PX-20 Mechanical Keyboard x1',
                    payment_state: 'captured',
                    order_total_eur: '129.00'
                }
            },
            {
                keys: ['ord-1003'],
                data: {
                    order_id: 'ORD-1003',
                    status: 'processing',
                    order_date: '2026-09-03',
                    warehouse: 'NL-3',
                    items: 'ARC-7 Monitor Arm x2',
                    payment_state: 'pending',
                    order_total_eur: '158.50'
                }
            },
            {
                keys: ['ord-1042'],
                data: {
                    order_id: 'ORD-1042',
                    status: 'shipped',
                    order_date: '2026-08-29',
                    carrier: 'DHL',
                    tracking_number: 'DHL8291042DE',
                    items: 'ZX-500 Wireless Headset x1',
                    payment_state: 'captured',
                    order_total_eur: '79.90',
                    estimated_delivery: '2026-09-05',
                    delivery_country: 'DE'
                }
            },
            {
                keys: ['ord-9000'],
                data: {
                    order_id: 'ORD-9000',
                    status: 'returned',
                    order_date: '2026-07-11',
                    return_date: '2026-07-22',
                    refund_state: 'issued',
                    refund_amount_eur: '89.00',
                    policy_note: 'Standard return completed within the 30-day window'
                }
            },
            {
                keys: ['ord-10482'],
                data: {
                    order_id: 'ORD-10482',
                    status: 'shipped',
                    order_date: '2026-08-29',
                    carrier: 'DHL',
                    tracking_number: 'JD014299871DE',
                    items: 'HD-200 USB-C Dock x1',
                    payment_state: 'captured',
                    order_total_eur: '129.00',
                    estimated_delivery: '2026-09-06'
                }
            }
        ]
    },
    {
        name: 'shop_refund_policy',
        description: 'Policy service of the shop. Returns refund, return and warranty rules including approval thresholds.',
        params: [['policy_question', 'The policy question to answer']],
        system: 'shop-refund-policy',
        fallback: 'No policy fact matches this question.',
        records: [
            {
                keys: ['refund threshold', 'refund limit', 'approve refund', 'refund', 'money back'],
                data: {
                    policy_topic: 'refunds',
                    threshold_currency: 'EUR',
                    threshold_amount: '100',
                    decision: 'escalate_above_threshold',
                    customer_facing: 'Refunds over EUR 100 are reviewed by a human before approval.',
                    internal_notes: 'Never auto-approve a refund above EUR 100.'
                }
            },
            {
                keys: ['return window', 'return', 'send back'],
                data: {
                    policy_topic: 'returns',
                    return_window_days: '30',
                    condition: 'unused and in original packaging',
                    decision: 'resolve_if_within_window',
                    customer_facing: 'Items can be returned within 30 days if unused and in their original packaging.',
                    internal_notes: 'Customer pays return shipping unless the item is defective.'
                }
            },
            {
                keys: ['defective', 'broken', 'faulty', 'damaged'],
                data: {
                    policy_topic: 'defective items',
                    report_window_days: '14',
                    decision: 'resolve_or_escalate_if_unclear',
                    customer_facing:
                        'Defective items reported within 14 days are eligible for repair, replacement or refund after inspection.',
                    internal_notes: 'Escalate when the condition is unclear.'
                }
            },
            {
                keys: ['warranty', 'guarantee'],
                data: {
                    policy_topic: 'warranty',
                    coverage: '24 months from delivery for manufacturing defects',
                    exceptions: 'physical damage, misuse, unauthorised repair',
                    decision: 'resolve_if_clear_defect',
                    customer_facing: 'Manufacturing defects are covered for 24 months from delivery.',
                    internal_notes: 'Uncertain warranty cases go to a human.'
                }
            },
            {
                keys: ['exception', 'unclear', 'special case'],
                data: {
                    policy_topic: 'policy exception',
                    decision: 'escalate',
                    customer_facing: 'Unclear or exceptional cases are reviewed by a human.',
                    internal_notes: 'Use for conflicting or ambiguous policy situations.'
                }
            }
        ]
    },
    {
        name: 'shop_escalation_desk',
        description: 'Escalation desk of the support platform. Creates a human-review case and returns its case ID.',
        params: [
            ['reason', 'Why this case needs a human, for example refund_over_100'],
            ['priority', 'Case priority: normal, high or urgent'],
            ['customer_message', 'The customer message that triggered the escalation']
        ],
        func: `/* shop-support-platform (escalation desk) — demo connector, replace with a real API call */
const REASON = (${arg('reason')}).trim() || 'unspecified'
const PRIORITY = ((${arg('priority')}).trim() || 'normal').toLowerCase()
const MESSAGE = (${arg('customer_message')}).trim()

const ALLOWED = ['normal', 'high', 'urgent']
const priority = ALLOWED.indexOf(PRIORITY) >= 0 ? PRIORITY : 'normal'
const sla = { urgent: '1 business hour', high: '4 business hours', normal: '1 business day' }[priority]

return JSON.stringify({
    ok: true,
    status: 'ok',
    source: 'shop-support-platform',
    data: {
        case_id: 'ESC-' + String(Date.now()).slice(-6),
        state: 'queued',
        team: 'human_support',
        reason: REASON,
        priority: priority,
        sla: sla,
        created_at: new Date().toISOString(),
        excerpt: MESSAGE.slice(0, 200),
        next_step: 'A human agent reviews the case and replies to the customer.'
    }
})
`
    },
    {
        name: 'shop_customer_mailer',
        description: 'Outbound mail service of the shop. Sends the customer-facing reply and returns a message ID.',
        params: [['reply_text', 'The customer-facing reply to send']],
        func: `/* shop-mail-service — demo connector, replace with a real API call */
const REPLY = (${arg('reply_text')}).trim()
if (!REPLY) {
    return JSON.stringify({
        ok: false,
        status: 'invalid_request',
        source: 'shop-mail-service',
        message: 'reply_text is empty; nothing was sent.'
    })
}

return JSON.stringify({
    ok: true,
    status: 'ok',
    source: 'shop-mail-service',
    data: {
        message_id: 'MSG-' + String(Date.now()).slice(-8),
        state: 'queued_for_delivery',
        channel: 'email',
        characters: REPLY.length,
        queued_at: new Date().toISOString()
    }
})
`
    },
    {
        name: 'shop_crm_notes',
        description: 'CRM of the shop. Records the internal action summary on the customer record and returns a note ID.',
        params: [['summary_text', 'The internal summary of what the workflow did']],
        func: `/* shop-crm — demo connector, replace with a real API call */
const SUMMARY = (${arg('summary_text')}).trim()
if (!SUMMARY) {
    return JSON.stringify({
        ok: false,
        status: 'invalid_request',
        source: 'shop-crm',
        message: 'summary_text is empty; nothing was recorded.'
    })
}

return JSON.stringify({
    ok: true,
    status: 'ok',
    source: 'shop-crm',
    data: {
        note_id: 'NOTE-' + String(Date.now()).slice(-8),
        state: 'stored',
        visibility: 'internal_only',
        characters: SUMMARY.length,
        recorded_at: new Date().toISOString()
    }
})
`
    }
]

const schemaOf = (params) =>
    JSON.stringify(
        params.map(([property, description]) => ({ property, type: 'string', description, required: true })),
        null,
        2
    )

const funcOf = (tool) => tool.func || lookupFunc(tool.system, tool.params[0][0], tool.records, tool.fallback)

const main = async () => {
    const [workspaceArg] = process.argv.slice(2)
    if (workspaceArg === '--list') {
        for (const tool of TOOLS) console.log(`${tool.name}(${tool.params.map(([name]) => name).join(', ')}) — ${tool.description}`)
        return
    }

    const workspaceId = workspaceArg || process.env.AUTOPILOT_DEMO_WORKSPACE_ID
    if (!workspaceId) {
        console.error('Usage: node packages/server/scripts/create-demo-connector-tools.js <workspaceId>')
        console.error('Find the id with: SELECT DISTINCT workspaceId FROM tool;')
        process.exitCode = 1
        return
    }

    const db = new sqlite3.Database(DATABASE_PATH)
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))))
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())))

    try {
        const names = TOOLS.map((tool) => tool.name)
        const existing = await all(`SELECT name FROM tool WHERE name IN (${names.map(() => '?').join(',')}) AND workspaceId = ?`, [
            ...names,
            workspaceId
        ])
        const present = new Set(existing.map((row) => row.name))

        for (const tool of TOOLS) {
            if (present.has(tool.name)) {
                console.log(`skipped ${tool.name} (already in this workspace)`)
                continue
            }
            await run(
                `INSERT INTO tool (id, name, description, color, schema, func, createdDate, updatedDate, workspaceId)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
                [randomUUID(), tool.name, tool.description, COLOR, schemaOf(tool.params), funcOf(tool), workspaceId]
            )
            console.log(`created ${tool.name}`)
        }
    } finally {
        db.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
