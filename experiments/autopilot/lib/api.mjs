import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Minimal Flowise API client for headless experiments.
 *
 * Authenticates with a Flowise API key (Settings → API Keys), read from the
 * FLOWISE_API_KEY environment variable or from experiments/autopilot/.env.
 * The key is never printed or written to results.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')

const loadEnvFile = () => {
    const file = join(ROOT, '.env')
    if (!existsSync(file)) return {}
    return Object.fromEntries(
        readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && line.includes('='))
            .map((line) => {
                const index = line.indexOf('=')
                return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, '')]
            })
    )
}

const env = { ...loadEnvFile(), ...process.env }
export const BASE_URL = (env.FLOWISE_URL || 'http://localhost:3000').replace(/\/$/, '')
const API_KEY = env.FLOWISE_API_KEY || ''

export const STUDIO_TIMEOUT = 15 * 60 * 1000
export const EXECUTION_TIMEOUT = 8 * 60 * 1000

export class ApiError extends Error {
    constructor(message, status) {
        super(message)
        this.status = status
    }
}

/**
 * Infrastructure failures (Flowise down, network lost, machine asleep) say
 * nothing about the crew. They abort the whole run instead of being recorded
 * as case failures, so a resumed run repeats the step with clean data.
 */
export class InfraError extends Error {}

const INFRA_PATTERN = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Connection error|network error|getaddrinfo/i

export const isInfraError = (error) => error instanceof InfraError || INFRA_PATTERN.test(String(error?.message || error))

export const request = async (method, path, body, { timeout = STUDIO_TIMEOUT, retries = 1 } = {}) => {
    if (!API_KEY) throw new Error('FLOWISE_API_KEY is not set (environment or experiments/autopilot/.env).')
    for (let attempt = 0; ; attempt += 1) {
        const startedAt = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        try {
            const response = await fetch(`${BASE_URL}/api/v1${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            })
            const text = await response.text()
            let data
            try {
                data = text ? JSON.parse(text) : {}
            } catch (_) {
                data = { raw: text }
            }
            if (!response.ok) {
                const message = data?.message || data?.error || text || response.statusText
                // Transient provider/server errors get one retry, like the studio does.
                if (attempt < retries && (response.status === 429 || response.status >= 500)) {
                    await new Promise((resolve) => setTimeout(resolve, 2000))
                    continue
                }
                throw new ApiError(`${method} ${path} → ${response.status}: ${String(message).slice(0, 500)}`, response.status)
            }
            return data
        } catch (error) {
            if (error.name === 'AbortError') {
                // Timers freeze while the machine sleeps; a "timeout" that fires long after it
                // was due means the machine was suspended, not that the crew hung.
                const elapsed = Date.now() - startedAt
                if (elapsed > timeout * 1.5) throw new InfraError(`${method} ${path}: machine suspended (${Math.round(elapsed / 60000)} min elapsed)`)
                throw new ApiError(`${method} ${path} timed out after ${timeout / 1000}s`, 0)
            }
            if (!(error instanceof ApiError)) throw new InfraError(`${method} ${path}: ${error?.cause?.code || error.message}`)
            throw error
        } finally {
            clearTimeout(timer)
        }
    }
}

export const studio = (action, body, options) => request('POST', `/agentflowv2-generator/studio/${action}`, body, options)

export const createChatflow = (name, flowData) =>
    request('POST', '/chatflows', { name, deployed: false, isPublic: false, flowData: JSON.stringify(flowData), type: 'AGENTFLOW' })

export const deleteChatflow = (id) => request('DELETE', `/chatflows/${id}`)

export const predict = (flowId, question, sessionId) =>
    request(
        'POST',
        `/prediction/${flowId}`,
        { question, streaming: false, chatId: sessionId, overrideConfig: { sessionId } },
        { timeout: EXECUTION_TIMEOUT, retries: 0 }
    )
