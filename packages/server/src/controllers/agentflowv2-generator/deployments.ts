import { Request, Response, NextFunction } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import * as deploymentService from '../../services/agentflowv2-generator/deploymentService'

const contextOf = (req: Request): deploymentService.DeploymentContext => {
    const workspaceId = req.user?.activeWorkspaceId
    const orgId = req.user?.activeOrganizationId
    if (!workspaceId || !orgId) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Error: an active workspace is required for Workflow Autopilot deployments')
    }
    return { workspaceId, orgId, subscriptionId: req.user?.activeOrganizationSubscriptionId || '' }
}

const handle = (action: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        return res.json(await action(req))
    } catch (error) {
        next(error)
    }
}

export default {
    listDeployments: handle((req) => deploymentService.listDeployments(contextOf(req).workspaceId)),
    createDeployment: handle((req) => deploymentService.createDeployment(req.body, contextOf(req))),
    getDeployment: handle((req) => deploymentService.getDeployment(req.params.id, contextOf(req).workspaceId)),
    renameDeployment: handle((req) => deploymentService.renameDeployment(req.params.id, req.body?.name, contextOf(req))),
    deleteDeployment: handle((req) => deploymentService.deleteDeployment(req.params.id, req.query.deleteFlow === 'true', contextOf(req))),
    assessTurn: handle((req) => deploymentService.assessDeploymentTurn(req.params.id, req.body, contextOf(req))),
    patchOnlineCase: handle((req) => deploymentService.patchOnlineCase(req.params.id, req.params.caseId, req.body, contextOf(req))),
    deleteOnlineCase: handle((req) => deploymentService.deleteOnlineCase(req.params.id, req.params.caseId, contextOf(req))),
    saveImprovementRun: handle((req) => deploymentService.saveImprovementRun(req.params.id, req.body?.run, contextOf(req))),
    publishImprovement: handle((req) => deploymentService.publishImprovement(req.params.id, req.body, contextOf(req))),
    rollbackDeployment: handle((req) => deploymentService.rollbackDeployment(req.params.id, req.body, contextOf(req)))
}
