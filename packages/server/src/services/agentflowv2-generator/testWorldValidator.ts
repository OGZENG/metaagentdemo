import { z } from 'zod/v3'
import type { Assertion, StudioDesign } from './studioSchemas'

/**
 * Validation of a generated test world before it is used.
 *
 * An audit of the first experiments found that most failed assertions were
 * defects of the test world, not of the workflow: tool arguments the case never
 * states (a budget of 1500 for a request of 3000, an internal policy code),
 * arguments that contradict the case (POL-1001 vs. PN-1001), success
 * requirements for fixtures that no argument from the case can reach, and
 * regular expressions the engine cannot compile. A workflow cannot satisfy such
 * an assertion however well it behaves, so every search measured against it
 * optimizes noise.
 *
 * The deterministic part below repairs what a program can decide. Assertions
 * are repaired rather than removed wherever the intent survives: a success
 * requirement on an unreachable fixture still requires the tool to be called.
 * Cases that contradict the goal need judgement and go to a model review
 * (`TEST_WORLD_REVIEW_PROMPT`). Every change is logged so that it can be
 * reviewed by the user and reported.
 */

export type TestWorldChange = {
    caseId: string
    assertionId: string
    action: 'drop_argument' | 'require_call_only' | 'drop_assertion'
    reason: string
    source: 'rule' | 'review'
}

const normalize = (value: unknown) =>
    String(value ?? '')
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

/** Same inline-flag handling as the evaluator. */
export const compilesAsPattern = (pattern: string) => {
    const inline = /^\(\?([imsx]+)\)/.exec(pattern)
    try {
        new RegExp(inline ? pattern.slice(inline[0].length) : pattern)
        return true
    } catch (_) {
        return false
    }
}

/**
 * Text a correct workflow can know: the request itself and every value that
 * some tool of the environment returns. A value outside this text can only be
 * guessed.
 */
const knowableText = (input: string, design: Pick<StudioDesign, 'tools'>) =>
    normalize(
        [
            input,
            ...design.tools.flatMap((tool) =>
                tool.fixtures.filter((fixture) => !fixture.error).flatMap((fixture) => fixture.result.map((pair) => pair.value))
            )
        ].join(' \n ')
    )

const isKnowable = (value: string, knowable: string) => {
    const needle = normalize(value)
    return needle === '' || knowable.includes(needle)
}

/** A successful fixture of `toolName` whose match values a correct workflow can supply. */
const successReachable = (toolName: string, design: Pick<StudioDesign, 'tools'>, knowable: string) => {
    const tool = design.tools.find((item) => normalize(item.name) === normalize(toolName))
    if (!tool) return false
    return tool.fixtures.some((fixture) => !fixture.error && fixture.match.every((pair) => isKnowable(pair.value, knowable)))
}

export const repairAssertions = (
    caseId: string,
    input: string,
    assertions: Assertion[],
    design: Pick<StudioDesign, 'tools'>
): { assertions: Assertion[]; changes: TestWorldChange[] } => {
    const knowable = knowableText(input, design)
    const changes: TestWorldChange[] = []
    const repaired: Assertion[] = []
    for (const assertion of assertions) {
        const log = (action: TestWorldChange['action'], reason: string) =>
            changes.push({ caseId, assertionId: assertion.id, action, reason, source: 'rule' })

        if (assertion.type === 'output_matches' && !compilesAsPattern(assertion.pattern)) {
            log('drop_assertion', `The pattern ${assertion.pattern} is not a valid regular expression.`)
            continue
        }
        if (assertion.type === 'tool_called' && assertion.withArgs.length) {
            const kept = assertion.withArgs.filter((pair) => {
                if (isKnowable(pair.value, knowable)) return true
                log('drop_argument', `${pair.key}=${pair.value} is neither stated in the case nor returned by any tool.`)
                return false
            })
            repaired.push({ ...assertion, withArgs: kept })
            continue
        }
        if (assertion.type === 'tool_succeeded' && assertion.tool && !successReachable(assertion.tool, design, knowable)) {
            log(
                'require_call_only',
                `No successful fixture of ${assertion.tool} can be reached with values a correct workflow knows; the tool is still required to be called.`
            )
            repaired.push({ ...assertion, type: 'tool_called', withArgs: [], description: `${assertion.description} (required call)` })
            continue
        }
        repaired.push(assertion)
    }
    return { assertions: repaired, changes }
}

export const TEST_WORLD_REVIEW_PROMPT = [
    'You review the machine-checkable assertions of one acceptance case of a generated test suite for an agent workflow.',
    'Your task is to find defects of the TEST, not of the workflow. A defective assertion fails even for a workflow that behaves correctly.',
    'Drop an assertion only if at least one of these holds:',
    '(a) it contradicts the goal, the success criteria or the constraints, for example it requires an action the goal routes elsewhere;',
    "(b) it contradicts the case's own input or expected behavior;",
    '(c) it requires a value, record or result that neither the case input nor the listed tool fixtures can provide to a correct workflow;',
    '(d) it requires an exact tool argument value where the goal only asks for the call.',
    'Wording of the reply is NOT a reason to drop: phrase requirements are judged semantically later, so paraphrases already pass. Judge a phrase assertion only by whether a correct reply could convey that information at all.',
    'Keep every assertion that a correct workflow could satisfy, even if it is strict. Never drop an assertion because the workflow might find it hard, and never drop a check of a rule stated in the goal.',
    'Return one verdict per assertion id: action keep or drop, and a one-sentence reason naming the rule (a)-(d) for a drop.'
].join('\n')

/**
 * Prohibitions, grounding checks and required calls protect the rules of the
 * goal ("never promise a payout", "escalate refunds above EUR 100"). They are
 * never handed to the review: in trial runs it dropped exactly such checks,
 * because of their literal wording or because a fixture keyed on another
 * argument value could not answer the call. The rules above already remove
 * argument values a correct workflow cannot know, and phrase checks are judged
 * semantically, so what remains of these assertions is satisfiable.
 */
export const REVIEW_EXEMPT_TYPES: Assertion['type'][] = ['output_not_contains', 'grounded', 'tool_not_called', 'tool_called']

export const TestWorldReviewType = z.object({
    verdicts: z
        .array(
            z.object({
                assertionId: z.string().trim().min(1),
                action: z.enum(['keep', 'drop']),
                reason: z.string().default('')
            })
        )
        .default([])
})

export const reviewPayload = (
    goal: string,
    design: Pick<StudioDesign, 'successCriteria' | 'constraints' | 'tools'>,
    scenario: { id: string; input: string; expectedBehavior: string[]; mustNot: string[] },
    assertions: Assertion[]
) =>
    JSON.stringify(
        {
            goal,
            successCriteria: design.successCriteria,
            constraints: design.constraints,
            case: { input: scenario.input, expectedBehavior: scenario.expectedBehavior, mustNot: scenario.mustNot },
            toolEnvironment: design.tools.map((tool) => ({
                name: tool.name,
                params: tool.params.map((param) => param.name),
                fixtures: tool.fixtures.map((fixture) => ({
                    match: fixture.match,
                    ...(fixture.error ? { error: fixture.error } : { result: fixture.result })
                }))
            })),
            assertions: assertions.map(({ id, type, severity, description, tool, withArgs, anyOf, pattern, forbidden }) => ({
                id,
                type,
                severity,
                description,
                tool,
                withArgs,
                anyOf,
                pattern,
                forbidden
            }))
        },
        null,
        2
    )
