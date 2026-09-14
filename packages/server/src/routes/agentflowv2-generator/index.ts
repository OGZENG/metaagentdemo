import express from 'express'
import agentflowv2GeneratorController from '../../controllers/agentflowv2-generator'
import deploymentsController from '../../controllers/agentflowv2-generator/deployments'
import { checkAnyPermission } from '../../enterprise/rbac/PermissionCheck'
const router = express.Router()

router.post('/generate', agentflowv2GeneratorController.generateAgentflowv2)

// Workflow Autopilot
router.post('/studio/design', agentflowv2GeneratorController.designStudioWorkflow)
router.post('/studio/scenarios/regenerate', agentflowv2GeneratorController.regenerateStudioScenarios)
router.post('/studio/crew/regenerate', agentflowv2GeneratorController.regenerateStudioCrew)
router.post('/studio/compile', agentflowv2GeneratorController.compileStudioWorkflow)
router.post('/studio/evaluate', agentflowv2GeneratorController.evaluateStudioOutput)
router.post('/studio/diagnose', agentflowv2GeneratorController.diagnoseStudioRun)
router.post('/studio/candidates', agentflowv2GeneratorController.proposeStudioCandidates)
router.post('/studio/operator/apply', agentflowv2GeneratorController.applyStudioOperator)
router.post('/studio/tools/purge', agentflowv2GeneratorController.purgeStudioTools)

// Deployed crews: chat playground, online cases, gated publishing and rollback
const canView = checkAnyPermission('agentflows:view')
const canEdit = checkAnyPermission('agentflows:create,agentflows:update')
const canDelete = checkAnyPermission('agentflows:delete')
router.get('/studio/deployments', canView, deploymentsController.listDeployments)
router.post('/studio/deployments', canEdit, deploymentsController.createDeployment)
router.get('/studio/deployments/:id', canView, deploymentsController.getDeployment)
router.patch('/studio/deployments/:id', canEdit, deploymentsController.renameDeployment)
router.delete('/studio/deployments/:id', canDelete, deploymentsController.deleteDeployment)
router.post('/studio/deployments/:id/assess', canView, deploymentsController.assessTurn)
router.patch('/studio/deployments/:id/cases/:caseId', canEdit, deploymentsController.patchOnlineCase)
router.delete('/studio/deployments/:id/cases/:caseId', canEdit, deploymentsController.deleteOnlineCase)
router.post('/studio/deployments/:id/improvement-runs', canEdit, deploymentsController.saveImprovementRun)
router.post('/studio/deployments/:id/publish', canEdit, deploymentsController.publishImprovement)
router.post('/studio/deployments/:id/rollback', canEdit, deploymentsController.rollbackDeployment)

export default router
