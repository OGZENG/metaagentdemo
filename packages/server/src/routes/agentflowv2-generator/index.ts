import express from 'express'
import agentflowv2GeneratorController from '../../controllers/agentflowv2-generator'
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

export default router
