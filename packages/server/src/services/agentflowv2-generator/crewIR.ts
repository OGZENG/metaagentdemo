import { createHash } from 'crypto'
import { CrewIRType, type CrewAgent, type CrewIR, type CrewTask, type ToolSpec } from './studioSchemas'
import { describeToolEnvironment } from './mockToolCompiler'

/**
 * CrewIR → AgentFlow V2.
 *
 * The LLM never emits nodes, edges or handles. It emits CrewIR — agents, tasks,
 * dependencies, tool bindings — and this module turns that into an executable
 * graph deterministically. Every optimization operates on the IR too, so a
 * candidate is a structured diff rather than a fresh guess at a JSON graph.
 */

export type CrewIRValidation = {
    valid: boolean
    errors: string[]
    warnings: string[]
}

export type CompiledCrewGraph = {
    nodes: Record<string, any>[]
    edges: Record<string, any>[]
    nodeIdByTaskId: Record<string, string>
}

export type CrewCompileContext = {
    componentNodes: Record<string, any>
    initNode: (nodeData: Record<string, any>, newNodeId: string) => Record<string, any>
    selectedChatModel: Record<string, any>
    cheapChatModel?: Record<string, any>
    goal: string
    successCriteria?: string[]
    constraints?: string[]
    toolEnvironment?: ToolSpec[]
    toolIdByName?: Record<string, string>
}

const sanitizeIdPart = (value: string) =>
    String(value || '')
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'node'

export const crewIRHash = (ir: CrewIR) =>
    createHash('sha256')
        .update(
            JSON.stringify({
                process: ir.process,
                agents: ir.agents.map(({ id, role, tools, modelTier }) => ({ id, role, tools, modelTier })),
                tasks: ir.tasks.map(({ id, agentId, dependsOn, outputKey }) => ({ id, agentId, dependsOn, outputKey })),
                routerAgentId: ir.routerAgentId,
                routes: ir.routes,
                finalTaskId: ir.finalTaskId
            })
        )
        .digest('hex')
        .slice(0, 16)

const detectCycle = (tasks: CrewTask[]) => {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const walk = (taskId: string): boolean => {
        if (visiting.has(taskId)) return true
        if (visited.has(taskId)) return false
        visiting.add(taskId)
        const cyclic = (byId.get(taskId)?.dependsOn || []).some(walk)
        visiting.delete(taskId)
        visited.add(taskId)
        return cyclic
    }
    return tasks.some((task) => walk(task.id))
}

/**
 * Repairs the structural mistakes an LLM reliably makes (dangling references,
 * unreachable branches, tools that do not exist) instead of failing the whole
 * generation. Anything that cannot be repaired safely becomes an error.
 */
export const normalizeCrewIR = (input: unknown, availableToolNames: string[] = []): { ir: CrewIR; validation: CrewIRValidation } => {
    const ir = CrewIRType.parse(input)
    const errors: string[] = []
    const warnings: string[] = []
    const available = new Set(availableToolNames)

    const agents: CrewAgent[] = []
    const seenAgentIds = new Set<string>()
    for (const agent of ir.agents) {
        if (seenAgentIds.has(agent.id)) {
            warnings.push(`Duplicate agent id ${agent.id} was dropped.`)
            continue
        }
        seenAgentIds.add(agent.id)
        const missingTools = agent.tools.filter((tool) => !available.has(tool))
        if (missingTools.length) warnings.push(`Agent ${agent.id} referenced unavailable tool(s): ${missingTools.join(', ')}.`)
        agents.push({ ...agent, tools: agent.tools.filter((tool) => available.has(tool)) })
    }
    if (!agents.length) errors.push('At least one agent is required.')

    const agentIds = new Set(agents.map((agent) => agent.id))
    // Tasks routinely name their agent rather than referencing its id
    // ("Support Triage Router" instead of "support_triage_router"). Dropping
    // those tasks emptied the crew and surfaced as an unreadable schema error
    // about `crew.tasks`, so resolve the reference before giving up on it.
    const agentByLooseKey = new Map<string, string>()
    for (const agent of agents) {
        agentByLooseKey.set(sanitizeIdPart(agent.id), agent.id)
        if (!agentByLooseKey.has(sanitizeIdPart(agent.name))) agentByLooseKey.set(sanitizeIdPart(agent.name), agent.id)
    }

    const tasks: CrewTask[] = []
    const seenTaskIds = new Set<string>()
    const seenOutputKeys = new Set<string>()
    for (const task of ir.tasks) {
        if (seenTaskIds.has(task.id)) {
            warnings.push(`Duplicate task id ${task.id} was dropped.`)
            continue
        }
        let agentId = task.agentId
        if (!agentIds.has(agentId)) {
            const resolved = agentByLooseKey.get(sanitizeIdPart(agentId))
            if (!resolved) {
                errors.push(`Task ${task.id} references unknown agent ${task.agentId}.`)
                continue
            }
            warnings.push(`Task ${task.id} named its agent "${task.agentId}"; resolved to ${resolved}.`)
            agentId = resolved
        }
        seenTaskIds.add(task.id)
        let outputKey = task.outputKey
        if (seenOutputKeys.has(outputKey)) {
            outputKey = `${outputKey}_${seenTaskIds.size}`
            warnings.push(`Task ${task.id} had a duplicate output key; renamed to ${outputKey}.`)
        }
        seenOutputKeys.add(outputKey)
        tasks.push({ ...task, agentId, outputKey })
    }
    if (!tasks.length) errors.push('At least one task is required.')

    const taskIds = new Set(tasks.map((task) => task.id))
    for (const task of tasks) {
        const kept = task.dependsOn.filter((dependency) => {
            if (dependency === task.id) {
                warnings.push(`Task ${task.id} depended on itself; the dependency was removed.`)
                return false
            }
            if (!taskIds.has(dependency)) {
                warnings.push(`Task ${task.id} depended on unknown task ${dependency}; the dependency was removed.`)
                return false
            }
            return true
        })
        task.dependsOn = kept
    }
    if (detectCycle(tasks)) errors.push('Task dependencies must be acyclic.')

    const taskByLooseKey = new Map<string, string>()
    for (const task of tasks) {
        taskByLooseKey.set(sanitizeIdPart(task.id), task.id)
        if (!taskByLooseKey.has(sanitizeIdPart(task.name))) taskByLooseKey.set(sanitizeIdPart(task.name), task.id)
    }

    let finalTaskId = ir.finalTaskId
    if (!taskIds.has(finalTaskId) && taskByLooseKey.has(sanitizeIdPart(finalTaskId))) {
        finalTaskId = taskByLooseKey.get(sanitizeIdPart(finalTaskId)) as string
        warnings.push(`finalTaskId named a task rather than referencing its id; resolved to ${finalTaskId}.`)
    }
    if (!taskIds.has(finalTaskId)) {
        const fallback = tasks[tasks.length - 1]
        if (fallback) {
            warnings.push(`Unknown finalTaskId ${finalTaskId}; using ${fallback.id} instead.`)
            finalTaskId = fallback.id
        } else {
            errors.push('finalTaskId does not reference an existing task.')
        }
    }

    let process = ir.process
    let routerAgentId = ir.routerAgentId
    let routes = ir.routes
        .map((route) => {
            if (taskIds.has(route.taskId)) return route
            const resolved = taskByLooseKey.get(sanitizeIdPart(route.taskId))
            return resolved ? { ...route, taskId: resolved } : route
        })
        .filter((route) => taskIds.has(route.taskId))
    if (process === 'routed') {
        if (!agentIds.has(routerAgentId)) {
            warnings.push('Routed process had no valid router agent; falling back to a parallel crew.')
            process = 'parallel'
        } else if (routes.length < 2) {
            warnings.push('Routed process needs at least two routes; falling back to a parallel crew.')
            process = 'parallel'
        } else if (routes.some((route) => route.taskId === finalTaskId)) {
            warnings.push('A route targeted the final task; falling back to a parallel crew.')
            process = 'parallel'
        } else {
            // The router agent *is* the condition node. A task assigned to it
            // would compile into a second node doing the same classification,
            // which then has to be cut out of the graph to keep it legal — the
            // dead branch that broke the very first run.
            const routerTasks = tasks.filter((task) => task.agentId === routerAgentId && task.id !== finalTaskId)
            for (const routerTask of routerTasks) {
                const index = tasks.findIndex((task) => task.id === routerTask.id)
                if (index >= 0) tasks.splice(index, 1)
                for (const task of tasks) {
                    if (!task.dependsOn.includes(routerTask.id)) continue
                    task.dependsOn = [...new Set([...task.dependsOn.filter((id) => id !== routerTask.id), ...routerTask.dependsOn])].filter(
                        (id) => id !== task.id
                    )
                }
                routes = routes.filter((route) => route.taskId !== routerTask.id)
                warnings.push(
                    `Task ${routerTask.id} duplicated the router's own decision; it was removed because the routing node already makes it.`
                )
            }

            if (routes.length < 2) {
                warnings.push('Routing was left with fewer than two branches; falling back to a parallel crew.')
                process = 'parallel'
            } else {
                // A routed branch is an entry point: the router, not another
                // task, decides whether it runs at all.
                for (const route of routes) {
                    const target = tasks.find((task) => task.id === route.taskId)
                    if (target?.dependsOn.length) {
                        warnings.push(`Route target ${target.id} had upstream dependencies; they were removed so the router can gate it.`)
                        target.dependsOn = []
                    }
                }
            }
        }
    }
    if (process !== 'routed') {
        routerAgentId = ''
        routes = []
    }

    // Every branch must converge on the final task, otherwise the graph would
    // contain a terminal node that never reaches Direct Reply.
    const finalTask = tasks.find((task) => task.id === finalTaskId)
    if (finalTask) {
        const hasDependents = new Set(tasks.flatMap((task) => task.dependsOn))
        const orphanTerminals = tasks.filter((task) => task.id !== finalTaskId && !hasDependents.has(task.id))
        if (orphanTerminals.length) {
            finalTask.dependsOn = [...new Set([...finalTask.dependsOn, ...orphanTerminals.map((task) => task.id)])]
            warnings.push(`Attached unreachable task(s) ${orphanTerminals.map((task) => task.id).join(', ')} to the final task.`)
        }
        if (tasks.some((task) => task.dependsOn.includes(finalTaskId))) {
            errors.push('The final task must not be a dependency of another task.')
        }
    }

    return {
        ir: { version: 1, process, agents, tasks, routerAgentId, routes, finalTaskId },
        validation: { valid: errors.length === 0, errors, warnings }
    }
}

/* ------------------------------------------------------------------ *
 * Graph compilation
 * ------------------------------------------------------------------ */

const START_NODE_ID = 'startAgentflow_0'
const ROUTER_NODE_ID = 'conditionAgentAgentflow_0'
const REPLY_NODE_ID = 'directReplyAgentflow_0'

export const crewTaskNodeId = (task: CrewTask, agent: CrewAgent) =>
    `${agent.tools.length ? 'agentAgentflow' : 'llmAgentflow'}_${sanitizeIdPart(task.id)}`

const runtimeModelInputs = (selectedChatModel: Record<string, any>) => {
    const inputs = { ...(selectedChatModel?.inputs || {}) }
    const credential = selectedChatModel?.credential || inputs.FLOWISE_CREDENTIAL_ID
    if (credential) inputs.FLOWISE_CREDENTIAL_ID = credential
    return inputs
}

const buildAgentSystemPrompt = (
    agent: CrewAgent,
    task: CrewTask,
    context: CrewCompileContext,
    dependencies: CrewTask[],
    isFinal: boolean
) => {
    const successCriteria = context.successCriteria?.length ? context.successCriteria.map((item) => `- ${item}`).join('\n') : ''
    const constraints = context.constraints?.length ? context.constraints.map((item) => `- ${item}`).join('\n') : ''
    const agentTools = (context.toolEnvironment || []).filter((tool) => agent.tools.includes(tool.name))

    return [
        `# Role\nYou are ${agent.name} (${agent.role}).`,
        agent.backstory ? `# Backstory\n${agent.backstory}` : '',
        `# Agent goal\n${agent.goal}`,
        `# Business objective\n${context.goal}`,
        successCriteria ? `# Success criteria\n${successCriteria}` : '',
        constraints ? `# Constraints\n${constraints}` : '',
        `# Your task: ${task.name}\n${task.description}`,
        `# Expected output\n${task.expectedOutput}`,
        dependencies.length
            ? `# Context you receive\n${dependencies
                  .map((dependency) => `- ${dependency.outputKey}: ${dependency.expectedOutput}`)
                  .join('\n')}`
            : '',
        agentTools.length
            ? `# Tools\nCall these tools to obtain facts. Never state a looked-up fact you did not receive from a tool.\n${describeToolEnvironment(
                  agentTools
              )}\nA tool result is JSON. \`ok:true\` means the data is authoritative. \`ok:false\` means the record does not exist or the service failed — report that honestly instead of inventing a value.`
            : '# Tools\nYou have no tools. Work only from the request and the context above.',
        agent.guardrails.length ? `# Guardrails\n${agent.guardrails.map((rule) => `- ${rule}`).join('\n')}` : '',
        '# Execution protocol\nThe complete user request is already supplied in your message. Process it now. Never ask the user to resend, paste or repeat it.',
        isFinal
            ? '# Final answer\nYou produce the user-facing answer. Return the complete reply only — no internal commentary, no PASS/FAIL labels, no instructions addressed to other agents.'
            : '# Handoff\nReturn a concise, concrete result for downstream tasks. Do not address the end user.'
    ]
        .filter(Boolean)
        .join('\n\n')
}

const buildUserMessage = (dependencies: { outputKey: string; nodeId: string }[]) =>
    [
        '**Original user request (already supplied):**\n{{ question }}',
        ...dependencies.map((dependency) => `**${dependency.outputKey}:**\n{{ ${dependency.nodeId}.output.content }}`)
    ].join('\n\n')

export const compileCrewIRFlow = (ir: CrewIR, context: CrewCompileContext): CompiledCrewGraph => {
    const nodes: Record<string, any>[] = []
    const edges: Record<string, any>[] = []
    const agentById = new Map(ir.agents.map((agent) => [agent.id, agent]))
    const taskById = new Map(ir.tasks.map((task) => [task.id, task]))
    const nodeIdByTaskId: Record<string, string> = {}

    const createNode = (id: string, name: string, label: string, position: { x: number; y: number }) => {
        const definition = context.componentNodes[name]
        if (!definition) throw new Error(`Crew compilation failed: component ${name} is unavailable.`)
        const data = context.initNode(JSON.parse(JSON.stringify(definition)), id)
        data.label = label
        data.inputs = data.inputs || {}
        const node = {
            id,
            type: 'agentFlow',
            position,
            width: name === 'directReplyAgentflow' ? 204 : 300,
            height: name === 'directReplyAgentflow' ? 66 : 100,
            selected: false,
            data
        }
        nodes.push(node)
        return node
    }

    const connect = (source: Record<string, any>, target: Record<string, any>, sourceHandle?: string, edgeLabel?: string) => {
        const handle = sourceHandle || `${source.id}-output-${source.data?.name || 'agentflow'}`
        edges.push({
            id: `${source.id}-${handle}-${target.id}-${target.id}`,
            type: 'agentFlow',
            source: source.id,
            sourceHandle: handle,
            target: target.id,
            targetHandle: target.id,
            data: {
                sourceColor: source.data?.color,
                targetColor: target.data?.color,
                ...(edgeLabel ? { edgeLabel } : {}),
                isHumanInput: false
            }
        })
    }

    // Layout: depth-ordered columns so the generated canvas stays readable.
    const depthOf = new Map<string, number>()
    const resolveDepth = (taskId: string): number => {
        if (depthOf.has(taskId)) return depthOf.get(taskId) as number
        const task = taskById.get(taskId)
        const depth = task && task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(resolveDepth)) : 0
        depthOf.set(taskId, depth)
        return depth
    }
    ir.tasks.forEach((task) => resolveDepth(task.id))
    const columnOffset = ir.process === 'routed' ? 2 : 1
    const rowByColumn = new Map<number, number>()

    const start = createNode(START_NODE_ID, 'startAgentflow', 'Start', { x: 0, y: 240 })
    start.data.inputs.startInputType = 'chatInput'

    const routedTaskIds = new Set(ir.process === 'routed' ? ir.routes.map((route) => route.taskId) : [])
    let router: Record<string, any> | undefined
    if (ir.process === 'routed') {
        const routerAgent = agentById.get(ir.routerAgentId) as CrewAgent
        router = createNode(ROUTER_NODE_ID, 'conditionAgentAgentflow', routerAgent.name, { x: 320, y: 240 })
        connect(start, router)
    }

    for (const task of ir.tasks) {
        const agent = agentById.get(task.agentId) as CrewAgent
        const nodeId = crewTaskNodeId(task, agent)
        nodeIdByTaskId[task.id] = nodeId
        const column = (depthOf.get(task.id) || 0) + columnOffset
        const row = rowByColumn.get(column) || 0
        rowByColumn.set(column, row + 1)
        createNode(nodeId, agent.tools.length ? 'agentAgentflow' : 'llmAgentflow', `${agent.name} · ${task.name}`, {
            x: column * 360,
            y: row * 200
        })
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    for (const task of ir.tasks) {
        const node = nodeById.get(nodeIdByTaskId[task.id]) as Record<string, any>
        for (const dependency of task.dependsOn) {
            connect(nodeById.get(nodeIdByTaskId[dependency]) as Record<string, any>, node)
        }
        if (!task.dependsOn.length) {
            if (router && routedTaskIds.has(task.id)) {
                const routeIndex = ir.routes.findIndex((route) => route.taskId === task.id)
                connect(router, node, `${ROUTER_NODE_ID}-output-${routeIndex}`, String(routeIndex))
            } else {
                connect(start, node)
            }
        }
    }

    if (router) {
        const routerAgent = agentById.get(ir.routerAgentId) as CrewAgent
        router.data.inputs.conditionAgentModel = context.selectedChatModel.name
        router.data.inputs.conditionAgentModelConfig = {
            ...runtimeModelInputs(context.selectedChatModel),
            conditionAgentModel: context.selectedChatModel.name
        }
        router.data.inputs.conditionAgentInput = '{{ question }}'
        router.data.inputs.conditionAgentScenarios = ir.routes.map((route) => ({ scenario: route.when }))
        router.data.inputs.conditionAgentInstructions = [
            routerAgent.goal,
            ...routerAgent.guardrails,
            'Select the single branch that best serves the request. When a request carries several intents, choose the branch that can preserve all of them.'
        ].join(' ')
        router.data.inputs.conditionAgentEnableMemory = false
        // One anchor per route, matching the numeric handle format the runtime
        // uses to decide which branch to ignore. `data.outputs` stays as
        // initNode produced it, keyed by component name like every other node.
        router.data.outputAnchors = ir.routes.map((route, index) => ({
            id: `${ROUTER_NODE_ID}-output-${index}`,
            name: index,
            label: index,
            description: route.when
        }))
    }

    for (const task of ir.tasks) {
        const agent = agentById.get(task.agentId) as CrewAgent
        const node = nodeById.get(nodeIdByTaskId[task.id]) as Record<string, any>
        const dependencies = task.dependsOn.map((dependency) => taskById.get(dependency) as CrewTask)
        const isFinal = task.id === ir.finalTaskId
        const systemPrompt = buildAgentSystemPrompt(agent, task, context, dependencies, isFinal)
        const userMessage = buildUserMessage(
            dependencies.map((dependency) => ({ outputKey: dependency.outputKey, nodeId: nodeIdByTaskId[dependency.id] }))
        )
        // An unconfigured picker sends `{}`, which is truthy: every agent on the
        // cheap tier then compiled with no model at all and the run died on
        // "Model is required". Only a model that names a component counts.
        const cheapModel = context.cheapChatModel?.name ? context.cheapChatModel : undefined
        const model = agent.modelTier === 'cheap' && cheapModel ? cheapModel : context.selectedChatModel
        if (!model?.name) throw new Error(`Crew compilation failed: no chat model is configured for ${agent.name}.`)
        const modelInputs = runtimeModelInputs(model)

        if (agent.tools.length) {
            node.data.inputs.agentModel = model.name
            node.data.inputs.agentModelConfig = { ...modelInputs, agentModel: model.name }
            // The request goes into the message array, not into `agentUserMessage`.
            // That input is only read when memory is enabled, and setting it also
            // suppresses the runtime's own fallback — which together leave every
            // downstream node with nothing but its system prompt.
            node.data.inputs.agentMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
            node.data.inputs.agentUserMessage = ''
            node.data.inputs.agentTools = agent.tools
                .filter((tool) => context.toolIdByName?.[tool])
                .map((tool) => {
                    const spec = (context.toolEnvironment || []).find((candidate) => candidate.name === tool)
                    return {
                        agentSelectedTool: 'customTool',
                        agentSelectedToolRequiresHumanInput: false,
                        agentSelectedToolConfig: {
                            selectedTool: context.toolIdByName?.[tool],
                            agentSelectedTool: 'customTool',
                            // Storage rows are hash-suffixed; the model must see
                            // the semantic name it was told to call.
                            customToolName: tool,
                            customToolDesc: spec?.description || tool
                        }
                    }
                })
            node.data.inputs.agentToolsBuiltInOpenAI = []
            node.data.inputs.agentToolsBuiltInGemini = []
            node.data.inputs.agentToolsBuiltInAnthropic = []
            node.data.inputs.agentEnableMemory = false
            node.data.inputs.agentReturnResponseAs = 'assistantMessage'
        } else {
            node.data.inputs.llmModel = model.name
            node.data.inputs.llmModelConfig = { ...modelInputs, llmModel: model.name }
            node.data.inputs.llmMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
            node.data.inputs.llmUserMessage = ''
            node.data.inputs.llmEnableMemory = false
            node.data.inputs.llmReturnResponseAs = 'assistantMessage'
        }
    }

    const finalNodeId = nodeIdByTaskId[ir.finalTaskId]
    const finalColumn = (depthOf.get(ir.finalTaskId) || 0) + columnOffset + 1
    const reply = createNode(REPLY_NODE_ID, 'directReplyAgentflow', 'Direct Reply', { x: finalColumn * 360, y: 240 })
    reply.data.inputs.directReplyMessage = `<p>{{ ${finalNodeId}.output.content }}</p>`
    connect(nodeById.get(finalNodeId) as Record<string, any>, reply)

    return { nodes, edges, nodeIdByTaskId }
}

/**
 * Structural sanity checks on the emitted graph. These mirror the invariants
 * the AgentFlow runtime enforces, so a failure here is always a compiler bug
 * rather than a runtime surprise mid-experiment.
 */
export const assertCompiledGraph = (graph: CompiledCrewGraph) => {
    const { nodes, edges } = graph
    const nodeIds = new Set(nodes.map((node) => node.id))
    const starts = nodes.filter((node) => node.data?.name === 'startAgentflow')
    const replies = nodes.filter((node) => node.data?.name === 'directReplyAgentflow')
    if (starts.length !== 1) throw new Error(`Crew compilation failed: expected one Start node, found ${starts.length}.`)
    if (replies.length !== 1) throw new Error(`Crew compilation failed: expected one Direct Reply node, found ${replies.length}.`)

    for (const edge of edges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
            throw new Error(`Crew compilation failed: edge ${edge.id} references a missing node.`)
        }
    }
    if (edges.some((edge) => edge.target === starts[0].id)) throw new Error('Crew compilation failed: Start must not have incoming edges.')
    if (edges.filter((edge) => edge.target === replies[0].id).length !== 1 || edges.some((edge) => edge.source === replies[0].id)) {
        throw new Error('Crew compilation failed: Direct Reply must have exactly one incoming edge and no outgoing edges.')
    }

    // A node without a model compiles fine and then fails on every single case,
    // which reads as a broken crew rather than a broken binding.
    const MODEL_INPUT_BY_NODE: Record<string, string> = {
        llmAgentflow: 'llmModel',
        agentAgentflow: 'agentModel',
        conditionAgentAgentflow: 'conditionAgentModel'
    }
    for (const node of nodes) {
        const modelInput = MODEL_INPUT_BY_NODE[node.data?.name]
        if (!modelInput) continue
        if (!node.data?.inputs?.[modelInput]) {
            throw new Error(`Crew compilation failed: ${node.data?.label || node.id} has no chat model bound.`)
        }
    }

    const indegree = new Map(nodes.map((node) => [node.id, 0]))
    for (const edge of edges) indegree.set(edge.target, Number(indegree.get(edge.target) || 0) + 1)
    const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
    let visited = 0
    while (queue.length) {
        const current = queue.shift() as string
        visited += 1
        for (const edge of edges.filter((candidate) => candidate.source === current)) {
            const next = Number(indegree.get(edge.target) || 0) - 1
            indegree.set(edge.target, next)
            if (next === 0) queue.push(edge.target)
        }
    }
    if (visited !== nodes.length) throw new Error('Crew compilation failed: the graph contains a cycle.')

    const reverse = new Map<string, string[]>()
    for (const edge of edges) reverse.set(edge.target, [...(reverse.get(edge.target) || []), edge.source])
    const reachesReply = new Set<string>([replies[0].id])
    const backlog = [replies[0].id]
    while (backlog.length) {
        const current = backlog.shift() as string
        for (const source of reverse.get(current) || []) {
            if (!reachesReply.has(source)) {
                reachesReply.add(source)
                backlog.push(source)
            }
        }
    }
    const deadEnds = nodes.filter((node) => !reachesReply.has(node.id))
    if (deadEnds.length) {
        throw new Error(
            `Crew compilation failed: every path must converge on Direct Reply; disconnected: ${deadEnds
                .map((node) => node.data?.label || node.id)
                .join(', ')}.`
        )
    }
    return graph
}

export const crewCriticalPathLength = (ir: CrewIR) => {
    const byId = new Map(ir.tasks.map((task) => [task.id, task]))
    const cache = new Map<string, number>()
    const depth = (taskId: string): number => {
        if (cache.has(taskId)) return cache.get(taskId) as number
        const task = byId.get(taskId)
        const value = task && task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(depth)) : 0
        cache.set(taskId, value)
        return value
    }
    return ir.tasks.reduce((longest, task) => Math.max(longest, depth(task.id) + 1), 0)
}

export const summarizeCrewIR = (ir: CrewIR) => ({
    process: ir.process,
    agentCount: ir.agents.length,
    taskCount: ir.tasks.length,
    toolBindings: ir.agents.reduce((sum, agent) => sum + agent.tools.length, 0),
    criticalPath: crewCriticalPathLength(ir),
    hash: crewIRHash(ir)
})
