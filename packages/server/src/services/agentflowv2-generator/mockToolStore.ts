import { Equal } from 'typeorm'
import { Tool } from '../../database/entities/Tool'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { compileMockTool } from './mockToolCompiler'
import type { ToolSpec } from './studioSchemas'

/**
 * Persists the simulated tool environment as Flowise Custom Tools.
 *
 * Rows are keyed by the hash of their specification, so recompiling the same
 * environment reuses them instead of filling the tools table with duplicates.
 * The stored row name carries the hash; the name the model actually sees is
 * overridden per binding, so agents always call `check_order_status`, never
 * `autopilot__check_order_status__9f2c`.
 */

const ROW_PREFIX = 'autopilot__'

export type ProvisionedTools = {
    toolIdByName: Record<string, string>
    created: string[]
    reused: string[]
}

const rowName = (spec: ToolSpec, specHash: string) => `${ROW_PREFIX}${spec.name}__${specHash}`

export const provisionMockTools = async (specs: ToolSpec[] = [], workspaceId: string, orgId: string): Promise<ProvisionedTools> => {
    const toolIdByName: Record<string, string> = {}
    const created: string[] = []
    const reused: string[] = []
    if (!specs.length) return { toolIdByName, created, reused }
    if (!workspaceId) throw new Error('A workspace is required to provision the simulated tool environment.')

    const repository = getRunningExpressApp().AppDataSource.getRepository(Tool)
    for (const spec of specs) {
        const compiled = compileMockTool(spec)
        const name = rowName(spec, compiled.specHash)
        const existing = await repository.findOneBy({ name, workspaceId: Equal(workspaceId) })
        if (existing) {
            toolIdByName[spec.name] = existing.id
            reused.push(spec.name)
            continue
        }
        const row = repository.create({
            name,
            description: compiled.description,
            color: compiled.color,
            schema: compiled.schema,
            func: compiled.func,
            workspaceId
        })
        const saved = await repository.save(row)
        toolIdByName[spec.name] = saved.id
        created.push(spec.name)
    }
    logger.debug(`[autopilot]: simulated tools ready for org ${orgId} — created ${created.length}, reused ${reused.length}`)
    return { toolIdByName, created, reused }
}

/** Removes every simulated tool in a workspace. Exposed for session cleanup. */
export const purgeMockTools = async (workspaceId: string) => {
    if (!workspaceId) return { deleted: 0 }
    const repository = getRunningExpressApp().AppDataSource.getRepository(Tool)
    const rows = await repository.findBy({ workspaceId: Equal(workspaceId) })
    const autopilotRows = rows.filter((row) => row.name.startsWith(ROW_PREFIX))
    if (!autopilotRows.length) return { deleted: 0 }
    await repository.remove(autopilotRows)
    return { deleted: autopilotRows.length }
}

export { ROW_PREFIX }
