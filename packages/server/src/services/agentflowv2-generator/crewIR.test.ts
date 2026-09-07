import { describe, expect, it } from '@jest/globals'
import { assertCompiledGraph, compileCrewIRFlow, crewCriticalPathLength, normalizeCrewIR } from './crewIR'
import { type CrewIR } from './studioSchemas'

const agent = (id: string, patch: Record<string, any> = {}): Record<string, any> => ({
    id,
    name: id.replace(/_/g, ' '),
    role: 'specialist',
    goal: `goal of ${id}`,
    backstory: '',
    tools: [],
    guardrails: [],
    modelTier: 'default',
    ...patch
})

const task = (id: string, agentId: string, patch: Record<string, any> = {}): Record<string, any> => ({
    id,
    name: id,
    description: `do ${id}`,
    expectedOutput: `${id} output`,
    agentId,
    dependsOn: [],
    outputKey: `${id}_result`,
    ...patch
})

const baseIR = (): Record<string, any> => ({
    version: 1,
    process: 'parallel',
    agents: [agent('lookup_agent'), agent('reply_agent', { role: 'orchestrator' })],
    tasks: [task('lookup', 'lookup_agent'), task('reply', 'reply_agent', { dependsOn: ['lookup'] })],
    routerAgentId: '',
    routes: [],
    finalTaskId: 'reply'
})

/** Minimal stand-in for the Flowise component pool. */
const componentNodes: Record<string, any> = {
    startAgentflow: { name: 'startAgentflow', label: 'Start', color: '#aaa', inputs: [] },
    llmAgentflow: { name: 'llmAgentflow', label: 'LLM', color: '#bbb', inputs: [] },
    agentAgentflow: { name: 'agentAgentflow', label: 'Agent', color: '#ccc', inputs: [] },
    conditionAgentAgentflow: { name: 'conditionAgentAgentflow', label: 'Condition Agent', color: '#ddd', inputs: [] },
    directReplyAgentflow: { name: 'directReplyAgentflow', label: 'Direct Reply', color: '#eee', inputs: [] }
}

const initNode = (nodeData: Record<string, any>, id: string) => ({ ...nodeData, id, inputs: {}, inputParams: [], outputAnchors: [] })

const compileContext = (overrides: Record<string, any> = {}) => ({
    componentNodes,
    initNode,
    selectedChatModel: { name: 'chatOpenAI', inputs: { modelName: 'gpt-4o' }, credential: 'cred-1' },
    goal: 'handle customer requests',
    successCriteria: ['answer completely'],
    constraints: ['never invent order data'],
    toolEnvironment: [],
    toolIdByName: {},
    ...overrides
})

describe('normalizeCrewIR', () => {
    it('accepts a well-formed crew unchanged', () => {
        const { ir, validation } = normalizeCrewIR(baseIR())
        expect(validation.valid).toBe(true)
        expect(validation.warnings).toEqual([])
        expect(ir.tasks).toHaveLength(2)
    })

    it('drops dependencies on tasks that do not exist', () => {
        const draft = baseIR()
        draft.tasks[1].dependsOn = ['lookup', 'ghost_task']
        const { ir, validation } = normalizeCrewIR(draft)
        expect(ir.tasks[1].dependsOn).toEqual(['lookup'])
        expect(validation.warnings.join(' ')).toContain('ghost_task')
    })

    it('strips tool bindings that the environment does not provide', () => {
        const draft = baseIR()
        draft.agents[0].tools = ['check_order', 'imaginary_tool']
        const { ir, validation } = normalizeCrewIR(draft, ['check_order'])
        expect(ir.agents[0].tools).toEqual(['check_order'])
        expect(validation.warnings.join(' ')).toContain('imaginary_tool')
    })

    it('attaches unreachable terminal tasks to the final task', () => {
        const draft = baseIR()
        draft.agents.push(agent('extra_agent'))
        draft.tasks.push(task('extra', 'extra_agent'))
        const { ir, validation } = normalizeCrewIR(draft)
        expect(ir.tasks.find((item) => item.id === 'reply')?.dependsOn).toContain('extra')
        expect(validation.warnings.join(' ')).toContain('extra')
    })

    it('resolves a task that names its agent instead of referencing the id', () => {
        // Dropping these emptied the crew, and the failure surfaced as
        // "crew.tasks: Array must contain at least 1 element(s)".
        const draft = baseIR()
        draft.tasks[0].agentId = 'Lookup Agent'
        const { ir, validation } = normalizeCrewIR(draft)
        expect(validation.valid).toBe(true)
        expect(ir.tasks[0].agentId).toBe('lookup_agent')
        expect(validation.warnings.join(' ')).toContain('resolved to lookup_agent')
    })

    it('still rejects a task whose agent does not exist at all', () => {
        const draft = baseIR()
        draft.tasks[0].agentId = 'nobody_at_all'
        const { validation } = normalizeCrewIR(draft)
        expect(validation.valid).toBe(false)
        expect(validation.errors.join(' ')).toContain('unknown agent')
    })

    it('resolves a finalTaskId that names its task', () => {
        const draft = baseIR()
        draft.finalTaskId = 'reply'
        draft.tasks[1].name = 'Compose Reply'
        draft.finalTaskId = 'Compose Reply'
        const { ir, validation } = normalizeCrewIR(draft)
        expect(ir.finalTaskId).toBe('reply')
        expect(validation.valid).toBe(true)
    })

    it('renames duplicate output keys instead of failing', () => {
        const draft = baseIR()
        draft.tasks[1].outputKey = draft.tasks[0].outputKey
        const { ir } = normalizeCrewIR(draft)
        expect(new Set(ir.tasks.map((item) => item.outputKey)).size).toBe(2)
    })

    it('rejects a cyclic task graph', () => {
        const draft = baseIR()
        draft.tasks[0].dependsOn = ['reply']
        const { validation } = normalizeCrewIR(draft)
        expect(validation.valid).toBe(false)
        expect(validation.errors.join(' ')).toContain('acyclic')
    })

    it('falls back to a parallel crew when routing is underspecified', () => {
        const draft = { ...baseIR(), process: 'routed', routerAgentId: 'missing_router', routes: [] }
        const { ir, validation } = normalizeCrewIR(draft)
        expect(ir.process).toBe('parallel')
        expect(validation.warnings.join(' ')).toContain('router')
    })

    it('drops a task that duplicates the router decision', () => {
        // The generator reliably designs both a router agent and a
        // "classify the request" task assigned to it. Compiling both produced a
        // condition node plus a redundant LLM node that then had to be cut out
        // of the graph, leaving a dead branch.
        const draft = baseIR()
        draft.agents.push(agent('router_agent', { role: 'router' }), agent('second_agent'))
        draft.tasks.push(task('route_request', 'router_agent'), task('second', 'second_agent', { dependsOn: ['route_request'] }))
        draft.tasks[0].dependsOn = ['route_request']
        const { ir, validation } = normalizeCrewIR({
            ...draft,
            process: 'routed',
            routerAgentId: 'router_agent',
            routes: [
                { taskId: 'lookup', when: 'order question' },
                { taskId: 'second', when: 'anything else' }
            ]
        })
        expect(ir.tasks.map((item) => item.id)).not.toContain('route_request')
        expect(ir.process).toBe('routed')
        expect(validation.warnings.join(' ')).toContain('duplicated')
        // Nothing may still reference the removed task.
        expect(ir.tasks.flatMap((item) => item.dependsOn)).not.toContain('route_request')
    })

    it('falls back to parallel when removing router tasks leaves too few branches', () => {
        const draft = baseIR()
        draft.agents.push(agent('router_agent', { role: 'router' }))
        draft.tasks.push(task('route_request', 'router_agent'))
        const { ir } = normalizeCrewIR({
            ...draft,
            process: 'routed',
            routerAgentId: 'router_agent',
            routes: [
                { taskId: 'lookup', when: 'order question' },
                { taskId: 'route_request', when: 'anything else' }
            ]
        })
        expect(ir.process).toBe('parallel')
    })

    it('clears dependencies on routed branch entry points', () => {
        const draft = baseIR()
        draft.agents.push(agent('router_agent', { role: 'router' }), agent('second_agent'))
        draft.tasks.push(task('second', 'second_agent'))
        draft.tasks[0].dependsOn = ['second']
        const routed = {
            ...draft,
            process: 'routed',
            routerAgentId: 'router_agent',
            routes: [
                { taskId: 'lookup', when: 'the request is about an order' },
                { taskId: 'second', when: 'the request is about anything else' }
            ]
        }
        const { ir } = normalizeCrewIR(routed)
        expect(ir.process).toBe('routed')
        expect(ir.tasks.find((item) => item.id === 'lookup')?.dependsOn).toEqual([])
        // The released upstream task must still converge on the final task.
        expect(ir.tasks.find((item) => item.id === 'reply')?.dependsOn).toContain('second')
    })
})

describe('compileCrewIRFlow', () => {
    it('produces one Start, one Direct Reply and an edge per dependency', () => {
        const { ir } = normalizeCrewIR(baseIR())
        const graph = assertCompiledGraph(compileCrewIRFlow(ir as CrewIR, compileContext()))
        expect(graph.nodes.filter((node) => node.data.name === 'startAgentflow')).toHaveLength(1)
        expect(graph.nodes.filter((node) => node.data.name === 'directReplyAgentflow')).toHaveLength(1)
        expect(graph.nodes).toHaveLength(4)
        expect(graph.edges).toHaveLength(3)
    })

    it('uses an LLM node without tools and an Agent node with tools', () => {
        const draft = baseIR()
        draft.agents[0].tools = ['check_order']
        const { ir } = normalizeCrewIR(draft, ['check_order'])
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext({ toolIdByName: { check_order: 'tool-uuid-1' } }))
        const lookupNode = graph.nodes.find((node) => node.id === graph.nodeIdByTaskId['lookup'])
        expect(lookupNode?.data.name).toBe('agentAgentflow')
        expect(lookupNode?.data.inputs.agentTools).toHaveLength(1)
        expect(lookupNode?.data.inputs.agentTools[0].agentSelectedToolConfig.selectedTool).toBe('tool-uuid-1')
        // The model must see the semantic name, not the hash-suffixed row name.
        expect(lookupNode?.data.inputs.agentTools[0].agentSelectedToolConfig.customToolName).toBe('check_order')
        expect(graph.nodes.find((node) => node.id === graph.nodeIdByTaskId['reply'])?.data.name).toBe('llmAgentflow')
    })

    it('drops a tool binding that was never provisioned', () => {
        const draft = baseIR()
        draft.agents[0].tools = ['check_order']
        const { ir } = normalizeCrewIR(draft, ['check_order'])
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext({ toolIdByName: {} }))
        expect(graph.nodes.find((node) => node.id === graph.nodeIdByTaskId['lookup'])?.data.inputs.agentTools).toEqual([])
    })

    it('wires upstream results into the downstream user message', () => {
        const { ir } = normalizeCrewIR(baseIR())
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext())
        const replyNode = graph.nodes.find((node) => node.id === graph.nodeIdByTaskId['reply'])
        const userMessage = replyNode?.data.inputs.llmMessages.find((message: any) => message.role === 'user')?.content
        expect(userMessage).toContain('{{ question }}')
        expect(userMessage).toContain(`{{ ${graph.nodeIdByTaskId['lookup']}.output.content }}`)
    })

    it('puts the request in the message array, never in the memory-only user-message input', () => {
        // `llmUserMessage` / `agentUserMessage` are only read when memory is
        // enabled, and populating them suppresses the runtime fallback that
        // would otherwise inject the request. Downstream nodes then run with
        // nothing but their system prompt.
        const draft = baseIR()
        draft.agents[0].tools = ['check_order']
        const { ir } = normalizeCrewIR(draft, ['check_order'])
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext({ toolIdByName: { check_order: 'tool-1' } }))
        for (const node of graph.nodes) {
            if (node.data.name === 'agentAgentflow') {
                expect(node.data.inputs.agentUserMessage).toBe('')
                expect(node.data.inputs.agentMessages.map((message: any) => message.role)).toEqual(['system', 'user'])
                expect(node.data.inputs.agentMessages[1].content).toContain('{{ question }}')
            }
            if (node.data.name === 'llmAgentflow') {
                expect(node.data.inputs.llmUserMessage).toBe('')
                expect(node.data.inputs.llmMessages.map((message: any) => message.role)).toEqual(['system', 'user'])
                expect(node.data.inputs.llmMessages[1].content).toContain('{{ question }}')
            }
        }
    })

    it('binds the cheap model tier when one is configured', () => {
        const draft = baseIR()
        draft.agents[0].modelTier = 'cheap'
        const { ir } = normalizeCrewIR(draft)
        const graph = compileCrewIRFlow(
            ir as CrewIR,
            compileContext({ cheapChatModel: { name: 'chatOpenAI', inputs: { modelName: 'gpt-4o-mini' } } })
        )
        expect(graph.nodes.find((node) => node.id === graph.nodeIdByTaskId['lookup'])?.data.inputs.llmModelConfig.modelName).toBe(
            'gpt-4o-mini'
        )
    })

    it('falls back to the default model when the cheap picker was never configured', () => {
        // An empty picker object is truthy; treating it as configured left every
        // cheap-tier node with no model and failed the run on every case.
        const draft = baseIR()
        draft.agents[0].modelTier = 'cheap'
        const { ir } = normalizeCrewIR(draft)
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext({ cheapChatModel: {} }))
        const node = graph.nodes.find((item) => item.id === graph.nodeIdByTaskId['lookup'])
        expect(node?.data.inputs.llmModel).toBe('chatOpenAI')
        expect(node?.data.inputs.llmModelConfig.modelName).toBe('gpt-4o')
    })

    it('rejects a graph with a node that has no model bound', () => {
        const { ir } = normalizeCrewIR(baseIR())
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext())
        const target = graph.nodes.find((node) => node.data.name === 'llmAgentflow') as Record<string, any>
        target.data.inputs.llmModel = ''
        expect(() => assertCompiledGraph(graph)).toThrow(/no chat model bound/)
    })

    it('gives a routed crew one condition anchor per route', () => {
        const draft = baseIR()
        draft.agents.push(agent('router_agent', { role: 'router' }), agent('second_agent'))
        draft.tasks.push(task('second', 'second_agent'))
        draft.tasks[1].dependsOn = ['lookup', 'second']
        const { ir } = normalizeCrewIR({
            ...draft,
            process: 'routed',
            routerAgentId: 'router_agent',
            routes: [
                { taskId: 'lookup', when: 'order question' },
                { taskId: 'second', when: 'anything else' }
            ]
        })
        const graph = assertCompiledGraph(compileCrewIRFlow(ir as CrewIR, compileContext()))
        const router = graph.nodes.find((node) => node.data.name === 'conditionAgentAgentflow')
        expect(router?.data.inputs.conditionAgentScenarios).toHaveLength(2)
        expect(router?.data.outputAnchors).toHaveLength(2)
        expect(graph.edges.filter((edge) => edge.source === router?.id).map((edge) => edge.sourceHandle)).toEqual([
            `${router?.id}-output-0`,
            `${router?.id}-output-1`
        ])
    })

    it('rejects a graph whose final task does not reach Direct Reply', () => {
        const { ir } = normalizeCrewIR(baseIR())
        const graph = compileCrewIRFlow(ir as CrewIR, compileContext())
        graph.edges = graph.edges.filter((edge) => edge.target !== 'directReplyAgentflow_0')
        expect(() => assertCompiledGraph(graph)).toThrow(/Direct Reply/)
    })
})

describe('crewCriticalPathLength', () => {
    it('counts the longest dependency chain', () => {
        const { ir } = normalizeCrewIR(baseIR())
        expect(crewCriticalPathLength(ir)).toBe(2)
    })
})
