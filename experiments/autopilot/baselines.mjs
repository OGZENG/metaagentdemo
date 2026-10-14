#!/usr/bin/env node
/**
 * External baselines on the frozen test world of a goal, measured exactly like
 * the Autopilot baselines (same cases, assertions, grader and settings):
 *
 *   single       one agent holding every declared tool and one task, compiled by
 *                the CrewIR compiler, so it sees the same contract as the crews
 *   single_goal  the same agent with only the goal text as its system prompt,
 *                what a user would build by hand without the contract
 *
 * Flowise's built-in one-shot generator (/agentflowv2-generator/generate) is
 * run on the goal and the tool list and audited, not executed: its flows are
 * skeletons that need manual configuration before they run.
 *
 *   node baselines.mjs generate-flowise <goal> [--world repaired] [--model qwen] [--attempts 3]
 *   node baselines.mjs audit-flowise [--world repaired] [--model qwen]
 *   node baselines.mjs run <single|single_goal> <goal> [--reps 3] [--world repaired] [--model qwen]
 *
 * Results: <results>/<goal>/external-<variant>.json (same shape as baseline.json).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, request } from './lib/api.mjs'
import { compileTrial, runScenarios, DEFAULT_SETTINGS, VALIDATED_SETTINGS } from './lib/runner.mjs'
import { splitScenarios, summarizeStudioResults } from '../../packages/ui/src/views/metaagent/studioUtils.js'

const args = process.argv.slice(2)
const command = args[0]
const variant = command === 'run' ? args[1] : 'flowise'
// audit-flowise covers all goals; any goal with a design serves for the setup below
const goalId = command === 'run' ? args[2] : command === 'audit-flowise' ? 'support' : args[1]
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 ? args[index + 1] : fallback
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2))

const WORLDS = { original: 'results', validated: 'results-validated', repaired: 'results-repaired' }
const world = flag('world', 'repaired')
const modelName = flag('model', null)
if (!WORLDS[world] || !goalId) {
    console.error('usage: baselines.mjs generate-flowise <goal> | audit-flowise | run <single|single_goal> <goal> [--reps N] [--world W] [--model M]')
    process.exit(1)
}
const SETTINGS = world === 'original' ? DEFAULT_SETTINGS : VALIDATED_SETTINGS
const selectedChatModel = readJson(join(ROOT, modelName ? `model-${modelName}.json` : 'model.json'))
const dir = join(ROOT, modelName ? `${WORLDS[world]}-${modelName}` : WORLDS[world], goalId)
mkdirSync(dir, { recursive: true })
const { goal, design } = readJson(join(ROOT, WORLDS[world], goalId, 'design.json'))
const modelInfo = { model: selectedChatModel.inputs?.modelName, temperature: selectedChatModel.inputs?.temperature }
const generatedFile = join(dir, 'external-flowise-generated.json')

/** One agent, one task, every declared tool: the same contract without a team. */
const singleAgentCrew = () => ({
    version: 1,
    process: 'sequential',
    agents: [
        {
            id: 'assistant',
            name: 'Assistant',
            role: 'specialist',
            goal: 'Handle every request of this workflow end to end, using the available tools where facts or actions are needed.',
            backstory: '',
            tools: design.tools.map((tool) => tool.name),
            guardrails: [],
            modelTier: 'default'
        }
    ],
    tasks: [
        {
            id: 'handle_request',
            name: 'Handle Request',
            description: 'Read the request, use the tools that are needed, follow every rule of the workflow and answer the user.',
            expectedOutput: 'The final reply to the user.',
            agentId: 'assistant',
            dependsOn: [],
            outputKey: 'reply'
        }
    ],
    routes: [],
    finalTaskId: 'handle_request'
})

const generatorQuestion = () =>
    `${goal}\n\nThe workflow can use these tools:\n${design.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`

const commands = {
    /** Up to --attempts generations; a user would press "generate" again after a failure. */
    async 'generate-flowise'() {
        const maxAttempts = Number(flag('attempts', 3))
        const attempts = []
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const startedAt = Date.now()
            const response = await request('POST', '/agentflowv2-generator/generate', { question: generatorQuestion(), selectedChatModel })
            const ok = Array.isArray(response?.nodes) && response.nodes.length > 0
            attempts.push({ attempt, ok, durationMs: Date.now() - startedAt, error: ok ? null : response?.error || 'no nodes' })
            console.log(`generate attempt ${attempt}: ${ok ? `${response.nodes.length} nodes` : `failed (${attempts.at(-1).error})`}`)
            if (ok) {
                writeJson(generatedFile, { goalId, ...modelInfo, question: generatorQuestion(), attempts, flow: { nodes: response.nodes, edges: response.edges } })
                return
            }
        }
        writeJson(generatedFile, { goalId, ...modelInfo, question: generatorQuestion(), attempts, flow: null })
    },

    /**
     * The generated flows are skeletons: count what a user still has to set by
     * hand before they run. They are not executed, because completing them would
     * mean redesigning them.
     */
    async 'audit-flowise'() {
        const goals = ['support', 'helpdesk', 'travel', 'hr_leave', 'restaurant', 'insurance']
        const rootDir = join(ROOT, modelName ? `${WORLDS[world]}-${modelName}` : WORLDS[world])
        const toolNodeNames = new Set((await request('GET', '/nodes')).filter((node) => node.category === 'Tools').map((node) => node.name))
        const rows = []
        for (const id of goals) {
            const file = join(rootDir, id, 'external-flowise-generated.json')
            if (!existsSync(file)) continue
            const generated = readJson(file)
            const nodes = (generated.flow?.nodes || []).filter((node) => node.data?.name !== 'stickyNoteAgentflow')
            const count = (name) => nodes.filter((node) => node.data?.name === name).length
            const selectedTools = nodes.flatMap((node) => [
                ...(node.data?.inputs?.agentTools || []).map((tool) => tool.agentSelectedTool),
                ...(node.data?.inputs?.toolAgentflowSelectedTool ? [node.data.inputs.toolAgentflowSelectedTool] : [])
            ])
            const modelNodes = count('agentAgentflow') + count('llmAgentflow') + count('conditionAgentAgentflow')
            const row = {
                goal: id,
                attempts: generated.attempts.length,
                generated: Boolean(generated.flow),
                nodes: nodes.length,
                modelNodes,
                // model nodes come without a chat model or system prompt
                needModelAndPrompt: modelNodes,
                toolNodes: count('toolAgentflow'),
                conditionNodes: count('conditionAgentflow') + count('conditionAgentAgentflow'),
                loopNodes: count('loopAgentflow'),
                humanInputNodes: count('humanInputAgentflow'),
                replyNodes: count('directReplyAgentflow'),
                selectedTools: [...new Set(selectedTools)],
                unknownTools: [...new Set(selectedTools.filter((tool) => !toolNodeNames.has(tool)))]
            }
            row.manualSteps = row.needModelAndPrompt + row.toolNodes + row.conditionNodes + row.loopNodes
            rows.push(row)
            console.log(
                `${id.padEnd(11)} attempts ${row.attempts} | ${row.nodes} nodes: ${row.modelNodes} model, ${row.toolNodes} tool, ${row.conditionNodes} condition, ` +
                    `${row.loopNodes} loop, ${row.humanInputNodes} human input, ${row.replyNodes} reply | manual steps ${row.manualSteps} | ` +
                    `tools ${row.selectedTools.join(', ') || '-'}${row.unknownTools.length ? ` (not Flowise tools: ${row.unknownTools.join(', ')})` : ''}`
            )
        }
        writeJson(join(rootDir, 'external-flowise-audit.json'), { ...modelInfo, rows })
    },

    async run() {
        const reps = Number(flag('reps', 3))
        let trial
        if (variant === 'single') {
            const compiled = await compileTrial({ goal, design, crew: singleAgentCrew(), name: `${design.workflowName} [ext ${goalId} single]`, selectedChatModel })
            trial = { id: 'external-single', name: 'Single agent', parentId: null, round: 0, operator: null, ...compiled }
        } else if (variant === 'single_goal') {
            // What a user would build by hand: one agent with the tools and the
            // goal text as its whole system prompt, without the contract.
            const mutateFlow = (flowData) => {
                for (const node of flowData.nodes) {
                    if (node.data?.name === 'agentAgentflow') node.data.inputs.agentMessages = [{ role: 'system', content: goal }]
                }
                return flowData
            }
            const compiled = await compileTrial({ goal, design, crew: singleAgentCrew(), name: `${design.workflowName} [ext ${goalId} single_goal]`, selectedChatModel, mutateFlow })
            trial = { id: 'external-single_goal', name: 'Single agent, goal only', parentId: null, round: 0, operator: null, ...compiled }
        } else {
            throw new Error(`unknown variant ${variant}`)
        }
        const { dev, test } = splitScenarios(design.scenarios)
        const repetitions = []
        for (let rep = 1; rep <= reps; rep += 1) {
            const common = { goal, design, selectedChatModel, settings: { ...SETTINGS, measurementRepeats: 1 }, runPrefix: `ext-${variant}-${goalId}-${rep}` }
            const devResults = await runScenarios({ ...common, trial, scenarios: dev })
            const testResults = await runScenarios({ ...common, trial, scenarios: test })
            repetitions.push({ rep, devResults, summary: summarizeStudioResults(devResults), testResults, testSummary: summarizeStudioResults(testResults) })
            const s = repetitions.at(-1)
            console.log(`${variant} rep ${rep}: dev pass ${s.summary.passRate.toFixed(2)} q ${s.summary.quality.toFixed(2)} | test pass ${s.testSummary.passRate.toFixed(2)}`)
        }
        const { flowData, ...stored } = trial
        writeJson(join(dir, `external-${variant}.json`), { goalId, variant, ...modelInfo, trial: stored, flowData, repetitions })
    }
}

if (!commands[command]) {
    console.error(`unknown command ${command}`)
    process.exit(1)
}
await commands[command]()
