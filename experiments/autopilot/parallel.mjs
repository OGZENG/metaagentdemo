#!/usr/bin/env node
/**
 * E3: serial vs. dependency-aware parallel execution (thesis section 6.4).
 *
 * Compiles one crew with four independent, tool-free solver tasks feeding an
 * aggregator, creates two copies of the flow that differ only in the Start
 * node's maximum concurrency (1 = original serial executor, 4 = parallel), and
 * runs every probe question on both copies in alternating order.
 *
 *   node experiments/autopilot/parallel.mjs [--reps 3]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, predict } from './lib/api.mjs'
import { compileTrial } from './lib/runner.mjs'
import { extractStudioOutput, summarizePrediction } from '../../packages/ui/src/views/metaagent/studioUtils.js'

const repsIndex = process.argv.indexOf('--reps')
const reps = repsIndex > 0 ? Number(process.argv[repsIndex + 1]) : 3
const selectedChatModel = JSON.parse(readFileSync(join(ROOT, 'model.json'), 'utf8'))

// Probe inputs for latency only; correctness is not scored in this experiment.
const QUESTIONS = [
    'A train leaves at 09:40 and arrives at 13:05. How long is the journey in minutes?',
    'If 3 workers build a wall in 12 hours, how long do 4 workers need at the same rate?',
    'Is 391 a prime number? Explain.',
    'A shop raises a price by 20% and later lowers it by 20%. Is the final price higher, lower or equal to the original?',
    'Alice is older than Bob, Bob is older than Carol, and Dave is younger than Carol. Who is the second youngest?',
    'What is the sum of all integers from 1 to 200 that are divisible by 7?',
    'A bag has 3 red and 5 blue balls. Two are drawn without replacement. What is the probability that both are red?',
    'Convert 72 km/h into metres per second.',
    'If today is Wednesday, what weekday will it be in 100 days?',
    'A rectangle has perimeter 36 cm and its length is twice its width. What is its area?'
]

const solver = (id, name, strategy) => ({
    agent: { id: `${id}_agent`, name, role: 'specialist', goal: `Solve the question using a ${strategy} strategy.`, backstory: '', tools: [], guardrails: [], modelTier: 'default' },
    task: {
        id,
        name,
        description: `Solve the user's question with a ${strategy} strategy and give a final answer.`,
        expectedOutput: 'The reasoning in a few sentences and a final answer.',
        agentId: `${id}_agent`,
        dependsOn: [],
        outputKey: `${id}_answer`
    }
})

const solvers = [
    solver('solve_direct', 'Direct solver', 'direct'),
    solver('solve_stepwise', 'Stepwise solver', 'step-by-step'),
    solver('solve_verify', 'Verifying solver', 'solve-then-verify'),
    solver('solve_skeptic', 'Skeptical solver', 'skeptical, look-for-traps')
]

const crew = {
    version: 1,
    process: 'parallel',
    agents: [
        ...solvers.map((item) => item.agent),
        { id: 'aggregator_agent', name: 'Aggregator', role: 'orchestrator', goal: 'Combine the candidate answers into one final answer.', backstory: '', tools: [], guardrails: [], modelTier: 'default' }
    ],
    tasks: [
        ...solvers.map((item) => item.task),
        {
            id: 'aggregate',
            name: 'Aggregate',
            description: 'Compare the four candidate answers, resolve disagreements, and state the final answer.',
            expectedOutput: 'A short justification and the final answer.',
            agentId: 'aggregator_agent',
            dependsOn: solvers.map((item) => item.task.id),
            outputKey: 'final_answer'
        }
    ],
    routerAgentId: '',
    routes: [],
    finalTaskId: 'aggregate'
}

const design = {
    workflowName: 'parallel_solver_probe',
    summary: 'Four independent solvers and an aggregator, used to measure serial vs. parallel execution.',
    assumptions: [],
    successCriteria: ['Return a final answer to the question.'],
    constraints: [],
    tools: [],
    recommendedCaseCount: 1,
    coverageRationale: '',
    coveragePlan: [],
    scenarios: [{ id: 'probe', title: 'probe', category: 'probe', split: 'dev', input: QUESTIONS[0], expectedBehavior: ['answers'], requiredTools: [], mustNot: [], assertions: [] }],
    crew
}

const withConcurrency = (value) => (flowData) => {
    const start = flowData.nodes.find((node) => node.data?.name === 'startAgentflow')
    start.data.inputs = { ...(start.data.inputs || {}), startMaxConcurrency: value }
    return flowData
}

const main = async () => {
    const goal = design.summary
    const serial = await compileTrial({ goal, design, crew, name: 'E3 parallel probe [serial]', selectedChatModel, mutateFlow: withConcurrency(1) })
    const parallel = await compileTrial({ goal, design, crew, name: 'E3 parallel probe [parallel x4]', selectedChatModel, mutateFlow: withConcurrency(4) })
    const variants = [
        { id: 'serial', concurrency: 1, flowId: serial.flowId },
        { id: 'parallel', concurrency: 4, flowId: parallel.flowId }
    ]
    const runs = []
    for (let rep = 1; rep <= reps; rep += 1) {
        for (const [index, question] of QUESTIONS.entries()) {
            // Alternate the order so provider-side warm-up or drift affects both variants equally.
            const order = (rep + index) % 2 === 0 ? variants : [...variants].reverse()
            for (const variant of order) {
                const startedAt = Date.now()
                try {
                    const prediction = await predict(variant.flowId, question, `e3-${variant.id}-${rep}-${index}-${Date.now()}`)
                    const durationMs = Date.now() - startedAt
                    const nodes = (prediction.agentFlowExecutedData || []).map((node) => node.nodeLabel || node.nodeId)
                    runs.push({ rep, question: index, variant: variant.id, ...summarizePrediction(prediction, durationMs), nodes, outputLength: extractStudioOutput(prediction).length })
                    console.log(`rep ${rep} q${index} ${variant.id}: ${(durationMs / 1000).toFixed(1)}s`)
                } catch (error) {
                    runs.push({ rep, question: index, variant: variant.id, durationMs: Date.now() - startedAt, error: String(error?.message || error) })
                    console.log(`rep ${rep} q${index} ${variant.id}: ERROR ${String(error?.message || error).slice(0, 120)}`)
                }
            }
        }
    }
    const dir = join(ROOT, 'results', 'parallel')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'parallel.json'), JSON.stringify({ model: selectedChatModel.inputs?.modelName, temperature: selectedChatModel.inputs?.temperature, reps, questions: QUESTIONS, variants, runs }, null, 2))
    const stat = (variant) => {
        const values = runs.filter((run) => run.variant === variant && !run.error).map((run) => run.durationMs)
        return (values.reduce((a, b) => a + b, 0) / values.length / 1000).toFixed(1)
    }
    console.log(`mean latency: serial ${stat('serial')}s, parallel ${stat('parallel')}s`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
