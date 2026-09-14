/**
 * Token accounting for one Agent node turn that may span several model calls:
 * the first call, one call per tool round, and a structured-output conversion.
 *
 * Every call is added exactly once, and input and output are kept apart, so the
 * persisted `input_tokens + output_tokens` matches `total_tokens` and cost can
 * be priced per side. The previous accounting re-added each round's total on
 * top of the final call's usage — counting the last round twice, intermediate
 * rounds twice again on recursion — and billed every tool round at the output
 * price.
 */
export interface AgentTokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    reasoningTokens: number
    modelCalls: number
}

const toNumber = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

export const emptyTokenUsage = (): AgentTokenUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    modelCalls: 0
})

/** Adds the usage reported by a single model response. */
export const addModelCallUsage = (usage: AgentTokenUsage, usageMetadata: Record<string, any> | undefined | null): AgentTokenUsage => {
    if (!usageMetadata) return usage
    const inputTokens = toNumber(usageMetadata.input_tokens)
    const outputTokens = toNumber(usageMetadata.output_tokens)
    return {
        inputTokens: usage.inputTokens + inputTokens,
        outputTokens: usage.outputTokens + outputTokens,
        totalTokens: usage.totalTokens + (toNumber(usageMetadata.total_tokens) || inputTokens + outputTokens),
        cacheReadTokens: usage.cacheReadTokens + toNumber(usageMetadata.input_token_details?.cache_read),
        reasoningTokens: usage.reasoningTokens + toNumber(usageMetadata.output_token_details?.reasoning),
        modelCalls: usage.modelCalls + 1
    }
}

export const mergeTokenUsage = (left: AgentTokenUsage, right: AgentTokenUsage | undefined): AgentTokenUsage =>
    right
        ? {
              inputTokens: left.inputTokens + right.inputTokens,
              outputTokens: left.outputTokens + right.outputTokens,
              totalTokens: left.totalTokens + right.totalTokens,
              cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
              reasoningTokens: left.reasoningTokens + right.reasoningTokens,
              modelCalls: left.modelCalls + right.modelCalls
          }
        : left

/** The `usageMetadata` persisted on an Agent node output, or undefined when no call reported usage. */
export const toUsageMetadata = (usage: AgentTokenUsage) =>
    usage.modelCalls === 0
        ? undefined
        : {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
              input_token_details: { cache_read: usage.cacheReadTokens },
              output_token_details: { reasoning: usage.reasoningTokens },
              model_calls: usage.modelCalls
          }

/** Prices input and output separately; per-token prices come from models.json. */
export const priceTokenUsage = (usage: AgentTokenUsage, baseInputCost: number, baseOutputCost: number) => {
    const inputCost = usage.inputTokens * baseInputCost
    const outputCost = usage.outputTokens * baseOutputCost
    return { inputCost, outputCost, totalCost: inputCost + outputCost }
}
