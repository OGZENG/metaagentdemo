import { z } from 'zod/v3'
import type { CrewIR } from './studioSchemas'
import {
    CrewOperatorType,
    OPERATOR_FAMILY,
    applyOperator,
    describeOperator,
    enumerateOperators,
    operatorSignature,
    type CrewOperator
} from './crewOperators'

/**
 * Search over the operator space.
 *
 * Three interchangeable strategies so the thesis can ablate the contribution of
 * evidence: `random` samples the legal neighbourhood, `greedy` ranks it with a
 * static heuristic, and `evidence_guided` lets the model pick from that same
 * legal set using observed failures. All three draw from an identical space,
 * which is what makes the comparison meaningful.
 */

export const SEARCH_STRATEGIES = ['random', 'greedy', 'evidence_guided'] as const
export type SearchStrategy = (typeof SEARCH_STRATEGIES)[number]

export const RunEvidenceType = z.object({
    passRate: z.number().default(0),
    failureRate: z.number().default(0),
    quality: z.number().default(0),
    averageCost: z.number().default(0),
    averageDurationMs: z.number().default(0),
    averageModelCalls: z.number().default(0),
    failingScenarioIds: z.array(z.string()).default([]),
    failedAssertionTypes: z.array(z.string()).default([]),
    /** required by a failing assertion but never actually called */
    missingToolCalls: z.array(z.string()).default([]),
    /** required by a failing assertion AND bound to no agent at all */
    unboundRequiredTools: z.array(z.string()).default([]),
    unusedTools: z.array(z.string()).default([]),
    errorMessages: z.array(z.string()).default([]),
    evaluatorIssues: z.array(z.string()).default([]),
    /** rules accepted from live conversations on a deployed crew */
    userInstructions: z.array(z.string()).default([]),
    /** operator signatures already measured in this search, never re-proposed */
    triedOperators: z.array(z.string()).default([])
})

export type RunEvidence = z.infer<typeof RunEvidenceType>

export const QUALITY_TARGET = 0.75

export type ScoredOperator = {
    operator: CrewOperator
    score: number
    description: string
    rationale: string
}

const mentions = (haystack: string[], needle: string) => haystack.some((item) => item.toLocaleLowerCase().includes(needle))

/**
 * Static priors, deliberately simple and readable: quality problems buy
 * structure, healthy runs buy efficiency. The evidence-guided strategy is
 * expected to beat this — that is the point of keeping it around.
 */
export const scoreOperator = (operator: CrewOperator, ir: CrewIR, evidence: RunEvidence): { score: number; rationale: string } => {
    const family = OPERATOR_FAMILY[operator.type]
    const healthy = evidence.failureRate <= 0.1 && evidence.quality >= QUALITY_TARGET
    const executionBroken = evidence.failureRate > 0.2
    // A required tool that was never called means one of two very different
    // things, and confusing them wastes a whole round: either no agent holds it
    // (an access problem, fixed by binding) or an agent holds it but the request
    // never reached that agent (a reachability problem, which more binding
    // cannot fix).
    const accessProblem = evidence.unboundRequiredTools.length > 0
    const reachabilityProblem = evidence.missingToolCalls.some((tool) => !evidence.unboundRequiredTools.includes(tool))

    if (operator.type === 'bind_tool') {
        if (evidence.unboundRequiredTools.includes(operator.tool)) {
            return { score: 10, rationale: `Acceptance cases required ${operator.tool} but no agent has it bound.` }
        }
        return {
            score: -4,
            rationale: `${operator.tool} is already reachable in the crew; the failure is in getting to it, not in access.`
        }
    }
    if (operator.type === 'unbind_tool' && evidence.unusedTools.includes(operator.tool) && healthy) {
        return { score: 4, rationale: `${operator.tool} was never used in a passing run; removing it shortens every prompt.` }
    }
    if (!accessProblem && reachabilityProblem) {
        if (operator.type === 'remove_task') {
            return { score: 8, rationale: 'A step between the request and the tool-holding agent is dropping the request.' }
        }
        if (operator.type === 'merge_tasks') {
            return { score: 7, rationale: 'Fewer hand-offs means fewer places the request can be lost before the tool call.' }
        }
        if (operator.type === 'remove_router') {
            return { score: 6, rationale: 'Routing may be gating the branch that owns the required tool.' }
        }
    }

    if (executionBroken) {
        if (operator.type === 'merge_tasks') return { score: 8, rationale: 'Execution failures usually come from too many hand-offs.' }
        if (operator.type === 'remove_task') return { score: 7, rationale: 'Removing a step reduces the number of ways a run can break.' }
    }

    if (!healthy) {
        if (operator.type === 'add_validator')
            return { score: 7, rationale: 'An independent validation pass targets quality failures directly.' }
        if (operator.type === 'add_router' && mentions(evidence.evaluatorIssues, 'intent')) {
            return { score: 6, rationale: 'Evaluator feedback mentions intent handling, which routing addresses.' }
        }
        if (operator.type === 'remove_task') return { score: -2, rationale: 'Removing work is risky while acceptance is failing.' }
        return { score: 1, rationale: 'Neutral structural exploration.' }
    }

    // Healthy baseline: buy efficiency without losing behaviour.
    if (operator.type === 'merge_tasks') return { score: 8, rationale: 'Merging independent tasks removes a model call at equal coverage.' }
    if (operator.type === 'parallelize_task') return { score: 6, rationale: 'Shortening the critical path lowers latency at equal cost.' }
    if (operator.type === 'remove_task') return { score: 5, rationale: 'A step that never changed the outcome can be dropped.' }
    if (operator.type === 'add_validator') return { score: -2, rationale: 'The run is already healthy; another call would only add cost.' }
    return { score: 0, rationale: 'Neutral.' }
}

const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * `evidence` is parsed rather than trusted: callers legitimately hold partial
 * evidence (a first round has no failing assertions yet), and a missing array
 * must read as "nothing observed", never as a crash mid-search.
 */
export const rankOperators = (ir: CrewIR, availableToolNames: string[], evidence: Partial<RunEvidence> = {}): ScoredOperator[] => {
    const observed = RunEvidenceType.parse(evidence || {})
    // Re-measuring an operator the search already tried burns a full acceptance
    // run for a result that is already on the board.
    const alreadyTried = new Set(observed.triedOperators)
    return enumerateOperators(ir, availableToolNames)
        .filter((operator) => !alreadyTried.has(operatorSignature(operator)))
        .map((operator) => {
            const { score, rationale } = scoreOperator(operator, ir, observed)
            return { operator, score, description: describeOperator(operator), rationale }
        })
        .sort((left, right) => right.score - left.score)
}

/**
 * Keeps a candidate set diverse: at most one operator per family per round, so
 * a round explores different kinds of change instead of five near-identical
 * merges.
 */
export const diversify = (scored: ScoredOperator[], count: number) => {
    const chosen: ScoredOperator[] = []
    const usedFamilies = new Set<string>()
    for (const candidate of scored) {
        if (chosen.length >= count) break
        const family = OPERATOR_FAMILY[candidate.operator.type]
        if (usedFamilies.has(family)) continue
        usedFamilies.add(family)
        chosen.push(candidate)
    }
    for (const candidate of scored) {
        if (chosen.length >= count) break
        if (!chosen.includes(candidate)) chosen.push(candidate)
    }
    return chosen
}

export const selectOperators = (
    ir: CrewIR,
    availableToolNames: string[],
    evidence: Partial<RunEvidence>,
    strategy: SearchStrategy,
    count = 3,
    seed = 1
): ScoredOperator[] => {
    const scored = rankOperators(ir, availableToolNames, evidence)
    if (!scored.length) return []
    if (strategy === 'random') {
        const random = mulberry32(seed)
        const shuffled = [...scored].sort(() => random() - 0.5)
        return shuffled.slice(0, count).map((candidate) => ({ ...candidate, rationale: 'Randomly sampled from the legal operator set.' }))
    }
    return diversify(
        scored.filter((candidate) => candidate.score > -3),
        count
    )
}

/** Applies a selection, dropping anything that turns out to be illegal. */
export const materializeCandidates = (
    ir: CrewIR,
    availableToolNames: string[],
    selection: ScoredOperator[]
): { operator: CrewOperator; signature: string; description: string; rationale: string; ir: CrewIR; warnings: string[] }[] =>
    selection.flatMap((candidate) => {
        try {
            const { ir: mutated, warnings } = applyOperator(ir, candidate.operator, availableToolNames)
            return [
                {
                    operator: candidate.operator,
                    // Returned so the caller can feed it back as `triedOperators`
                    // and stop the next round re-proposing the same experiment.
                    signature: operatorSignature(candidate.operator),
                    description: candidate.description,
                    rationale: candidate.rationale,
                    ir: mutated,
                    warnings
                }
            ]
        } catch (_) {
            return []
        }
    })

export const OperatorSelectionType = z.object({
    /**
     * May be empty. "Nothing here is worth trying" is a real answer once the
     * obvious operators have been measured, and forcing a pick would have the
     * search spend a round on something the model does not believe in.
     */
    selections: z
        .array(
            z.object({
                index: z.number().int().min(0),
                rationale: z.string().trim().min(1)
            })
        )
        .max(6)
        .default([]),
    promptPatches: z
        .array(
            z.object({
                agentId: z.string().trim().min(1),
                goal: z.string().trim().max(600).default(''),
                guardrails: z.array(z.string().trim().min(1).max(400)).max(6).default([]),
                rationale: z.string().trim().min(1)
            })
        )
        .max(4)
        .default([])
})

export const promptPatchToOperator = (patch: { agentId: string; goal: string; guardrails: string[] }): CrewOperator =>
    CrewOperatorType.parse({
        type: 'rewrite_prompt',
        agentIds: [patch.agentId],
        goal: patch.goal,
        guardrails: patch.guardrails
    })
