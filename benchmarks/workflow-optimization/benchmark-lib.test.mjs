import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateResults, extractAnswer, summarizeExecution } from './benchmark-lib.mjs'

test('extractAnswer supports final text and structured JSON', () => {
    assert.equal(extractAnswer('Final answer: B. $66'), 'B')
    assert.equal(extractAnswer('Final answer: {"answer":"B. 10 liters"}'), 'B')
    assert.equal(extractAnswer('{"consensus_answer":"C. 40"}'), 'C')
    assert.equal(extractAnswer('The answer is option D because ...'), 'D')
    assert.equal(extractAnswer('No option was selected.'), null)
})

test('summarizeExecution aggregates usage and detects revisions', () => {
    const prediction = {
        executionId: 'execution-1',
        agentFlowExecutedData: [
            {
                nodeLabel: 'Consensus Aggregator',
                data: { output: { usageMetadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120, total_cost: 0.01 }, timeMetadata: { delta: 50 } } }
            },
            {
                nodeLabel: 'Revise and Re-run',
                data: { output: {} }
            },
            {
                nodeLabel: 'Consensus Aggregator',
                data: { output: { usageMetadata: { input_tokens: 110, output_tokens: 25, total_tokens: 135, total_cost: 0.02 }, timeMetadata: { delta: 60 } } }
            },
            {
                nodeLabel: 'Critical Reviewer',
                data: { output: { verdict: 'pass', usageMetadata: { total_tokens: 50 } } }
            }
        ]
    }

    assert.deepEqual(summarizeExecution(prediction, 500), {
        executionId: 'execution-1',
        inputTokens: 210,
        outputTokens: 45,
        totalTokens: 305,
        estimatedCost: 0.03,
        durationMs: 500,
        measuredNodeDurationMs: 110,
        modelCalls: 3,
        validationVerdict: 'pass',
        validationPassed: true,
        revisionRounds: 1,
        nodeCallCounts: { 'Consensus Aggregator': 2, 'Revise and Re-run': 1, 'Critical Reviewer': 1 }
    })
})

test('aggregateResults reports accuracy and averages without counting extraction failures', () => {
    const summary = aggregateResults([
        { predictedAnswer: 'B', correct: true, totalTokens: 100, inputTokens: 70, outputTokens: 30, estimatedCost: 0.01, durationMs: 1000, modelCalls: 2, revisionRounds: 0, validationVerdict: 'pass', validationPassed: true },
        { predictedAnswer: 'C', correct: false, totalTokens: 200, inputTokens: 140, outputTokens: 60, estimatedCost: 0.02, durationMs: 2000, modelCalls: 3, revisionRounds: 1, validationVerdict: 'pass', validationPassed: true },
        { predictedAnswer: null, correct: false, totalTokens: 300, inputTokens: 200, outputTokens: 100, estimatedCost: 0.03, durationMs: 3000, modelCalls: 4, revisionRounds: 0, validationVerdict: null, validationPassed: false }
    ])

    assert.equal(summary.accuracy, 1 / 3)
    assert.equal(summary.conditionalAccuracy, 0.5)
    assert.equal(summary.answerExtractionRate, 2 / 3)
    assert.equal(summary.averageTotalTokens, 200)
    assert.equal(summary.revisionRate, 1 / 3)
    assert.equal(summary.validationPassRate, 1)
})
