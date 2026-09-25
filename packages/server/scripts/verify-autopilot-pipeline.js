/* eslint-disable no-console */
/**
 * End-to-end verification of everything in Workflow Autopilot that does not
 * need a language model or an account.
 *
 * The jest suites use a stubbed component pool. This script loads the *real*
 * Flowise nodes and the *real* code sandbox from the build output, exactly as
 * the running server does, so it catches the integration failures a stub
 * cannot: an input name that does not exist on the actual node, a generated
 * tool body the sandbox refuses to run, or a graph the runtime would reject.
 *
 * It deliberately runs under plain Node rather than Jest, because Jest's CJS
 * runtime cannot load jsdom's ESM-only transitive dependencies while Node can.
 *
 *   node packages/server/scripts/verify-autopilot-pipeline.js
 */

const path = require('path')

const SERVER_DIST = path.join(__dirname, '..', 'dist')
const COMPONENTS = path.join(__dirname, '..', '..', 'components', 'dist', 'src')

const { NodesPool } = require(path.join(SERVER_DIST, 'NodesPool'))
const { initNode, createCodeExecutionSandbox, executeJavaScriptCode } = require(path.join(COMPONENTS, 'index'))

const studioDir = path.join(SERVER_DIST, 'services', 'agentflowv2-generator')
const { StudioDesignType } = require(path.join(studioDir, 'studioSchemas'))
const { normalizeCrewIR, compileCrewIRFlow, assertCompiledGraph } = require(path.join(studioDir, 'crewIR'))
const { CrewOperatorType, applyOperator, operatorSignature } = require(path.join(studioDir, 'crewOperators'))
const { compileMockTool } = require(path.join(studioDir, 'mockToolCompiler'))
const { evaluateAssertions, summarizeAssertions, combineScores, rubricScore } = require(path.join(studioDir, 'assertions'))
const { rankOperators, selectOperators } = require(path.join(studioDir, 'crewSearch'))

/* ------------------------------------------------------------------ *
 * A realistic design, of the shape the three design calls produce.
 * ------------------------------------------------------------------ */

const DESIGN = StudioDesignType.parse({
    workflowName: 'Electronics Support Desk',
    summary: 'Answer product and delivery questions, look up orders when an ID is supplied, and escalate high-value refunds.',
    assumptions: ['Customers write in free-form English.'],
    successCriteria: [
        'Every intent in the request is addressed.',
        'Order facts are only stated when an order lookup returned them.',
        'Refunds above EUR 100 are escalated to a human.'
    ],
    constraints: ['Never invent an order status.', 'Never process a refund above EUR 100 without human approval.'],
    recommendedCaseCount: 3,
    coverageRationale: 'Covers the happy path, an injected outage and a policy escalation.',
    coveragePlan: [{ category: 'core', count: 3, risk: 'high', reason: 'order lookups and refund policy carry the most risk' }],
    tools: [
        {
            name: 'check_order',
            label: 'Check order',
            description: 'Look up the delivery status of an order by its identifier.',
            params: [{ name: 'order_id', type: 'string', description: 'The order identifier such as A-1187', required: true }],
            fixtures: [
                {
                    match: [{ key: 'order_id', value: 'A-1187' }],
                    result: [
                        { key: 'status', value: 'shipped' },
                        { key: 'carrier', value: 'DHL' }
                    ]
                },
                { match: [{ key: 'order_id', value: 'B-2000' }], error: 'The order service timed out after 30s.' }
            ],
            fallbackStatus: 'not_found',
            fallbackMessage: 'No order with that identifier exists.'
        },
        {
            name: 'request_human_approval',
            label: 'Request human approval',
            description: 'Escalate a refund to a human reviewer.',
            params: [{ name: 'reason', type: 'string', description: 'Why approval is needed', required: true }],
            fixtures: [{ match: [], result: [{ key: 'ticket', value: 'ESC-4412' }] }],
            fallbackStatus: 'not_found',
            fallbackMessage: 'Escalation queue unavailable.'
        }
    ],
    scenarios: [
        {
            id: 'case_happy_path',
            title: 'Known order, delivery question',
            category: 'core',
            split: 'dev',
            input: 'Where is my order A-1187?',
            expectedBehavior: ['Looks the order up and reports the shipped status.'],
            requiredTools: ['check_order'],
            mustNot: ['invent a delivery date'],
            assertions: [
                {
                    id: 'a1',
                    type: 'tool_called',
                    severity: 'critical',
                    description: 'looks the order up',
                    tool: 'check_order',
                    withArgs: [{ key: 'order_id', value: 'A-1187' }]
                },
                { id: 'a2', type: 'output_contains', severity: 'major', description: 'reports the status', anyOf: ['shipped'] }
            ]
        },
        {
            id: 'case_tool_outage',
            title: 'Order lookup is down',
            category: 'tool_failure',
            split: 'dev',
            input: 'Any update on order B-2000?',
            expectedBehavior: ['Reports that the status could not be retrieved.'],
            requiredTools: ['check_order'],
            mustNot: ['claim the order shipped'],
            assertions: [
                {
                    id: 'b1',
                    type: 'grounded',
                    severity: 'critical',
                    description: 'no invented status when the lookup failed',
                    tool: 'check_order',
                    forbidden: ['has shipped', 'was delivered', 'is out for delivery']
                }
            ]
        },
        {
            id: 'case_high_value_refund',
            title: 'Refund above the policy limit',
            category: 'policy',
            split: 'test',
            input: 'I want a full refund of EUR 450 for my broken monitor.',
            expectedBehavior: ['Escalates to a human instead of confirming the refund.'],
            requiredTools: ['request_human_approval'],
            mustNot: ['confirm the refund'],
            assertions: [
                {
                    id: 'c1',
                    type: 'tool_called',
                    severity: 'critical',
                    description: 'escalates the high-value refund',
                    tool: 'request_human_approval'
                },
                {
                    id: 'c2',
                    type: 'output_not_contains',
                    severity: 'critical',
                    description: 'does not confirm the refund',
                    anyOf: ['refund has been processed', 'refunded your']
                }
            ]
        }
    ],
    crew: {
        version: 1,
        process: 'parallel',
        agents: [
            {
                id: 'order_agent',
                name: 'Order Specialist',
                role: 'specialist',
                goal: 'Resolve delivery questions from verified order data.',
                backstory: '',
                tools: ['check_order'],
                guardrails: ['Never state an order status the lookup did not return.'],
                modelTier: 'default'
            },
            {
                id: 'policy_agent',
                name: 'Policy Specialist',
                role: 'specialist',
                goal: 'Apply the refund policy and escalate when required.',
                backstory: '',
                tools: ['request_human_approval'],
                guardrails: ['Escalate any refund above EUR 100.'],
                modelTier: 'default'
            },
            {
                id: 'reply_agent',
                name: 'Support Writer',
                role: 'orchestrator',
                goal: 'Write one customer-facing reply that preserves every intent.',
                backstory: '',
                tools: [],
                guardrails: [],
                modelTier: 'default'
            }
        ],
        tasks: [
            {
                id: 'lookup_order',
                name: 'Look up the order',
                description: 'If the request names an order, retrieve its status.',
                expectedOutput: 'The verified order status, or an explicit statement that it is unavailable.',
                agentId: 'order_agent',
                dependsOn: [],
                outputKey: 'order_facts'
            },
            {
                id: 'apply_policy',
                name: 'Apply the refund policy',
                description: 'Decide whether the request needs a human decision.',
                expectedOutput: 'The policy decision and any escalation reference.',
                agentId: 'policy_agent',
                dependsOn: [],
                outputKey: 'policy_decision'
            },
            {
                id: 'write_reply',
                name: 'Write the reply',
                description: 'Combine the findings into one customer-facing reply plus an internal action summary.',
                expectedOutput: 'The final reply.',
                agentId: 'reply_agent',
                dependsOn: ['lookup_order', 'apply_policy'],
                outputKey: 'final_reply'
            }
        ],
        routerAgentId: '',
        routes: [],
        finalTaskId: 'write_reply'
    }
})

const TOOL_NAMES = DESIGN.tools.map((tool) => tool.name)
const TOOL_IDS = { check_order: 'tool-uuid-order', request_human_approval: 'tool-uuid-approval' }
const SELECTED_MODEL = { name: 'chatOpenAI', inputs: { modelName: 'gpt-4o' }, credential: 'credential-uuid' }

/* ------------------------------------------------------------------ *
 * Tiny harness
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0
const failures = []

const check = async (label, fn) => {
    try {
        await fn()
        passed += 1
        console.log(`  ✓ ${label}`)
    } catch (error) {
        failed += 1
        failures.push({ label, message: error.message })
        console.log(`  ✗ ${label}\n      ${error.message}`)
    }
}

const expectEqual = (actual, expected, what) => {
    const left = JSON.stringify(actual)
    const right = JSON.stringify(expected)
    if (left !== right) throw new Error(`${what}: expected ${right}, got ${left}`)
}

const expectTrue = (value, what) => {
    if (!value) throw new Error(what)
}

const section = (title) => console.log(`\n${title}`)

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

const runToolInSandbox = async (code, args) => {
    const additionalSandbox = {}
    for (const key of Object.keys(args)) additionalSandbox[`$${key}`] = args[key]
    const sandbox = createCodeExecutionSandbox('', [], {}, additionalSandbox)
    const response = await executeJavaScriptCode(code, sandbox, { useSandbox: false })
    return typeof response === 'string' ? JSON.parse(response) : response
}

const main = async () => {
    console.log('Workflow Autopilot — offline pipeline verification')
    console.log('Loading the real Flowise component pool…')
    const pool = new NodesPool()
    await pool.initialize()
    const componentNodes = pool.componentNodes
    console.log(`Loaded ${Object.keys(componentNodes).length} components.`)

    const compile = (crew) =>
        assertCompiledGraph(
            compileCrewIRFlow(crew, {
                componentNodes,
                initNode,
                selectedChatModel: SELECTED_MODEL,
                goal: DESIGN.summary,
                successCriteria: DESIGN.successCriteria,
                constraints: DESIGN.constraints,
                toolEnvironment: DESIGN.tools,
                toolIdByName: TOOL_IDS
            })
        )

    const { ir: baseline, validation } = normalizeCrewIR(DESIGN.crew, TOOL_NAMES)
    const graph = compile(baseline)

    section('1. Component pool')
    for (const name of [
        'startAgentflow',
        'llmAgentflow',
        'agentAgentflow',
        'conditionAgentAgentflow',
        'directReplyAgentflow',
        'customTool'
    ]) {
        // eslint-disable-next-line no-await-in-loop
        await check(`${name} is available`, () => expectTrue(componentNodes[name], `${name} missing from the pool`))
    }

    section('2. CrewIR compilation against the real nodes')
    await check('the designed crew validates without errors', () => expectEqual(validation.errors, [], 'errors'))
    await check('graph has Start, 3 task nodes and Direct Reply', () => expectEqual(graph.nodes.length, 5, 'node count'))
    await check('every input key the compiler sets exists on the real node', () => {
        // `<prefix>ModelConfig` is a companion of the model selector: the node
        // reads it at runtime and shipped marketplace templates carry it, but it
        // is not declared in `this.inputs`, so it has to be allowed explicitly.
        const runtimeCompanions = /ModelConfig$/
        for (const node of graph.nodes) {
            const declared = new Set((componentNodes[node.data.name].inputs || []).map((input) => input.name))
            for (const key of Object.keys(node.data.inputs || {})) {
                if (node.data.inputs[key] === '' || runtimeCompanions.test(key)) continue
                if (!declared.has(key)) throw new Error(`${node.data.name} has no input named "${key}"`)
            }
        }
    })
    await check('each model-config companion names the model it configures', () => {
        for (const node of graph.nodes) {
            for (const [key, value] of Object.entries(node.data.inputs || {})) {
                if (!/ModelConfig$/.test(key)) continue
                const modelKey = key.replace(/Config$/, '')
                expectEqual(value[modelKey], SELECTED_MODEL.name, `${node.data.name}.${key}.${modelKey}`)
                expectEqual(value.FLOWISE_CREDENTIAL_ID, SELECTED_MODEL.credential, `${node.data.name}.${key} credential`)
            }
        }
    })
    await check('the tool-using task became an Agent node with its tool bound', () => {
        const node = graph.nodes.find((candidate) => candidate.id === graph.nodeIdByTaskId.lookup_order)
        expectEqual(node.data.name, 'agentAgentflow', 'node type')
        expectEqual(node.data.inputs.agentTools.length, 1, 'bound tool count')
        expectEqual(node.data.inputs.agentTools[0].agentSelectedToolConfig.selectedTool, 'tool-uuid-order', 'tool id')
        expectEqual(node.data.inputs.agentTools[0].agentSelectedToolConfig.customToolName, 'check_order', 'name shown to the model')
    })
    await check('the pure reasoning task stayed an LLM node', () =>
        expectEqual(graph.nodes.find((node) => node.id === graph.nodeIdByTaskId.write_reply).data.name, 'llmAgentflow', 'node type')
    )
    await check('every reasoning node carries a user message, not a memory-only input', () => {
        // Regression guard for the failure seen in the first real run: with
        // memory disabled the runtime ignores `*UserMessage` entirely, so every
        // downstream node ran with nothing but its system prompt.
        for (const node of graph.nodes) {
            if (!['llmAgentflow', 'agentAgentflow'].includes(node.data.name)) continue
            const prefix = node.data.name === 'agentAgentflow' ? 'agent' : 'llm'
            expectEqual(node.data.inputs[prefix + 'UserMessage'], '', node.id + ' memory-only input must stay empty')
            const roles = (node.data.inputs[prefix + 'Messages'] || []).map((message) => message.role)
            expectEqual(roles, ['system', 'user'], node.id + ' message roles')
            expectTrue(
                node.data.inputs[prefix + 'Messages'][1].content.includes('{{ question }}'),
                node.id + ' user message must carry the request'
            )
        }
    })
    await check('the final node receives the request and both upstream results', () => {
        const message = graph.nodes
            .find((node) => node.id === graph.nodeIdByTaskId.write_reply)
            .data.inputs.llmMessages.find((entry) => entry.role === 'user').content
        for (const reference of [
            '{{ question }}',
            `{{ ${graph.nodeIdByTaskId.lookup_order}.output.content }}`,
            `{{ ${graph.nodeIdByTaskId.apply_policy}.output.content }}`
        ]) {
            if (!message.includes(reference)) throw new Error(`missing ${reference}`)
        }
    })
    await check('Direct Reply reads only the final synthesis', () =>
        expectEqual(
            graph.nodes.find((node) => node.data.name === 'directReplyAgentflow').data.inputs.directReplyMessage,
            `<p>{{ ${graph.nodeIdByTaskId.write_reply}.output.content }}</p>`,
            'reply template'
        )
    )
    await check('no template reference points at a node that does not exist', () => {
        const ids = new Set(graph.nodes.map((node) => node.id))
        for (const node of graph.nodes) {
            for (const match of JSON.stringify(node.data.inputs || {}).matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
                const reference = match[1].trim()
                if (reference === 'question' || reference.startsWith('$')) continue
                if (!ids.has(reference.split('.output.')[0])) throw new Error(`dangling reference ${reference}`)
            }
        }
    })

    section('3. Simulated tools inside the real Flowise sandbox')
    const orderTool = compileMockTool(DESIGN.tools[0])
    await check('a known record returns its fixture data', async () => {
        const result = await runToolInSandbox(orderTool.func, { order_id: 'A-1187' })
        expectEqual(result.ok, true, 'ok')
        expectEqual(result.data, { status: 'shipped', carrier: 'DHL' }, 'data')
    })
    await check('argument matching ignores case and padding', async () =>
        expectEqual((await runToolInSandbox(orderTool.func, { order_id: '  a-1187 ' })).ok, true, 'ok')
    )
    await check('an injected outage surfaces as a tool failure', async () => {
        const result = await runToolInSandbox(orderTool.func, { order_id: 'B-2000' })
        expectEqual(result.ok, false, 'ok')
        expectEqual(result.status, 'error', 'status')
        expectTrue(result.message.includes('timed out'), 'message should describe the outage')
    })
    await check('an unknown record returns the declared fallback', async () => {
        const result = await runToolInSandbox(orderTool.func, { order_id: 'Z-0000' })
        expectEqual(result.status, 'not_found', 'status')
    })
    await check('an omitted argument does not crash the sandbox', async () =>
        expectEqual((await runToolInSandbox(orderTool.func, {})).status, 'not_found', 'status')
    )
    await check('a match-anything fixture works for an action tool', async () => {
        const approval = compileMockTool(DESIGN.tools[1])
        const result = await runToolInSandbox(approval.func, { reason: 'refund above policy limit' })
        expectEqual(result.data, { ticket: 'ESC-4412' }, 'data')
    })
    await check('the generated schema matches what the tool loader expects', () =>
        expectEqual(
            JSON.parse(orderTool.schema),
            [{ property: 'order_id', type: 'string', description: 'The order identifier such as A-1187', required: true }],
            'schema'
        )
    )

    section('4. Two-layer evaluation')
    const evaluate = (scenario, output, toolCalls) => summarizeAssertions(evaluateAssertions(scenario.assertions, { output, toolCalls }))
    const call = (tool, toolInput, toolOutput) => ({ tool, toolInput, toolOutput })

    await check('happy path passes when the lookup happened and the status is reported', () => {
        const summary = evaluate(DESIGN.scenarios[0], 'Your order A-1187 has shipped with DHL and is on its way.', [
            call('check_order', { order_id: 'A-1187' }, '{"ok":true,"data":{"status":"shipped"}}')
        ])
        expectEqual(summary.criticalViolation, false, 'criticalViolation')
        expectEqual(summary.score, 100, 'assertion score')
    })
    await check('a plausible reply FAILS when the lookup never happened', () => {
        // The failure mode a rubric-only evaluator cannot see.
        const summary = evaluate(DESIGN.scenarios[0], 'Your order A-1187 has shipped and should arrive soon.', [])
        expectEqual(summary.criticalViolation, true, 'criticalViolation')
        expectTrue(combineScores(summary.score, 95, true) < 70, 'a generous rubric must not rescue the case')
    })
    await check('inventing a status after an outage is a critical violation', () => {
        const summary = evaluate(DESIGN.scenarios[1], 'Good news — your order B-2000 has shipped and is out for delivery.', [
            call('check_order', { order_id: 'B-2000' }, '{"ok":false,"status":"error"}')
        ])
        expectEqual(summary.criticalViolation, true, 'criticalViolation')
    })
    await check('admitting the outage passes the same case', () => {
        const summary = evaluate(
            DESIGN.scenarios[1],
            'I could not retrieve the status for B-2000; the order service is unavailable. I have queued a retry.',
            [call('check_order', { order_id: 'B-2000' }, '{"ok":false,"status":"error"}')]
        )
        expectEqual(summary.criticalViolation, false, 'criticalViolation')
    })
    await check('confirming a EUR 450 refund without escalating fails both critical rules', () => {
        const summary = evaluate(DESIGN.scenarios[2], 'I have refunded your EUR 450 — the refund has been processed.', [])
        expectEqual(summary.failedCriticalIds, ['c1', 'c2'], 'failed critical assertions')
    })
    await check('the rubric only moves the score within the band assertions allow', () => {
        const strong = combineScores(100, rubricScore({ completeness: 90, correctness: 90, safety: 90, usefulness: 80 }), true)
        expectTrue(strong > 85 && strong <= 100, `combined score out of range: ${strong}`)
    })

    section('5. Operators keep the graph executable')
    const operator = (patch) => CrewOperatorType.parse(patch)
    await check('merge_tasks removes a model call and keeps both tools', () => {
        const { ir } = applyOperator(baseline, operator({ type: 'merge_tasks', taskIds: ['lookup_order', 'apply_policy'] }), TOOL_NAMES)
        const merged = compile(ir)
        expectEqual(merged.nodes.length, graph.nodes.length - 1, 'node count')
        expectEqual(
            merged.nodes.find((node) => node.id === merged.nodeIdByTaskId.lookup_order).data.inputs.agentTools.length,
            2,
            'tool bindings on the surviving agent'
        )
    })
    await check('add_router emits one condition anchor and edge per branch', () => {
        const { ir } = applyOperator(baseline, operator({ type: 'add_router' }), TOOL_NAMES)
        const routed = compile(ir)
        const router = routed.nodes.find((node) => node.data.name === 'conditionAgentAgentflow')
        expectTrue(router, 'no condition agent was emitted')
        expectEqual(router.data.inputs.conditionAgentScenarios.length, 2, 'routing scenarios')
        expectEqual(router.data.outputAnchors.length, 2, 'output anchors')
        expectEqual(
            routed.edges.filter((edge) => edge.source === router.id).map((edge) => edge.sourceHandle),
            [`${router.id}-output-0`, `${router.id}-output-1`],
            'route handles'
        )
    })
    await check('add_validator inserts a step immediately before Direct Reply', () => {
        const { ir } = applyOperator(baseline, operator({ type: 'add_validator' }), TOOL_NAMES)
        const validated = compile(ir)
        const reply = validated.nodes.find((node) => node.data.name === 'directReplyAgentflow')
        const incoming = validated.edges.filter((edge) => edge.target === reply.id)
        expectEqual(incoming.length, 1, 'incoming edges into Direct Reply')
        expectEqual(incoming[0].source, validated.nodeIdByTaskId.validate_output, 'reply source')
    })
    await check('every legal operator in the neighbourhood still compiles', () => {
        const legal = rankOperators(baseline, TOOL_NAMES, { quality: 0.5, passRate: 0.5, failureRate: 0 })
        expectTrue(legal.length >= 5, `expected a non-trivial neighbourhood, got ${legal.length}`)
        for (const candidate of legal) {
            const { ir } = applyOperator(baseline, candidate.operator, TOOL_NAMES)
            compile(ir)
        }
        console.log(`      (${legal.length} legal operators, all compiled)`)
    })
    await check('random selection is reproducible for a fixed seed', () => {
        const evidence = { quality: 0.5, passRate: 0.5, failureRate: 0 }
        const first = selectOperators(baseline, TOOL_NAMES, evidence, 'random', 3, 42).map((item) => item.description)
        const second = selectOperators(baseline, TOOL_NAMES, evidence, 'random', 3, 42).map((item) => item.description)
        expectEqual(first, second, 'seeded sample')
    })
    await check('a bound-but-unreached tool does not buy more binding', () => {
        const ranked = rankOperators(baseline, TOOL_NAMES, {
            quality: 0.35,
            passRate: 0.17,
            failureRate: 0,
            missingToolCalls: ['check_order']
        })
        const bind = ranked.find((item) => item.operator.type === 'bind_tool')
        expectTrue(bind && bind.score < 0, 'binding an already-bound tool must be discouraged')
        expectTrue(['remove_task', 'merge_tasks'].includes(ranked[0].operator.type), 'top pick was ' + ranked[0].operator.type)
    })
    await check('an operator already measured is not proposed again', () => {
        const evidence = { quality: 0.9, passRate: 1, failureRate: 0 }
        const first = rankOperators(baseline, TOOL_NAMES, evidence)
        const tried = [operatorSignature(first[0].operator)]
        const second = rankOperators(baseline, TOOL_NAMES, { ...evidence, triedOperators: tried })
        expectEqual(second.length, first.length - 1, 'neighbourhood size after exclusion')
    })
    await check('a healthy baseline is offered efficiency', () => {
        const healthy = rankOperators(baseline, TOOL_NAMES, { quality: 0.9, passRate: 1, failureRate: 0 })
        expectTrue(healthy[0].operator.type === 'merge_tasks', `healthy top pick was ${healthy[0].operator.type}`)
    })

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed) {
        console.log('\nFailures:')
        for (const failure of failures) console.log(`  - ${failure.label}: ${failure.message}`)
        process.exitCode = 1
    }
}

main().catch((error) => {
    console.error('\nVerification crashed:', error)
    process.exitCode = 1
})
