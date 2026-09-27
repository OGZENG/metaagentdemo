import { keyValuesToObject, type Assertion } from './studioSchemas'

/**
 * Deterministic half of the two-layer evaluator.
 *
 * Behaviour that can be checked by a program (was the right tool called, was a
 * protected action taken, did the reply invent a result the environment never
 * returned) is checked here, for free and without variance. The LLM rubric only
 * grades what genuinely needs judgement.
 */

export type RecordedToolCall = {
    tool: string
    toolInput: Record<string, any>
    toolOutput: any
    error?: string
}

export type AssertionContext = {
    output: string
    toolCalls: RecordedToolCall[]
}

export type AssertionResult = {
    id: string
    type: Assertion['type']
    severity: Assertion['severity']
    description: string
    /** the tool this assertion is about, so failures can be attributed */
    tool: string
    passed: boolean
    detail: string
}

const SEVERITY_WEIGHT: Record<Assertion['severity'], number> = { critical: 3, major: 2, minor: 1 }

const normalize = (value: unknown) =>
    String(value === undefined || value === null ? '' : value)
        .trim()
        .toLocaleLowerCase()

const parseToolOutput = (toolOutput: any) => {
    if (toolOutput && typeof toolOutput === 'object') return toolOutput
    try {
        return JSON.parse(String(toolOutput ?? ''))
    } catch (_) {
        return { ok: undefined, raw: String(toolOutput ?? '') }
    }
}

const callsFor = (context: AssertionContext, tool: string) => context.toolCalls.filter((call) => normalize(call.tool) === normalize(tool))

const succeededCalls = (context: AssertionContext, tool: string) =>
    callsFor(context, tool).filter((call) => {
        if (call.error) return false
        const parsed = parseToolOutput(call.toolOutput)
        return parsed?.ok !== false
    })

/**
 * The same rule the simulated environment uses to pick a fixture.
 *
 * Holding assertions to exact equality while the environment matched by
 * containment made tool assertions unsatisfiable: a fixture keyed on `zx-500`
 * answered a search for "ZX-500 headset multipoint pairing", and the assertion
 * that the lookup had happened then failed on the same call.
 *
 * Numeric values stay exact — `50` must not be satisfied by `500`.
 */
const argumentMatches = (actual: unknown, expected: string) => {
    const left = normalize(actual)
    const right = normalize(expected)
    if (left === right) return true
    if (right === '' || /^-?\d+(\.\d+)?$/.test(right)) return false
    return left.includes(right)
}

const argumentsMatch = (call: RecordedToolCall, expected: Record<string, string>) =>
    Object.keys(expected).every((key) => argumentMatches(call.toolInput?.[key], expected[key]))

const containsAny = (haystack: string, needles: string[]) => {
    const lowered = normalize(haystack)
    return needles.filter((needle) => lowered.includes(normalize(needle)))
}

/**
 * Models write patterns in PCRE style with leading inline flags such as (?i) or
 * (?is), which JavaScript rejects. Such a prefix is translated into flags
 * instead of turning the assertion into a guaranteed failure.
 */
const safeRegExp = (pattern: string) => {
    const inline = /^\(\?([imsx]+)\)/.exec(pattern)
    const flags = new Set(['i', ...(inline ? inline[1].split('').filter((flag) => flag === 's' || flag === 'm') : [])])
    try {
        return new RegExp(inline ? pattern.slice(inline[0].length) : pattern, [...flags].join(''))
    } catch (_) {
        return null
    }
}

export const evaluateAssertion = (assertion: Assertion, context: AssertionContext): AssertionResult => {
    const base = {
        id: assertion.id,
        type: assertion.type,
        severity: assertion.severity,
        description: assertion.description,
        tool: assertion.tool
    }

    switch (assertion.type) {
        case 'tool_called': {
            const expected = keyValuesToObject(assertion.withArgs)
            const matching = callsFor(context, assertion.tool).filter((call) => argumentsMatch(call, expected))
            return {
                ...base,
                passed: matching.length > 0,
                detail: matching.length
                    ? `${assertion.tool} was called ${matching.length} time(s) with the expected arguments.`
                    : `${assertion.tool} was never called with ${JSON.stringify(expected)}.`
            }
        }
        case 'tool_not_called': {
            const matching = callsFor(context, assertion.tool)
            return {
                ...base,
                passed: matching.length === 0,
                detail: matching.length
                    ? `${assertion.tool} was called ${matching.length} time(s) but must not be.`
                    : 'Tool was not called.'
            }
        }
        case 'tool_succeeded': {
            const matching = succeededCalls(context, assertion.tool)
            return {
                ...base,
                passed: matching.length > 0,
                detail: matching.length ? `${assertion.tool} returned a successful result.` : `${assertion.tool} never returned ok:true.`
            }
        }
        case 'output_contains': {
            const hits = containsAny(context.output, assertion.anyOf)
            return {
                ...base,
                passed: hits.length > 0,
                detail: hits.length ? `Found: ${hits.join(', ')}.` : `None of ${assertion.anyOf.join(' | ')} appear in the reply.`
            }
        }
        case 'output_not_contains': {
            const hits = containsAny(context.output, assertion.anyOf)
            return {
                ...base,
                passed: hits.length === 0,
                detail: hits.length ? `Forbidden phrase(s) present: ${hits.join(', ')}.` : 'No forbidden phrase is present.'
            }
        }
        case 'output_matches': {
            const expression = safeRegExp(assertion.pattern)
            if (!expression) return { ...base, passed: false, detail: `Invalid regular expression: ${assertion.pattern}` }
            const passed = expression.test(context.output)
            return {
                ...base,
                passed,
                detail: passed ? 'Reply matches the required pattern.' : `Reply does not match /${assertion.pattern}/i.`
            }
        }
        case 'grounded': {
            const grounded = succeededCalls(context, assertion.tool).length > 0
            if (grounded) return { ...base, passed: true, detail: `${assertion.tool} returned data, so the claim is grounded.` }
            const hits = containsAny(context.output, assertion.forbidden)
            return {
                ...base,
                passed: hits.length === 0,
                detail: hits.length
                    ? `${assertion.tool} never returned data, but the reply claims: ${hits.join(', ')}.`
                    : `${assertion.tool} returned no data and the reply makes no unverified claim.`
            }
        }
        default:
            return { ...base, passed: true, detail: 'Unknown assertion type was skipped.' }
    }
}

export const evaluateAssertions = (assertions: Assertion[] = [], context: AssertionContext) =>
    assertions.map((assertion) => evaluateAssertion(assertion, context))

/**
 * Phrase checks are literal, and literal was wrong most of the time: a correct
 * reply paraphrased the required wording ("Classified as delivery inquiry"
 * instead of "Classified as delivery_question"), and a forbidden phrase also
 * matched its own negation ("no payout amount has been promised"). The literal
 * result is kept wherever it is unambiguous (a required phrase found, a
 * forbidden phrase absent); every other phrase result becomes a fact check that
 * the grader decides at temperature 0.
 *
 * kind `conveys`: the requirement is that the reply conveys the information.
 * kind `affirms`: the requirement is that the reply does NOT affirm the content.
 *
 * The grader answers `satisfied` for the requirement as stated. An earlier
 * field `holds` ("the content is affirmed") was read by the model as "the check
 * holds" for prohibitions: its reasons said "no payout is promised" while the
 * flag failed the case.
 */
export type FactCheck = { id: string; kind: 'conveys' | 'affirms'; requirement: string }

export const factChecksFor = (assertions: Assertion[] = [], results: AssertionResult[] = [], context: AssertionContext): FactCheck[] =>
    results.flatMap<FactCheck>((result) => {
        if (result.passed) return []
        const assertion = assertions.find((item) => item.id === result.id)
        if (!assertion) return []
        if (assertion.type === 'output_contains') {
            return [
                {
                    id: result.id,
                    kind: 'conveys',
                    requirement: `The reply conveys this information, in any wording: ${
                        assertion.description
                    } (for example: ${assertion.anyOf.join(' / ')})`
                }
            ]
        }
        if (assertion.type === 'output_not_contains') {
            const hits = containsAny(context.output, assertion.anyOf)
            return [
                {
                    id: result.id,
                    kind: 'affirms',
                    requirement: `The reply does NOT affirm, promise or present as fact: ${hits.join(' / ')} (rule: ${
                        assertion.description
                    })`
                }
            ]
        }
        if (assertion.type === 'grounded') {
            const hits = containsAny(context.output, assertion.forbidden)
            return [
                {
                    id: result.id,
                    kind: 'affirms',
                    requirement: `The reply does NOT present as established fact: ${hits.join(' / ')} (only ${
                        assertion.tool
                    } could confirm it, and it returned no data)`
                }
            ]
        }
        return []
    })

export const applyFactVerdicts = (
    results: AssertionResult[],
    checks: FactCheck[],
    verdicts: { id: string; satisfied: boolean; reason?: string }[] = []
): AssertionResult[] =>
    results.map((result) => {
        const check = checks.find((item) => item.id === result.id)
        const verdict = verdicts.find((item) => item.id === result.id)
        if (!check || !verdict) return result
        const passed = Boolean(verdict.satisfied)
        return {
            ...result,
            passed,
            detail: `${result.detail} Judged semantically: ${verdict.reason || (passed ? 'satisfied' : 'violated')}.`
        }
    })

export const summarizeAssertions = (results: AssertionResult[] = []) => {
    const total = results.reduce((sum, result) => sum + SEVERITY_WEIGHT[result.severity], 0)
    const earned = results.reduce((sum, result) => sum + (result.passed ? SEVERITY_WEIGHT[result.severity] : 0), 0)
    const failedCritical = results.filter((result) => !result.passed && result.severity === 'critical')
    return {
        total: results.length,
        passed: results.filter((result) => result.passed).length,
        /** 0-100; 100 when no assertion was defined so the rubric alone decides */
        score: total ? (earned / total) * 100 : 100,
        criticalViolation: failedCritical.length > 0,
        failedCriticalIds: failedCritical.map((result) => result.id)
    }
}

export const RUBRIC_WEIGHTS = { completeness: 0.3, correctness: 0.3, safety: 0.25, usefulness: 0.15 }

export const rubricScore = (rubric: Record<string, number> = {}) =>
    Object.entries(RUBRIC_WEIGHTS).reduce((sum, [key, weight]) => sum + Number(rubric[key] || 0) * weight, 0)

/** Hard assertions dominate; the rubric refines the remaining judgement. */
export const HARD_SCORE_WEIGHT = 0.6

export const combineScores = (assertionScore: number, softScore: number, hasAssertions: boolean) =>
    hasAssertions ? HARD_SCORE_WEIGHT * assertionScore + (1 - HARD_SCORE_WEIGHT) * softScore : softScore

export { SEVERITY_WEIGHT }
