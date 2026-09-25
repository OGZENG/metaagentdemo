import { z } from 'zod/v3'
import type { CrewAgent, CrewIR, CrewTask } from './studioSchemas'
import { crewCriticalPathLength, normalizeCrewIR } from './crewIR'

/**
 * The search space.
 *
 * Optimization is a sequence of typed, legality-checked CrewIR → CrewIR
 * mutations. Because every candidate is `(parentIR, operator)` it is
 * reproducible, diffable and ablatable — which prompt-only "optimization"
 * never is, since it cannot change the number of model calls at all.
 */

export const OPERATOR_TYPES = [
    'merge_tasks',
    'merge_agents',
    'remove_task',
    'add_validator',
    'parallelize_task',
    'sequentialize_task',
    'add_router',
    'remove_router',
    'bind_tool',
    'unbind_tool',
    'rewrite_prompt'
] as const

export type OperatorType = (typeof OPERATOR_TYPES)[number]

export const CrewOperatorType = z.object({
    type: z.enum(OPERATOR_TYPES),
    /** operator arguments; unused fields are ignored per type */
    taskIds: z.array(z.string()).default([]),
    agentIds: z.array(z.string()).default([]),
    tool: z.string().default(''),
    goal: z.string().default(''),
    guardrails: z.array(z.string()).default([]),
    note: z.string().default('')
})

export type CrewOperator = z.infer<typeof CrewOperatorType>

export class OperatorNotApplicable extends Error {}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const requireTask = (ir: CrewIR, taskId: string): CrewTask => {
    const task = ir.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new OperatorNotApplicable(`Task ${taskId} does not exist.`)
    return task
}

const requireAgent = (ir: CrewIR, agentId: string): CrewAgent => {
    const agent = ir.agents.find((candidate) => candidate.id === agentId)
    if (!agent) throw new OperatorNotApplicable(`Agent ${agentId} does not exist.`)
    return agent
}

const dropUnusedAgents = (ir: CrewIR) => {
    const used = new Set(ir.tasks.map((task) => task.agentId))
    if (ir.process === 'routed' && ir.routerAgentId) used.add(ir.routerAgentId)
    ir.agents = ir.agents.filter((agent) => used.has(agent.id))
}

const rewireDependents = (ir: CrewIR, removedTaskId: string, replacements: string[]) => {
    for (const task of ir.tasks) {
        if (!task.dependsOn.includes(removedTaskId)) continue
        task.dependsOn = [...new Set([...task.dependsOn.filter((id) => id !== removedTaskId), ...replacements])].filter(
            (id) => id !== task.id
        )
    }
}

/* ------------------------------------------------------------------ *
 * Individual operators
 * ------------------------------------------------------------------ */

const mergeTasks = (ir: CrewIR, operator: CrewOperator) => {
    const [keepId, absorbId] = operator.taskIds
    if (!keepId || !absorbId || keepId === absorbId) throw new OperatorNotApplicable('merge_tasks needs two distinct task ids.')
    const keep = requireTask(ir, keepId)
    const absorb = requireTask(ir, absorbId)
    if (absorb.id === ir.finalTaskId) throw new OperatorNotApplicable('The final task cannot be absorbed.')
    if (keep.dependsOn.includes(absorb.id) || absorb.dependsOn.includes(keep.id)) {
        throw new OperatorNotApplicable('Only independent sibling tasks can be merged.')
    }

    keep.name = `${keep.name} + ${absorb.name}`
    keep.description = `${keep.description}\n\nAlso perform: ${absorb.description}`
    keep.expectedOutput = `${keep.expectedOutput} Additionally: ${absorb.expectedOutput}`
    keep.dependsOn = [...new Set([...keep.dependsOn, ...absorb.dependsOn])].filter((id) => id !== keep.id)

    // The surviving agent must be able to do both jobs.
    const keepAgent = requireAgent(ir, keep.agentId)
    const absorbAgent = requireAgent(ir, absorb.agentId)
    if (keepAgent.id !== absorbAgent.id) {
        keepAgent.tools = [...new Set([...keepAgent.tools, ...absorbAgent.tools])]
        keepAgent.guardrails = [...new Set([...keepAgent.guardrails, ...absorbAgent.guardrails])]
        keepAgent.goal = `${keepAgent.goal} Also: ${absorbAgent.goal}`
    }

    ir.tasks = ir.tasks.filter((task) => task.id !== absorb.id)
    ir.routes = ir.routes.filter((route) => route.taskId !== absorb.id)
    rewireDependents(ir, absorb.id, [keep.id])
    dropUnusedAgents(ir)
    return ir
}

const mergeAgents = (ir: CrewIR, operator: CrewOperator) => {
    const [keepId, absorbId] = operator.agentIds
    if (!keepId || !absorbId || keepId === absorbId) throw new OperatorNotApplicable('merge_agents needs two distinct agent ids.')
    const keep = requireAgent(ir, keepId)
    const absorb = requireAgent(ir, absorbId)
    if (absorb.id === ir.routerAgentId) throw new OperatorNotApplicable('The router agent cannot be absorbed.')
    keep.tools = [...new Set([...keep.tools, ...absorb.tools])]
    keep.guardrails = [...new Set([...keep.guardrails, ...absorb.guardrails])]
    keep.goal = `${keep.goal} Also: ${absorb.goal}`
    for (const task of ir.tasks) if (task.agentId === absorb.id) task.agentId = keep.id
    dropUnusedAgents(ir)
    return ir
}

const removeTask = (ir: CrewIR, operator: CrewOperator) => {
    const [taskId] = operator.taskIds
    const task = requireTask(ir, taskId)
    if (task.id === ir.finalTaskId) throw new OperatorNotApplicable('The final task cannot be removed.')
    if (ir.tasks.length <= 2) throw new OperatorNotApplicable('A crew needs at least two tasks.')
    ir.tasks = ir.tasks.filter((candidate) => candidate.id !== task.id)
    ir.routes = ir.routes.filter((route) => route.taskId !== task.id)
    rewireDependents(ir, task.id, task.dependsOn)
    dropUnusedAgents(ir)
    return ir
}

const addValidator = (ir: CrewIR) => {
    if (ir.agents.some((agent) => agent.role === 'validator')) throw new OperatorNotApplicable('The crew already has a validator.')
    const finalTask = requireTask(ir, ir.finalTaskId)
    const validatorAgent: CrewAgent = {
        id: 'output_validator',
        name: 'Output Validator',
        role: 'validator',
        goal: 'Verify the drafted answer against the success criteria and constraints, then emit the corrected user-facing reply.',
        backstory: '',
        tools: [],
        guardrails: [
            'Emit the corrected reply itself, never a critique or a PASS/FAIL label.',
            'Remove any claim that no tool result supports.'
        ],
        modelTier: 'default'
    }
    const validatorTask: CrewTask = {
        id: 'validate_output',
        name: 'Validate output',
        description: 'Check the drafted answer against every success criterion and constraint, and return the corrected final reply.',
        expectedOutput: 'The final user-facing reply, corrected where necessary.',
        agentId: validatorAgent.id,
        dependsOn: [finalTask.id],
        outputKey: 'validated_output'
    }
    ir.agents = [...ir.agents, validatorAgent]
    ir.tasks = [...ir.tasks, validatorTask]
    ir.finalTaskId = validatorTask.id
    return ir
}

const parallelizeTask = (ir: CrewIR, operator: CrewOperator) => {
    const [taskId] = operator.taskIds
    const task = requireTask(ir, taskId)
    if (task.id === ir.finalTaskId) throw new OperatorNotApplicable('The final task must keep its dependencies.')
    if (!task.dependsOn.length) throw new OperatorNotApplicable(`${task.id} already runs without dependencies.`)
    const released = task.dependsOn
    task.dependsOn = []
    // Released upstream work must still reach the final task.
    const finalTask = requireTask(ir, ir.finalTaskId)
    finalTask.dependsOn = [...new Set([...finalTask.dependsOn, ...released])].filter((id) => id !== finalTask.id)
    return ir
}

const sequentializeTask = (ir: CrewIR, operator: CrewOperator) => {
    const [taskId, afterId] = operator.taskIds
    const task = requireTask(ir, taskId)
    const after = requireTask(ir, afterId)
    if (task.id === after.id) throw new OperatorNotApplicable('sequentialize_task needs two distinct task ids.')
    if (task.dependsOn.includes(after.id)) throw new OperatorNotApplicable(`${task.id} already depends on ${after.id}.`)
    task.dependsOn = [...new Set([...task.dependsOn, after.id])]
    return ir
}

const addRouter = (ir: CrewIR) => {
    if (ir.process === 'routed') throw new OperatorNotApplicable('The crew is already routed.')
    const entryTasks = ir.tasks.filter((task) => !task.dependsOn.length && task.id !== ir.finalTaskId)
    if (entryTasks.length < 2) throw new OperatorNotApplicable('Routing needs at least two independent entry tasks.')
    const routerAgent: CrewAgent = {
        id: 'intent_router',
        name: 'Intent Router',
        role: 'router',
        goal: 'Classify the request and activate only the branch that can serve it.',
        backstory: '',
        tools: [],
        guardrails: ['When a request carries several intents, pick the branch that can preserve all of them.'],
        modelTier: 'default'
    }
    ir.agents = [routerAgent, ...ir.agents.filter((agent) => agent.id !== routerAgent.id)]
    ir.process = 'routed'
    ir.routerAgentId = routerAgent.id
    ir.routes = entryTasks.map((task) => ({ taskId: task.id, when: `The request requires: ${task.name}. ${task.expectedOutput}` }))
    return ir
}

const removeRouter = (ir: CrewIR) => {
    if (ir.process !== 'routed') throw new OperatorNotApplicable('The crew is not routed.')
    ir.process = 'parallel'
    const routerId = ir.routerAgentId
    ir.routerAgentId = ''
    ir.routes = []
    ir.agents = ir.agents.filter((agent) => agent.id !== routerId)
    ir.tasks = ir.tasks.filter((task) => task.agentId !== routerId)
    return ir
}

const bindTool = (ir: CrewIR, operator: CrewOperator) => {
    const agent = requireAgent(ir, operator.agentIds[0])
    if (!operator.tool) throw new OperatorNotApplicable('bind_tool needs a tool name.')
    if (agent.tools.includes(operator.tool)) throw new OperatorNotApplicable(`${agent.id} already uses ${operator.tool}.`)
    // A router classifies and hands off; giving it tools lets it answer from a
    // branch it was supposed to delegate, which the graph cannot then route.
    if (agent.role === 'router') throw new OperatorNotApplicable('A router agent must not call tools.')
    agent.tools = [...agent.tools, operator.tool]
    return ir
}

const unbindTool = (ir: CrewIR, operator: CrewOperator) => {
    const agent = requireAgent(ir, operator.agentIds[0])
    if (!agent.tools.includes(operator.tool)) throw new OperatorNotApplicable(`${agent.id} does not use ${operator.tool}.`)
    agent.tools = agent.tools.filter((tool) => tool !== operator.tool)
    return ir
}

const rewritePrompt = (ir: CrewIR, operator: CrewOperator) => {
    const agent = requireAgent(ir, operator.agentIds[0])
    if (!operator.goal && !operator.guardrails.length) throw new OperatorNotApplicable('rewrite_prompt needs a goal or guardrails.')
    if (operator.goal) agent.goal = operator.goal
    if (operator.guardrails.length) agent.guardrails = [...new Set([...agent.guardrails, ...operator.guardrails])].slice(0, 8)
    return ir
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

export const applyOperator = (
    sourceIR: CrewIR,
    operator: CrewOperator,
    availableToolNames: string[] = []
): { ir: CrewIR; warnings: string[] } => {
    const draft = clone(sourceIR)
    let mutated: CrewIR
    switch (operator.type) {
        case 'merge_tasks':
            mutated = mergeTasks(draft, operator)
            break
        case 'merge_agents':
            mutated = mergeAgents(draft, operator)
            break
        case 'remove_task':
            mutated = removeTask(draft, operator)
            break
        case 'add_validator':
            mutated = addValidator(draft)
            break
        case 'parallelize_task':
            mutated = parallelizeTask(draft, operator)
            break
        case 'sequentialize_task':
            mutated = sequentializeTask(draft, operator)
            break
        case 'add_router':
            mutated = addRouter(draft)
            break
        case 'remove_router':
            mutated = removeRouter(draft)
            break
        case 'bind_tool':
            mutated = bindTool(draft, operator)
            break
        case 'unbind_tool':
            mutated = unbindTool(draft, operator)
            break
        case 'rewrite_prompt':
            mutated = rewritePrompt(draft, operator)
            break
        default:
            throw new OperatorNotApplicable(`Unknown operator ${operator.type}.`)
    }

    const { ir, validation } = normalizeCrewIR(mutated, availableToolNames)
    if (!validation.valid) throw new OperatorNotApplicable(`Operator produced an invalid crew: ${validation.errors.join(' ')}`)
    return { ir, warnings: validation.warnings }
}

/**
 * Identity of an operator application, so a later round can avoid re-proposing
 * something an earlier round already measured. Task/agent pairs are sorted
 * because merging a+b is the same experiment as merging b+a.
 */
export const operatorSignature = (operator: CrewOperator) =>
    [operator.type, [...operator.taskIds].sort().join('|'), [...operator.agentIds].sort().join('|'), operator.tool]
        .filter((part) => part !== '')
        .join(':')

export const describeOperator = (operator: CrewOperator) => {
    switch (operator.type) {
        case 'merge_tasks':
            return `Merge tasks ${operator.taskIds.join(' + ')} into one model call`
        case 'merge_agents':
            return `Merge agent ${operator.agentIds[1]} into ${operator.agentIds[0]}`
        case 'remove_task':
            return `Remove task ${operator.taskIds[0]}`
        case 'add_validator':
            return 'Add an independent output validator'
        case 'parallelize_task':
            return `Run ${operator.taskIds[0]} in parallel instead of after its dependencies`
        case 'sequentialize_task':
            return `Run ${operator.taskIds[0]} only after ${operator.taskIds[1]}`
        case 'add_router':
            return 'Route the request to a single specialist branch'
        case 'remove_router':
            return 'Replace routing with a parallel crew'
        case 'bind_tool':
            return `Give ${operator.agentIds[0]} access to ${operator.tool}`
        case 'unbind_tool':
            return `Remove ${operator.tool} from ${operator.agentIds[0]}`
        case 'rewrite_prompt':
            return `Rewrite the contract of ${operator.agentIds[0]}`
        default:
            return operator.type
    }
}

/* ------------------------------------------------------------------ *
 * Enumeration — the legal neighbourhood of an IR
 * ------------------------------------------------------------------ */

export type OperatorFamily = 'structure' | 'routing' | 'binding' | 'prompt'

export const OPERATOR_FAMILY: Record<OperatorType, OperatorFamily> = {
    merge_tasks: 'structure',
    merge_agents: 'structure',
    remove_task: 'structure',
    add_validator: 'structure',
    parallelize_task: 'structure',
    sequentialize_task: 'structure',
    add_router: 'routing',
    remove_router: 'routing',
    bind_tool: 'binding',
    unbind_tool: 'binding',
    rewrite_prompt: 'prompt'
}

/**
 * Every structural mutation that is legal from here. `rewrite_prompt` is not
 * enumerated because its payload has to be authored from failure evidence.
 */
export const enumerateOperators = (ir: CrewIR, availableToolNames: string[] = []): CrewOperator[] => {
    const candidates: CrewOperator[] = []
    const push = (operator: Partial<CrewOperator> & { type: OperatorType }) => candidates.push(CrewOperatorType.parse({ ...operator }))

    const siblings = ir.tasks.filter((task) => task.id !== ir.finalTaskId)
    for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
            const left = siblings[i]
            const right = siblings[j]
            if (left.dependsOn.includes(right.id) || right.dependsOn.includes(left.id)) continue
            push({ type: 'merge_tasks', taskIds: [left.id, right.id] })
        }
        push({ type: 'remove_task', taskIds: [siblings[i].id] })
        if (siblings[i].dependsOn.length) push({ type: 'parallelize_task', taskIds: [siblings[i].id] })
    }

    if (!ir.agents.some((agent) => agent.role === 'validator')) push({ type: 'add_validator' })
    if (ir.process === 'routed') push({ type: 'remove_router' })
    else if (ir.tasks.filter((task) => !task.dependsOn.length && task.id !== ir.finalTaskId).length >= 2) push({ type: 'add_router' })

    for (const agent of ir.agents) {
        for (const tool of availableToolNames) {
            if (!agent.tools.includes(tool)) push({ type: 'bind_tool', agentIds: [agent.id], tool })
        }
        for (const tool of agent.tools) push({ type: 'unbind_tool', agentIds: [agent.id], tool })
    }

    return candidates.filter((operator) => {
        try {
            applyOperator(ir, operator, availableToolNames)
            return true
        } catch (_) {
            return false
        }
    })
}

/** Cheap static proxy used to break ties before anything is executed. */
export const estimateCrewCost = (ir: CrewIR) => {
    const tierCost = (agentId: string) => (ir.agents.find((agent) => agent.id === agentId)?.modelTier === 'cheap' ? 0.25 : 1)
    const taskCost = ir.tasks.reduce((sum, task) => sum + tierCost(task.agentId), 0)
    return {
        modelCalls: ir.tasks.length + (ir.process === 'routed' ? 1 : 0),
        weightedCalls: taskCost + (ir.process === 'routed' ? 1 : 0),
        criticalPath: crewCriticalPathLength(ir)
    }
}
