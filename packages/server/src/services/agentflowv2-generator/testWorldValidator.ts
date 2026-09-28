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

/* ------------------------------------------------------------------ *
 * Environment repair
 * ------------------------------------------------------------------ */

/**
 * The second audit found most remaining false alarms in the environment, not in
 * the assertions: a case names policy PN-1001 while the coverage fixture is keyed
 * on POL-1001, a leave policy is only found under the internal code
 * `leave_standard`. A correct workflow calls the tool with what the case states,
 * gets "not found", and fails. Fixtures are repaired per case: a required tool
 * that no fixture answers for the values stated in the case gets one fixture
 * whose match values are copied from the case, written by the model at the judge
 * temperature and accepted only if it passes `checkRepairFixture`.
 */
export type EnvironmentChange = {
    caseId: string
    tool: string
    action: 'add_fixture' | 'skip' | 'reject'
    match: { key: string; value: string }[]
    reason: string
}

/** Tools a case depends on: its required tools and the tools its call and success assertions name. */
export const requiredToolsOf = (scenario: { requiredTools?: string[]; assertions: Assertion[] }) =>
    [
        ...new Set([
            ...(scenario.requiredTools || []),
            ...scenario.assertions.filter((a) => (a.type === 'tool_called' || a.type === 'tool_succeeded') && a.tool).map((a) => a.tool)
        ])
    ].filter(Boolean)

/**
 * What a correct workflow can know in one case: the input, plus the results of
 * every successful fixture it can reach with what it already knows. Iterated to
 * a fixed point, so a claim reference returned by one tool can key the next.
 */
export const caseKnowledge = (input: string, design: Pick<StudioDesign, 'tools'>) => {
    let text = normalize(input)
    const used = new Set<string>()
    for (let round = 0; round < 4; round += 1) {
        let grew = false
        for (const tool of design.tools) {
            tool.fixtures.forEach((fixture, index) => {
                const key = `${tool.name}#${index}`
                if (used.has(key) || fixture.error || !fixture.match.length) return
                if (!fixture.match.every((pair) => text.includes(normalize(pair.value)))) return
                used.add(key)
                text = `${text} \n ${normalize(fixture.result.map((pair) => pair.value).join(' \n '))}`
                grew = true
            })
        }
        if (!grew) break
    }
    return text
}

/**
 * A fixture answers a case if it has no match keys, or if every match value is
 * something the workflow can know in this case. Error fixtures count too: a case
 * may deliberately probe an outage.
 */
export const answeredByCase = (toolName: string, input: string, design: Pick<StudioDesign, 'tools'>) => {
    const tool = design.tools.find((item) => normalize(item.name) === normalize(toolName))
    if (!tool) return true // an undeclared tool is not an environment problem
    const known = caseKnowledge(input, design)
    return tool.fixtures.some((fixture) => !fixture.match.length || fixture.match.every((pair) => known.includes(normalize(pair.value))))
}

export const unansweredTools = (
    scenario: { input: string; requiredTools?: string[]; assertions: Assertion[] },
    design: Pick<StudioDesign, 'tools'>
) => requiredToolsOf(scenario).filter((tool) => !answeredByCase(tool, scenario.input, design))

type RepairProposal = { tool: string; match: { key: string; value: string }[]; result: { key: string; value: string }[]; error?: string }

/**
 * A proposed fixture is kept only with match values the case can supply. The
 * model tends to key a fixture on every parameter, including values the case
 * writes differently ("7:30 PM" vs. "19:30"); such pairs are pruned rather than
 * the whole fixture rejected, as long as one distinctive pair remains.
 * Returns the pruned fixture or the reason for rejecting it.
 */
export const pruneRepairFixture = (
    proposal: RepairProposal,
    input: string,
    design: Pick<StudioDesign, 'tools'>
): { fixture: RepairProposal; pruned: string[] } | { problem: string } => {
    const tool = design.tools.find((item) => normalize(item.name) === normalize(proposal.tool))
    if (!tool) return { problem: `unknown tool ${proposal.tool}` }
    if (!proposal.match.length) return { problem: 'a repair fixture needs match keys; a catch-all would answer every other case too' }
    if (!proposal.error && !proposal.result.length) return { problem: 'a successful fixture must return data' }
    if (tool.fixtures.length >= 40) return { problem: `${tool.name} already has the maximum number of fixtures` }
    const params = new Set(tool.params.map((param) => normalize(param.name)))
    const known = caseKnowledge(input, design)
    const pruned: string[] = []
    const match = proposal.match.filter((pair) => {
        const value = normalize(pair.value)
        const ok = params.has(normalize(pair.key)) && value.length > 0 && known.includes(value)
        if (!ok) pruned.push(`${pair.key}=${pair.value}`)
        return ok
    })
    // One distinctive value must remain: a lone "2" or "yes" would answer far more than this case.
    if (!match.some((pair) => normalize(pair.value).length >= 3)) {
        return { problem: `no distinctive match value that the case states remains (dropped ${pruned.join(', ') || 'none'})` }
    }
    return { fixture: { ...proposal, match }, pruned }
}

/** Compatibility wrapper: null if the fixture is acceptable as proposed, otherwise the reason. */
export const checkRepairFixture = (proposal: RepairProposal, input: string, design: Pick<StudioDesign, 'tools'>): string | null => {
    const outcome = pruneRepairFixture(proposal, input, design)
    if ('problem' in outcome) return outcome.problem
    return outcome.pruned.length ? `match value(s) ${outcome.pruned.join(', ')} do not occur in the case` : null
}

export const ENVIRONMENT_REPAIR_PROMPT = [
    'You repair the simulated tool environment of ONE acceptance case of an agent workflow test suite.',
    'For each listed tool, no fixture answers the calls a correct workflow would make for this case, because every fixture is keyed on values the case does not state. A correct workflow therefore receives "not found" and fails the case.',
    'For each listed tool decide:',
    '- If the case expects the tool to return data or a specific failure, add ONE fixture for it.',
    '- If the case deliberately expects "no record", "not found" or that the tool is not used, skip it and say why.',
    'An added fixture:',
    '- has as FEW match keys as possible, normally one: the most distinctive identifier of the request (an id, a policy or order number, a date). Do not key on every parameter; the environment matches an argument by containment, so fewer keys match more of the ways a workflow phrases a call.',
    '- uses match values copied VERBATIM from the case input or from a result another fixture returns for this case. Never an internal code or a value the request writes differently (the request says "7:30 PM", so do not key on "19:30").',
    '- returns a result consistent with the expected behavior of the case and with the style and values of the existing fixtures of that tool, or sets `error` if the case expects an injected failure.',
    'Return fixtures (tool, match, result, error) and skipped (tool, reason).'
].join('\n')

export const EnvironmentRepairType = z.object({
    fixtures: z
        .array(
            z.object({
                tool: z.string().trim().min(1),
                match: z.array(z.object({ key: z.string(), value: z.coerce.string() })).default([]),
                result: z.array(z.object({ key: z.string(), value: z.coerce.string() })).default([]),
                error: z.string().default('')
            })
        )
        .default([]),
    skipped: z.array(z.object({ tool: z.string(), reason: z.string().default('') })).default([])
})

export const repairPayload = (
    goal: string,
    design: Pick<StudioDesign, 'successCriteria' | 'constraints' | 'tools'>,
    scenario: { input: string; expectedBehavior: string[]; mustNot: string[]; assertions: Assertion[] },
    tools: string[]
) =>
    JSON.stringify(
        {
            goal,
            successCriteria: design.successCriteria,
            constraints: design.constraints,
            case: { input: scenario.input, expectedBehavior: scenario.expectedBehavior, mustNot: scenario.mustNot },
            assertionsOnTheseTools: scenario.assertions
                .filter((assertion) => tools.includes(assertion.tool))
                .map(({ type, description, tool, withArgs }) => ({ type, description, tool, withArgs })),
            toolsToRepair: design.tools
                .filter((tool) => tools.includes(tool.name))
                .map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    params: tool.params.map((param) => param.name),
                    existingFixtures: tool.fixtures.slice(0, 8).map((fixture) => ({
                        match: fixture.match,
                        ...(fixture.error ? { error: fixture.error } : { result: fixture.result })
                    }))
                }))
        },
        null,
        2
    )
