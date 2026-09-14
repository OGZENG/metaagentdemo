import { StatusCodes } from 'http-status-codes'
import { In } from 'typeorm'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { Execution } from '../../database/entities/Execution'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ExecutionState, IAgentflowExecutedData } from '../../Interface'
import { _removeCredentialId } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

export interface ExecutionFilters {
    id?: string
    agentflowId?: string
    agentflowName?: string
    sessionId?: string
    state?: ExecutionState
    startDate?: Date
    endDate?: Date
    page?: number
    limit?: number
    workspaceId?: string
}

export interface AnalyticsFilters {
    agentflowId?: string
    sessionId?: string
    startDate?: Date
    endDate?: Date
    workspaceId?: string
    limit?: number
}

const numberValue = (...values: any[]): number => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '')
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

const getExecutionAnalytics = async (filters: AnalyticsFilters = {}) => {
    try {
        const appServer = getRunningExpressApp()
        const { agentflowId, sessionId, startDate, endDate, workspaceId, limit = 1000 } = filters
        const queryBuilder = appServer.AppDataSource.getRepository(Execution)
            .createQueryBuilder('execution')
            .leftJoinAndSelect('execution.agentflow', 'agentflow')
            .orderBy('execution.createdDate', 'DESC')
            .take(Math.min(Math.max(limit, 1), 5000))

        if (workspaceId) queryBuilder.andWhere('execution.workspaceId = :workspaceId', { workspaceId })
        if (agentflowId) queryBuilder.andWhere('execution.agentflowId = :agentflowId', { agentflowId })
        if (sessionId) queryBuilder.andWhere('execution.sessionId = :sessionId', { sessionId })
        if (startDate) queryBuilder.andWhere('execution.createdDate >= :startDate', { startDate })
        if (endDate) queryBuilder.andWhere('execution.createdDate <= :endDate', { endDate })

        const executions = await queryBuilder.getMany()
        const nodes: any[] = []
        let inputTokens = 0
        let outputTokens = 0
        let totalTokens = 0
        let estimatedCost = 0

        for (const execution of executions) {
            let executionData: IAgentflowExecutedData[] = []
            try {
                executionData = typeof execution.executionData === 'string' ? JSON.parse(execution.executionData) : execution.executionData
                if (!Array.isArray(executionData)) executionData = []
            } catch (_) {
                executionData = []
            }

            for (const node of executionData) {
                const output = (node?.data as any)?.output || {}
                const usage = output.usageMetadata || output.usage_metadata
                if (!usage) continue

                const nodeInputTokens = numberValue(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
                const nodeOutputTokens = numberValue(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
                const nodeTotalTokens = numberValue(usage.total_tokens, usage.totalTokens, nodeInputTokens + nodeOutputTokens)
                const nodeCost = numberValue(usage.total_cost, usage.totalCost, usage.cost)
                const durationMs = numberValue(output.timeMetadata?.delta, output.time_metadata?.delta)
                const nodeInput = (node?.data as any)?.input || {}
                const model =
                    nodeInput.modelName ||
                    nodeInput.agentModelConfig?.modelName ||
                    nodeInput.llmModelConfig?.modelName ||
                    output.responseMetadata?.model_name ||
                    output.responseMetadata?.model ||
                    'Unknown'

                inputTokens += nodeInputTokens
                outputTokens += nodeOutputTokens
                totalTokens += nodeTotalTokens
                estimatedCost += nodeCost
                nodes.push({
                    executionId: execution.id,
                    agentflowId: execution.agentflowId,
                    agentflowName: execution.agentflow?.name || 'Untitled Agentflow',
                    nodeId: node.nodeId,
                    nodeName: node.nodeLabel || node.nodeId,
                    model,
                    inputTokens: nodeInputTokens,
                    outputTokens: nodeOutputTokens,
                    totalTokens: nodeTotalTokens,
                    cost: nodeCost,
                    durationMs,
                    validationStatus: output.validation_status || output.validationStatus,
                    status: node.status || execution.state,
                    createdDate: execution.createdDate
                })
            }
        }

        const successfulRuns = executions.filter((execution) => execution.state === 'FINISHED').length
        const validationPasses = nodes.filter((node) => node.validationStatus === 'PASS').length
        const validationRevisions = nodes.filter((node) => node.validationStatus === 'REVISE').length
        const totalDurationMs = executions.reduce(
            (sum, execution) => sum + Math.max(0, new Date(execution.updatedDate).getTime() - new Date(execution.createdDate).getTime()),
            0
        )
        const dailyMap = new Map<string, { date: string; runs: number; totalTokens: number; estimatedCost: number }>()
        const runs = executions.map((execution) => {
            const executionNodes = nodes.filter((node) => node.executionId === execution.id)
            return {
                executionId: execution.id,
                agentflowId: execution.agentflowId,
                agentflowName: execution.agentflow?.name || 'Untitled Agentflow',
                sessionId: execution.sessionId,
                state: execution.state,
                createdDate: execution.createdDate,
                updatedDate: execution.updatedDate,
                durationMs: Math.max(0, new Date(execution.updatedDate).getTime() - new Date(execution.createdDate).getTime()),
                inputTokens: executionNodes.reduce((sum, node) => sum + node.inputTokens, 0),
                outputTokens: executionNodes.reduce((sum, node) => sum + node.outputTokens, 0),
                totalTokens: executionNodes.reduce((sum, node) => sum + node.totalTokens, 0),
                estimatedCost: executionNodes.reduce((sum, node) => sum + node.cost, 0),
                measuredNodes: executionNodes.length
            }
        })
        for (const execution of executions) {
            const date = new Date(execution.createdDate).toISOString().slice(0, 10)
            const current = dailyMap.get(date) || { date, runs: 0, totalTokens: 0, estimatedCost: 0 }
            current.runs += 1
            const executionNodes = nodes.filter((node) => node.executionId === execution.id)
            current.totalTokens += executionNodes.reduce((sum, node) => sum + node.totalTokens, 0)
            current.estimatedCost += executionNodes.reduce((sum, node) => sum + node.cost, 0)
            dailyMap.set(date, current)
        }

        const aggregateUsage = (key: 'nodeName' | 'model') => {
            const usageMap = new Map<string, any>()
            for (const node of nodes) {
                const name = node[key] || 'Unknown'
                const current = usageMap.get(name) || {
                    name,
                    calls: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    estimatedCost: 0,
                    totalDurationMs: 0,
                    errors: 0
                }
                current.calls += 1
                current.inputTokens += node.inputTokens
                current.outputTokens += node.outputTokens
                current.totalTokens += node.totalTokens
                current.estimatedCost += node.cost
                current.totalDurationMs += node.durationMs
                if (node.status === 'ERROR') current.errors += 1
                usageMap.set(name, current)
            }
            return Array.from(usageMap.values())
                .map((item) => ({
                    ...item,
                    averageDurationMs: item.calls ? item.totalDurationMs / item.calls : 0,
                    errorRate: item.calls ? (item.errors / item.calls) * 100 : 0
                }))
                .sort((a, b) => b.totalTokens - a.totalTokens)
        }

        return {
            summary: {
                totalRuns: executions.length,
                successfulRuns,
                successRate: executions.length ? (successfulRuns / executions.length) * 100 : 0,
                inputTokens,
                outputTokens,
                totalTokens,
                estimatedCost,
                validationPasses,
                validationRevisions,
                firstPassRate:
                    validationPasses + validationRevisions
                        ? (validationPasses / (validationPasses + validationRevisions)) * 100
                        : 0,
                averageDurationMs: executions.length ? totalDurationMs / executions.length : 0
            },
            daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
            runs,
            agents: aggregateUsage('nodeName'),
            models: aggregateUsage('model'),
            nodes
        }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getExecutionAnalytics - ${getErrorMessage(error)}`
        )
    }
}

const getExecutionById = async (executionId: string, workspaceId?: string): Promise<Execution | null> => {
    try {
        const appServer = getRunningExpressApp()
        const executionRepository = appServer.AppDataSource.getRepository(Execution)

        const query: any = { id: executionId }
        // Add workspace filtering if provided
        if (workspaceId) query.workspaceId = workspaceId

        const res = await executionRepository.findOne({ where: query })
        if (!res) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Execution ${executionId} not found`)
        }
        return res
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getExecutionById - ${getErrorMessage(error)}`
        )
    }
}

const getPublicExecutionById = async (executionId: string): Promise<Execution | null> => {
    try {
        const appServer = getRunningExpressApp()
        const executionRepository = appServer.AppDataSource.getRepository(Execution)
        const res = await executionRepository.findOne({ where: { id: executionId, isPublic: true } })
        if (!res) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Execution ${executionId} not found`)
        }
        const executionData = typeof res?.executionData === 'string' ? JSON.parse(res?.executionData) : res?.executionData
        const executionDataWithoutCredentialId = executionData.map((data: IAgentflowExecutedData) => _removeCredentialId(data))
        const stringifiedExecutionData = JSON.stringify(executionDataWithoutCredentialId)
        return { ...res, executionData: stringifiedExecutionData }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getPublicExecutionById - ${getErrorMessage(error)}`
        )
    }
}

const getAllExecutions = async (filters: ExecutionFilters = {}): Promise<{ data: Execution[]; total: number }> => {
    try {
        const appServer = getRunningExpressApp()
        const { id, agentflowId, agentflowName, sessionId, state, startDate, endDate, page = 1, limit = 12, workspaceId } = filters

        // Handle UUID fields properly using raw parameters to avoid type conversion issues
        // This uses the query builder instead of direct objects for compatibility with UUID fields
        const queryBuilder = appServer.AppDataSource.getRepository(Execution)
            .createQueryBuilder('execution')
            .leftJoinAndSelect('execution.agentflow', 'agentflow')
            .orderBy('execution.updatedDate', 'DESC')
            .skip((page - 1) * limit)
            .take(limit)

        if (id) queryBuilder.andWhere('execution.id = :id', { id })
        if (agentflowId) queryBuilder.andWhere('execution.agentflowId = :agentflowId', { agentflowId })
        if (agentflowName)
            queryBuilder.andWhere('LOWER(agentflow.name) LIKE LOWER(:agentflowName)', { agentflowName: `%${agentflowName}%` })
        if (sessionId) queryBuilder.andWhere('execution.sessionId = :sessionId', { sessionId })
        if (state) queryBuilder.andWhere('execution.state = :state', { state })
        if (workspaceId) queryBuilder.andWhere('execution.workspaceId = :workspaceId', { workspaceId })

        // Date range conditions
        if (startDate && endDate) {
            queryBuilder.andWhere('execution.createdDate BETWEEN :startDate AND :endDate', { startDate, endDate })
        } else if (startDate) {
            queryBuilder.andWhere('execution.createdDate >= :startDate', { startDate })
        } else if (endDate) {
            queryBuilder.andWhere('execution.createdDate <= :endDate', { endDate })
        }

        const [data, total] = await queryBuilder.getManyAndCount()

        return { data, total }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getAllExecutions - ${getErrorMessage(error)}`
        )
    }
}

const updateExecution = async (executionId: string, data: Partial<Execution>, workspaceId?: string): Promise<Execution | null> => {
    try {
        const appServer = getRunningExpressApp()

        const query: any = { id: executionId }
        // Add workspace filtering if provided
        if (workspaceId) query.workspaceId = workspaceId

        const execution = await appServer.AppDataSource.getRepository(Execution).findOneBy(query)
        if (!execution) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Execution ${executionId} not found`)
        }
        const updateExecution = new Execution()
        Object.assign(updateExecution, data)
        await appServer.AppDataSource.getRepository(Execution).merge(execution, updateExecution)
        const dbResponse = await appServer.AppDataSource.getRepository(Execution).save(execution)
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.updateExecution - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Delete multiple executions by their IDs
 * @param executionIds Array of execution IDs to delete
 * @param workspaceId Optional workspace ID to filter executions
 * @returns Object with success status and count of deleted executions
 */
const deleteExecutions = async (executionIds: string[], workspaceId?: string): Promise<{ success: boolean; deletedCount: number }> => {
    try {
        const appServer = getRunningExpressApp()
        const executionRepository = appServer.AppDataSource.getRepository(Execution)

        // Create the where condition with workspace filtering if provided
        const whereCondition: any = { id: In(executionIds) }
        if (workspaceId) whereCondition.workspaceId = workspaceId

        // Delete executions where id is in the provided array and belongs to the workspace
        const result = await executionRepository.delete(whereCondition)

        // Update chat message executionId column to NULL
        await appServer.AppDataSource.getRepository(ChatMessage).update({ executionId: In(executionIds) }, { executionId: null as any })

        return {
            success: true,
            deletedCount: result.affected || 0
        }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.deleteExecutions - ${getErrorMessage(error)}`
        )
    }
}

export default {
    getExecutionAnalytics,
    getExecutionById,
    getAllExecutions,
    deleteExecutions,
    getPublicExecutionById,
    updateExecution
}
