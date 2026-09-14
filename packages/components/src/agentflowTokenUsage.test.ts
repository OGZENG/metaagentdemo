import { addModelCallUsage, emptyTokenUsage, mergeTokenUsage, priceTokenUsage, toUsageMetadata } from './agentflowTokenUsage'

const call = (input: number, output: number, cacheRead = 0) => ({
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_token_details: { cache_read: cacheRead },
    output_token_details: { reasoning: 0 }
})

describe('agent token usage', () => {
    it('counts every model call of a tool loop exactly once', () => {
        // First call decides on a tool, a second round calls another tool, the
        // final call answers. The handler owns rounds two and three; the caller
        // owns the first — the split the Agent node uses.
        const first = addModelCallUsage(emptyTokenUsage(), call(1500, 60))
        const handlerRounds = addModelCallUsage(addModelCallUsage(emptyTokenUsage(), call(1600, 70, 1152)), call(1745, 87, 1152))
        const usage = mergeTokenUsage(first, handlerRounds)

        expect(toUsageMetadata(usage)).toEqual({
            input_tokens: 4845,
            output_tokens: 217,
            total_tokens: 5062,
            input_token_details: { cache_read: 2304 },
            output_token_details: { reasoning: 0 },
            model_calls: 3
        })
    })

    it('keeps input and output consistent with the total', () => {
        const usage = addModelCallUsage(addModelCallUsage(emptyTokenUsage(), call(704, 42)), call(900, 10))
        expect(usage.inputTokens + usage.outputTokens).toBe(usage.totalTokens)
    })

    it('derives the total when a provider omits it and ignores missing usage', () => {
        const usage = addModelCallUsage(addModelCallUsage(emptyTokenUsage(), { input_tokens: 10, output_tokens: 5 }), undefined)
        expect(usage).toMatchObject({ totalTokens: 15, modelCalls: 1 })
        expect(toUsageMetadata(emptyTokenUsage())).toBeUndefined()
    })

    it('prices input and output tokens at their own rates', () => {
        const usage = mergeTokenUsage(addModelCallUsage(emptyTokenUsage(), call(4000, 200)), undefined)
        const cost = priceTokenUsage(usage, 0.00000075, 0.0000045)
        expect(cost.inputCost).toBeCloseTo(0.003)
        expect(cost.outputCost).toBeCloseTo(0.0009)
        expect(cost.totalCost).toBeCloseTo(0.0039)
    })
})
