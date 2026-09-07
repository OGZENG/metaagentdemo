import client from './client'

const getAllChatflows = (params) => client.get('/chatflows?type=CHATFLOW', { params })

const getAllAgentflows = (type, params) => client.get(`/chatflows?type=${type}`, { params })

const getSpecificChatflow = (id) => client.get(`/chatflows/${id}`)

const getSpecificChatflowFromPublicEndpoint = (id) => client.get(`/public-chatflows/${id}`)

const createNewChatflow = (body) => client.post(`/chatflows`, body)

const updateChatflow = (id, body) => client.put(`/chatflows/${id}`, body)

const deleteChatflow = (id) => client.delete(`/chatflows/${id}`)

const getIsChatflowStreaming = (id) => client.get(`/chatflows-streaming/${id}`)

const getAllowChatflowUploads = (id) => client.get(`/chatflows-uploads/${id}`)

const getHasChatflowChanged = (id, lastUpdatedDateTime) => client.get(`/chatflows/has-changed/${id}/${lastUpdatedDateTime}`)

// The shared client has no timeout, so a stalled request would leave Autopilot
// spinning forever with no way out but a reload. Every studio call is bounded:
// generation and diagnosis are long model calls, the rest should be quick.
const STUDIO_GENERATION_TIMEOUT = 10 * 60 * 1000
const STUDIO_EVALUATION_TIMEOUT = 5 * 60 * 1000
const STUDIO_LOCAL_TIMEOUT = 2 * 60 * 1000

const generateAgentflow = (body) => client.post(`/agentflowv2-generator/generate`, body)
const designStudioWorkflow = (body) => client.post(`/agentflowv2-generator/studio/design`, body, { timeout: STUDIO_GENERATION_TIMEOUT })
const regenerateStudioScenarios = (body) =>
    client.post(`/agentflowv2-generator/studio/scenarios/regenerate`, body, { timeout: STUDIO_GENERATION_TIMEOUT })
const regenerateStudioCrew = (body) =>
    client.post(`/agentflowv2-generator/studio/crew/regenerate`, body, { timeout: STUDIO_GENERATION_TIMEOUT })
const compileStudioWorkflow = (body) => client.post(`/agentflowv2-generator/studio/compile`, body, { timeout: STUDIO_LOCAL_TIMEOUT })
const evaluateStudioOutput = (body) => client.post(`/agentflowv2-generator/studio/evaluate`, body, { timeout: STUDIO_EVALUATION_TIMEOUT })
const diagnoseStudioRun = (body) => client.post(`/agentflowv2-generator/studio/diagnose`, body, { timeout: STUDIO_GENERATION_TIMEOUT })
const proposeStudioCandidates = (body) =>
    client.post(`/agentflowv2-generator/studio/candidates`, body, { timeout: STUDIO_GENERATION_TIMEOUT })
const applyStudioOperator = (body) => client.post(`/agentflowv2-generator/studio/operator/apply`, body, { timeout: STUDIO_LOCAL_TIMEOUT })
const purgeStudioTools = (body) => client.post(`/agentflowv2-generator/studio/tools/purge`, body || {}, { timeout: STUDIO_LOCAL_TIMEOUT })

const setWebhookSecret = (id) => client.post(`/chatflows/${id}/webhook-secret`)

const clearWebhookSecret = (id) => client.delete(`/chatflows/${id}/webhook-secret`)

const getScheduleStatus = (id) => client.get(`/chatflows/${id}/schedule/status`)

const toggleScheduleEnabled = (id, enabled) => client.patch(`/chatflows/${id}/schedule/enabled`, { enabled })

const getScheduleTriggerLogs = (id, params) => client.get(`/chatflows/${id}/schedule/trigger-logs`, { params })

const deleteScheduleTriggerLogs = (id, logIds) => client.delete(`/chatflows/${id}/schedule/trigger-logs`, { data: { logIds } })

export default {
    getAllChatflows,
    getAllAgentflows,
    getSpecificChatflow,
    getSpecificChatflowFromPublicEndpoint,
    createNewChatflow,
    updateChatflow,
    deleteChatflow,
    getIsChatflowStreaming,
    getAllowChatflowUploads,
    getHasChatflowChanged,
    generateAgentflow,
    designStudioWorkflow,
    regenerateStudioScenarios,
    regenerateStudioCrew,
    compileStudioWorkflow,
    evaluateStudioOutput,
    diagnoseStudioRun,
    proposeStudioCandidates,
    applyStudioOperator,
    purgeStudioTools,
    setWebhookSecret,
    clearWebhookSecret,
    getScheduleStatus,
    toggleScheduleEnabled,
    getScheduleTriggerLogs,
    deleteScheduleTriggerLogs
}
