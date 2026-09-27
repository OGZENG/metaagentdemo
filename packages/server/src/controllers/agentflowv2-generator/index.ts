import { Request, Response, NextFunction } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import agentflowv2Service from '../../services/agentflowv2-generator'
import { referencedToolIdsForWorkspace } from '../../services/agentflowv2-generator/deploymentService'

const requireWorkspace = (req: Request) => {
    const workspaceId = req.user?.activeWorkspaceId
    const orgId = req.user?.activeOrganizationId
    if (!workspaceId || !orgId) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Error: an active workspace is required for Workflow Autopilot')
    }
    return { workspaceId, orgId }
}

const generateAgentflowv2 = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body.question || !req.body.selectedChatModel) {
            throw new Error('Question and selectedChatModel are required')
        }
        const apiResponse = await agentflowv2Service.generateAgentflowv2(req.body.question, req.body.selectedChatModel)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const designStudioWorkflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, selectedChatModel } = req.body
        if (!goal || !selectedChatModel) throw new Error('Goal and selectedChatModel are required')
        return res.json(await agentflowv2Service.designStudioWorkflow(goal, selectedChatModel))
    } catch (error) {
        next(error)
    }
}

const regenerateStudioScenarios = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, selectedChatModel } = req.body
        if (!goal || !design || !selectedChatModel) throw new Error('Goal, design and selectedChatModel are required')
        return res.json(await agentflowv2Service.regenerateStudioScenarios(goal, design, selectedChatModel))
    } catch (error) {
        next(error)
    }
}

const regenerateStudioCrew = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, selectedChatModel, guidance } = req.body
        if (!goal || !design || !selectedChatModel) throw new Error('Goal, design and selectedChatModel are required')
        return res.json(await agentflowv2Service.regenerateStudioCrew(goal, design, selectedChatModel, guidance || []))
    } catch (error) {
        next(error)
    }
}

const compileStudioWorkflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, crew, selectedChatModel, cheapChatModel, toolBindings } = req.body
        if (!goal || !design || !selectedChatModel) throw new Error('Goal, design and selectedChatModel are required')
        const { workspaceId, orgId } = requireWorkspace(req)
        return res.json(
            await agentflowv2Service.compileStudioWorkflow(
                goal,
                design,
                crew,
                selectedChatModel,
                cheapChatModel,
                workspaceId,
                orgId,
                toolBindings || {}
            )
        )
    } catch (error) {
        next(error)
    }
}

const evaluateStudioOutput = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            goal,
            scenario,
            output,
            toolCalls,
            selectedChatModel,
            successCriteria,
            constraints,
            acceptanceScoreThreshold,
            semanticAssertions,
            judgeTemperature
        } = req.body
        if (!goal || !scenario || typeof output !== 'string' || !selectedChatModel) {
            throw new Error('Goal, scenario, output and selectedChatModel are required')
        }
        return res.json(
            await agentflowv2Service.evaluateStudioOutput(
                goal,
                scenario,
                output,
                toolCalls || [],
                selectedChatModel,
                successCriteria,
                constraints,
                acceptanceScoreThreshold,
                { semanticAssertions, judgeTemperature }
            )
        )
    } catch (error) {
        next(error)
    }
}

const validateStudioTestWorld = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, selectedChatModel, judgeTemperature } = req.body
        if (!goal || !design || !selectedChatModel) throw new Error('Goal, design and selectedChatModel are required')
        return res.json(
            await agentflowv2Service.validateStudioTestWorld(
                goal,
                design,
                selectedChatModel,
                judgeTemperature === undefined ? 0 : judgeTemperature
            )
        )
    } catch (error) {
        next(error)
    }
}

const diagnoseStudioRun = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, trials, selectedChatModel } = req.body
        if (!goal || !design || !trials || !selectedChatModel) throw new Error('Goal, design, trials and selectedChatModel are required')
        return res.json(await agentflowv2Service.diagnoseStudioRun(goal, design, trials, selectedChatModel))
    } catch (error) {
        next(error)
    }
}

const proposeStudioCandidates = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { goal, design, crew, evidence, strategy, count, selectedChatModel, seed, judgeTemperature } = req.body
        if (!goal || !design || !selectedChatModel) throw new Error('Goal, design and selectedChatModel are required')
        return res.json(
            await agentflowv2Service.proposeStudioCandidates(
                goal,
                design,
                crew,
                evidence,
                strategy,
                count,
                selectedChatModel,
                seed,
                judgeTemperature === undefined ? 0 : judgeTemperature
            )
        )
    } catch (error) {
        next(error)
    }
}

const applyStudioOperator = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { design, crew, operator } = req.body
        if (!design || !operator) throw new Error('Design and operator are required')
        return res.json(await agentflowv2Service.applyStudioOperator(design, crew, operator))
    } catch (error) {
        next(error)
    }
}

const purgeStudioTools = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { workspaceId } = requireWorkspace(req)
        return res.json(await agentflowv2Service.purgeStudioTools(workspaceId, await referencedToolIdsForWorkspace(workspaceId)))
    } catch (error) {
        next(error)
    }
}

export default {
    generateAgentflowv2,
    designStudioWorkflow,
    regenerateStudioScenarios,
    regenerateStudioCrew,
    compileStudioWorkflow,
    evaluateStudioOutput,
    validateStudioTestWorld,
    diagnoseStudioRun,
    proposeStudioCandidates,
    applyStudioOperator,
    purgeStudioTools
}
