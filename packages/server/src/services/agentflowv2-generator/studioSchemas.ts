import { z } from 'zod/v3'

/**
 * Workflow Autopilot contracts.
 *
 * Every schema here is deliberately *flat*: the studio drives them through
 * `withStructuredOutput`, and nested unions/records translate badly into the
 * JSON Schema that function calling expects. Key/value pair arrays are used
 * wherever a map would be more natural.
 */

const identifier = (label: string) =>
    z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/, `${label} must be lower_snake_case`)

export const KeyValueType = z.object({
    key: z.string().trim().min(1).max(64),
    value: z.string().max(2000).default('')
})

export type KeyValue = z.infer<typeof KeyValueType>

export const keyValuesToObject = (pairs: KeyValue[] = []) =>
    pairs.reduce<Record<string, string>>((accumulator, pair) => {
        accumulator[pair.key] = pair.value
        return accumulator
    }, {})

const stringifyScalar = (value: unknown): string => {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
        return JSON.stringify(value)
    } catch (_) {
        return String(value)
    }
}

/**
 * A map is the shape a model naturally reaches for, and asking it for pair
 * arrays instead produced whole generations rejected on `expected array,
 * received object`. Accept both and normalise, rather than making the caller
 * lose a multi-minute generation over a representation detail.
 */
const toKeyValueList = (value: unknown): unknown => {
    if (value === undefined || value === null) return value
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [entry]
            const record = entry as Record<string, unknown>
            const namedKey = record.key ?? record.name ?? record.property ?? record.field
            const valueField = record.value ?? record.val
            // `name` is only a pair label when the object is actually a pair.
            // In a data record — `{ name: 'ZX-500', multipoint: true, price: 199 }`
            // — it is just another field, and treating it as a label threw the
            // rest of the product away.
            const looksLikePair = namedKey !== undefined && valueField !== undefined && Object.keys(record).length <= 2
            if (looksLikePair) {
                return [{ key: stringifyScalar(namedKey), value: stringifyScalar(valueField) }]
            }
            // A record written as one multi-field object carries every field.
            // Keeping only the first silently emptied the simulated world: an
            // order lookup came back holding nothing but the id it was given.
            return Object.entries(record).map(([key, entry_]) => ({ key, value: stringifyScalar(entry_) }))
        })
    }
    if (typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({ key, value: stringifyScalar(entry) }))
    }
    return value
}

/** Same tolerance for plain string lists returned as objects or single values. */
const toStringList = (value: unknown): unknown => {
    if (value === undefined || value === null) return value
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : stringifyScalar(entry)))
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(stringifyScalar)
    return value
}

const toMessageString = (value: unknown): unknown => {
    if (value === undefined || value === null || typeof value === 'string') return value
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const message = record.message ?? record.error ?? record.reason ?? record.detail
        return message === undefined ? stringifyScalar(value) : stringifyScalar(message)
    }
    return stringifyScalar(value)
}

/**
 * Descriptive prose is truncated, never rejected. A whole multi-minute
 * generation was thrown away because one routing condition ran to 340
 * characters — a limit that exists for storage sanity, not correctness.
 */
const boundedText = (max: number, { required = true }: { required?: boolean } = {}) =>
    z.preprocess(
        (value) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value),
        required ? z.string().trim().min(1).max(max) : z.string().trim().max(max)
    )

const MODEL_TIER_ALIASES: Record<string, 'default' | 'cheap'> = {
    default: 'default',
    standard: 'default',
    medium: 'default',
    high: 'default',
    large: 'default',
    premium: 'default',
    cheap: 'cheap',
    low: 'cheap',
    small: 'cheap',
    mini: 'cheap',
    fast: 'cheap',
    economy: 'cheap'
}

/** Models invent tiers such as "medium"; map anything unknown onto the default. */
const toModelTier = (value: unknown) => {
    if (typeof value !== 'string') return value
    return MODEL_TIER_ALIASES[value.trim().toLocaleLowerCase()] ?? 'default'
}

const keyValueList = () => z.preprocess(toKeyValueList, z.array(KeyValueType))
const stringList = (max = 12, maxLength = 200) => z.preprocess(toStringList, z.array(z.string().trim().min(1).max(maxLength)).max(max))

export { stringifyScalar, toKeyValueList, toStringList, toMessageString, toModelTier }

/* ------------------------------------------------------------------ *
 * Mock tool environment
 * ------------------------------------------------------------------ */

export const ToolParamType = z.object({
    name: identifier('Tool parameter name'),
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    description: boundedText(400),
    required: z.boolean().default(true)
})

/**
 * One row of the simulated world. `match` is compared against the arguments the
 * agent supplied; the first fixture whose keys all match wins. A fixture with
 * `error` set injects a tool failure instead of returning data.
 */
export const MockToolFixtureType = z.object({
    match: keyValueList().default([]),
    result: keyValueList().default([]),
    error: z.preprocess(toMessageString, boundedText(400, { required: false })).default('')
})

export const ToolSpecType = z.object({
    name: identifier('Tool name'),
    label: boundedText(80),
    description: boundedText(600),
    params: z.array(ToolParamType).max(6).default([]),
    fixtures: z.array(MockToolFixtureType).max(40).default([]),
    fallbackStatus: z.enum(['not_found', 'error']).default('not_found'),
    fallbackMessage: boundedText(400).default('No matching record exists in the simulated environment.')
})

export type ToolSpec = z.infer<typeof ToolSpecType>

/* ------------------------------------------------------------------ *
 * Acceptance suite
 * ------------------------------------------------------------------ */

export const ASSERTION_TYPES = [
    'tool_called',
    'tool_not_called',
    'tool_succeeded',
    'output_contains',
    'output_not_contains',
    'output_matches',
    'grounded'
] as const

export const AssertionType = z.object({
    id: z.string().trim().min(1).max(64),
    type: z.enum(ASSERTION_TYPES),
    severity: z.enum(['critical', 'major', 'minor']).default('major'),
    description: boundedText(300),
    /** tool_called | tool_not_called | tool_succeeded | grounded */
    tool: z.string().trim().max(64).default(''),
    /** tool_called: every listed argument must match the recorded tool input */
    withArgs: keyValueList().default([]),
    /** output_contains | output_not_contains: case-insensitive substrings */
    anyOf: stringList().default([]),
    /** output_matches: JavaScript regular expression source */
    pattern: z.string().max(300).default(''),
    /** grounded: phrases that may only appear once `tool` returned successfully */
    forbidden: stringList().default([])
})

export type Assertion = z.infer<typeof AssertionType>

export const AcceptanceScenarioType = z.object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    category: z.string().trim().min(1),
    /** dev cases drive optimization; test cases are held out for final selection */
    split: z.enum(['dev', 'test']).default('dev'),
    input: z.string().trim().min(1),
    expectedBehavior: z.preprocess(toStringList, z.array(z.string().trim().min(1)).min(1)),
    requiredTools: z.preprocess(toStringList, z.array(z.string().trim().min(1))).default([]),
    mustNot: z.preprocess(toStringList, z.array(z.string().trim().min(1))).default([]),
    assertions: z.array(AssertionType).max(12).default([])
})

export type AcceptanceScenario = z.infer<typeof AcceptanceScenarioType>

export const CoveragePlanItemType = z.object({
    category: z.string().trim().min(1),
    count: z.number().int().min(1).max(10),
    risk: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    reason: z.string().trim().min(1)
})

/* ------------------------------------------------------------------ *
 * CrewIR — the intermediate representation every generator and optimizer
 * operates on. Graph compilation is a pure function of this structure.
 * ------------------------------------------------------------------ */

export const CREW_ROLES = ['router', 'specialist', 'orchestrator', 'validator'] as const

export const CrewAgentType = z.object({
    id: identifier('Agent id'),
    name: z.string().trim().min(1).max(80),
    role: z.enum(CREW_ROLES),
    goal: boundedText(600),
    backstory: boundedText(600, { required: false }).default(''),
    /** tool names, must exist in the compiled tool environment */
    tools: z.preprocess(toStringList, z.array(z.string().trim().min(1)).max(8)).default([]),
    guardrails: stringList(8, 400).default([]),
    modelTier: z.preprocess(toModelTier, z.enum(['default', 'cheap'])).default('default')
})

export type CrewAgent = z.infer<typeof CrewAgentType>

export const CrewTaskType = z.object({
    id: identifier('Task id'),
    name: z.string().trim().min(1).max(80),
    description: boundedText(1200),
    expectedOutput: boundedText(600),
    agentId: z.string().trim().min(1),
    dependsOn: z.array(z.string().trim().min(1)).max(8).default([]),
    outputKey: identifier('Task output key')
})

export type CrewTask = z.infer<typeof CrewTaskType>

export const CrewRouteType = z.object({
    taskId: z.string().trim().min(1),
    when: boundedText(600)
})

export const CrewIRType = z.object({
    version: z.literal(1).default(1),
    process: z.enum(['sequential', 'parallel', 'routed']).default('parallel'),
    agents: z.array(CrewAgentType).min(1).max(10),
    tasks: z.array(CrewTaskType).min(1).max(12),
    routerAgentId: z.string().trim().default(''),
    routes: z.array(CrewRouteType).max(8).default([]),
    finalTaskId: z.string().trim().min(1)
})

export type CrewIR = z.infer<typeof CrewIRType>

/* ------------------------------------------------------------------ *
 * Studio design (the reviewable product contract)
 * ------------------------------------------------------------------ */

export const StudioContractType = z.object({
    workflowName: boundedText(100),
    summary: z.string().trim().min(1),
    assumptions: z.preprocess(toStringList, z.array(z.string().trim().min(1))).default([]),
    successCriteria: z.preprocess(toStringList, z.array(z.string().trim().min(1)).min(1)),
    constraints: z.preprocess(toStringList, z.array(z.string().trim().min(1))).default([]),
    tools: z
        .array(ToolSpecType.omit({ fixtures: true, fallbackStatus: true, fallbackMessage: true }))
        .max(8)
        .default([]),
    recommendedCaseCount: z.number().int().min(1).max(30).default(8),
    coverageRationale: z.string().default(''),
    coveragePlan: z.array(CoveragePlanItemType).default([])
})

/**
 * Fixtures and acceptance cases are generated in separate calls. Asking for both
 * at once produced structured responses where the deeply nested `fixtures`
 * arrays were silently dropped, leaving an environment in which every lookup
 * returned "not found".
 */
/**
 * One tool at a time. Asking for every tool's fixtures in a single call made
 * the model ration its effort: some tools came back with a single record and no
 * failure case, and once it renamed a tool the fixtures were lost entirely.
 */
export const StudioToolFixturesType = z.object({
    fixtures: z.array(MockToolFixtureType).min(1).max(20),
    fallbackStatus: z.enum(['not_found', 'error']).default('not_found'),
    fallbackMessage: z.string().trim().max(400).default('No matching record exists in the simulated environment.')
})

export const StudioScenarioSuiteType = z.object({
    scenarios: z.array(AcceptanceScenarioType).min(1).max(30)
})

export const StudioWorldType = z.object({
    tools: z.array(ToolSpecType).max(8).default([]),
    scenarios: z.array(AcceptanceScenarioType).min(1).max(30)
})

export const StudioDesignType = StudioContractType.extend({
    tools: z.array(ToolSpecType).max(8).default([]),
    scenarios: z.array(AcceptanceScenarioType).min(1).max(30),
    crew: CrewIRType
})

export type StudioDesign = z.infer<typeof StudioDesignType>

/* ------------------------------------------------------------------ *
 * Evaluation, diagnosis and optimization
 * ------------------------------------------------------------------ */

export const StudioRubricScoreType = z.object({
    completeness: z.number().min(0).max(100),
    correctness: z.number().min(0).max(100),
    safety: z.number().min(0).max(100),
    usefulness: z.number().min(0).max(100),
    strengths: z.array(z.string()).default([]),
    issues: z.array(z.string()).default([]),
    recommendation: z.string().default(''),
    /** verdicts on the phrase assertions handed to the grader (assertions.ts, factChecksFor) */
    factChecks: z.array(z.object({ id: z.string(), holds: z.boolean(), reason: z.string().default('') })).default([])
})

export const StudioRecommendationType = z.object({
    id: z.string().trim().min(1),
    type: z.enum(['workflow_issue', 'coverage_gap', 'contract_ambiguity', 'environment_gap', 'no_action']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    title: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    proposedChange: z.string().trim().min(1),
    affectedScenarioIds: z.array(z.string()).default([]),
    suggestedCriteria: z.array(z.string().trim().min(1)).default([]),
    suggestedScenarios: z.array(AcceptanceScenarioType).default([])
})

export const StudioDiagnosisType = z.object({
    summary: z.string().trim().min(1),
    recommendations: z.array(StudioRecommendationType).max(12)
})

export const StudioPromptPatchType = z.object({
    agentId: z.string().trim().min(1),
    goal: z.string().trim().max(600).default(''),
    guardrails: z.array(z.string().trim().min(1).max(400)).max(8).default([])
})

export const StudioRewriteProposalType = z.object({
    observation: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    patches: z.array(StudioPromptPatchType).min(1).max(6)
})
