import { isEqual } from 'lodash'

interface IQueueItem {
    nodeId: string
}

interface IFlowNode {
    id: string
    data: {
        name?: string
        inputs?: Record<string, any>
    }
}

interface IFlowEdge {
    source: string
    target: string
}

interface IStateVersion {
    exists: boolean
    value?: any
}

const SAFE_PARALLEL_NODE_TYPES = new Set(['agentAgentflow', 'llmAgentflow'])

const isEnabled = (value: any): boolean => value === true || value === 'true'

const toArray = (value: any): any[] => {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string' || !value.trim()) return []
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

const hasConfiguredValue = (value: any): boolean => {
    if (value === undefined || value === null || value === '') return false
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed || trimmed === '[]' || trimmed === '{}') return false
    }
    if (typeof value === 'object') return Object.keys(value).length > 0
    return Boolean(value)
}

const getStateWriteKeys = (node: IFlowNode): string[] => {
    const inputs = node.data.inputs ?? {}
    const updates = node.data.name === 'agentAgentflow' ? inputs.agentUpdateState : inputs.llmUpdateState
    return toArray(updates)
        .map((update) => update?.key)
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
}

const isSafeParallelNode = (node: IFlowNode | undefined): node is IFlowNode => {
    if (!node?.data?.name || !SAFE_PARALLEL_NODE_TYPES.has(node.data.name)) return false

    const inputs = node.data.inputs ?? {}
    if (node.data.name === 'llmAgentflow') return !isEnabled(inputs.llmEnableMemory)

    if (isEnabled(inputs.agentEnableMemory)) return false

    // Tool calls and retrieval can have external side effects or provider-specific concurrency
    // limits. Keep them on the legacy serial path unless a future scheduler can model them.
    const sideEffectInputs = [
        inputs.agentTools,
        inputs.agentToolsBuiltInOpenAI,
        inputs.agentToolsBuiltInGemini,
        inputs.agentToolsBuiltInAnthropic,
        inputs.agentKnowledgeDocumentStores,
        inputs.agentKnowledgeVSEmbeddings
    ]
    return !sideEffectInputs.some(hasConfiguredValue)
}

const dependencySignature = (nodeId: string, edges: IFlowEdge[]): string => {
    const incoming = edges
        .filter((edge) => edge.target === nodeId)
        .map((edge) => edge.source)
        .sort()
    const outgoing = edges
        .filter((edge) => edge.source === nodeId)
        .map((edge) => edge.target)
        .sort()
    return `${incoming.join(',')}=>${outgoing.join(',')}`
}

/**
 * Selects a deterministic batch of ready sibling nodes.
 *
 * This is intentionally stricter than generic Promise.all: only memoryless Agent/LLM nodes
 * with the same dependency frontier and disjoint declared Flow State writes may run together.
 * Everything else stays on Flowise's existing serial execution path.
 */
export const getParallelExecutionBatch = <T extends IQueueItem>(
    queue: T[],
    nodes: IFlowNode[],
    edges: IFlowEdge[],
    maxConcurrency: number
): T[] => {
    const limit = Math.max(1, Math.floor(maxConcurrency))
    if (limit < 2 || queue.length < 2) return queue.slice(0, 1)

    const firstNode = nodes.find((node) => node.id === queue[0].nodeId)
    if (!isSafeParallelNode(firstNode)) return queue.slice(0, 1)

    const firstSignature = dependencySignature(firstNode.id, edges)
    const usedStateKeys = new Set<string>()
    const batch: T[] = []

    for (const item of queue) {
        if (batch.length >= limit) break

        const node = nodes.find((candidate) => candidate.id === item.nodeId)
        if (!isSafeParallelNode(node) || dependencySignature(node.id, edges) !== firstSignature) break

        const writeKeys = getStateWriteKeys(node)
        if (writeKeys.some((key) => usedStateKeys.has(key))) break

        writeKeys.forEach((key) => usedStateKeys.add(key))
        batch.push(item)
    }

    return batch.length > 1 ? batch : queue.slice(0, 1)
}

const getChangedStateEntries = (baseState: Record<string, any>, nextState: Record<string, any>): Map<string, IStateVersion> => {
    const changes = new Map<string, IStateVersion>()
    const keys = new Set([...Object.keys(baseState), ...Object.keys(nextState)])
    for (const key of keys) {
        const baseExists = Object.prototype.hasOwnProperty.call(baseState, key)
        const nextExists = Object.prototype.hasOwnProperty.call(nextState, key)
        if (baseExists !== nextExists || !isEqual(baseState[key], nextState[key])) {
            changes.set(key, { exists: nextExists, value: nextState[key] })
        }
    }
    return changes
}

/** Merge full state snapshots returned by parallel nodes without last-writer-wins data loss. */
export const mergeParallelStates = (baseState: Record<string, any>, nodeStates: Record<string, any>[]): Record<string, any> => {
    const mergedState = { ...baseState }
    const writes = new Map<string, IStateVersion>()

    for (const nodeState of nodeStates) {
        const changes = getChangedStateEntries(baseState, nodeState ?? {})
        for (const [key, nextVersion] of changes) {
            const existingVersion = writes.get(key)
            if (existingVersion && (existingVersion.exists !== nextVersion.exists || !isEqual(existingVersion.value, nextVersion.value))) {
                throw new Error(`Parallel Flow State conflict on key "${key}"`)
            }

            writes.set(key, nextVersion)
            if (nextVersion.exists) mergedState[key] = nextVersion.value
            else delete mergedState[key]
        }
    }

    return mergedState
}
