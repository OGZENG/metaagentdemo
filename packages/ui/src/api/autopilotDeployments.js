import client from './client'

// Deploying and publishing recompile the crew on the server; reviewing a turn is
// a model call. Both are bounded like every other studio request.
const COMPILE_TIMEOUT = 2 * 60 * 1000
const REVIEW_TIMEOUT = 5 * 60 * 1000

const base = '/agentflowv2-generator/studio/deployments'

const listDeployments = () => client.get(base)
const getDeployment = (id) => client.get(`${base}/${id}`)
const createDeployment = (body) => client.post(base, body, { timeout: COMPILE_TIMEOUT })
const renameDeployment = (id, name) => client.patch(`${base}/${id}`, { name })
const deleteDeployment = (id, deleteFlow = true) => client.delete(`${base}/${id}`, { params: { deleteFlow } })
const assessTurn = (id, body) => client.post(`${base}/${id}/assess`, body, { timeout: REVIEW_TIMEOUT })
const updateOnlineCase = (id, caseId, patch) => client.patch(`${base}/${id}/cases/${caseId}`, patch)
const deleteOnlineCase = (id, caseId) => client.delete(`${base}/${id}/cases/${caseId}`)
const saveImprovementRun = (id, run) => client.post(`${base}/${id}/improvement-runs`, { run })
const publishImprovement = (id, runId, candidateId) =>
    client.post(`${base}/${id}/publish`, { runId, candidateId }, { timeout: COMPILE_TIMEOUT })
const rollbackDeployment = (id, version) => client.post(`${base}/${id}/rollback`, { version }, { timeout: COMPILE_TIMEOUT })

export default {
    listDeployments,
    getDeployment,
    createDeployment,
    renameDeployment,
    deleteDeployment,
    assessTurn,
    updateOnlineCase,
    deleteOnlineCase,
    saveImprovementRun,
    publishImprovement,
    rollbackDeployment
}
