#!/usr/bin/env node
/**
 * Workflow Autopilot experiments (thesis chapter 6).
 *
 *   node experiments/autopilot/run.mjs design   <goalId>
 *   node experiments/autopilot/run.mjs baseline <goalId> [--reps 3]
 *   node experiments/autopilot/run.mjs search   <goalId> --strategy greedy|random|evidence_guided [--rep 1]
 *
 * Results are written to experiments/autopilot/results/<goalId>/.
 * One design and one baseline measurement are shared by all strategies of a
 * goal, so strategies are compared on an identical test world and starting point.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, studio } from './lib/api.mjs'
import { compileTrial, runScenarios, runSearch, DEFAULT_SETTINGS } from './lib/runner.mjs'
import { splitScenarios, summarizeStudioResults } from '../../packages/ui/src/views/metaagent/studioUtils.js'

const [command, goalId, ...rest] = process.argv.slice(2)
const flag = (name, fallback) => {
    const index = rest.indexOf(`--${name}`)
    return index >= 0 ? rest[index + 1] : fallback
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2))
const goals = readJson(join(ROOT, 'goals.json'))
const selectedChatModel = readJson(join(ROOT, 'model.json'))
const cheapChatModel = existsSync(join(ROOT, 'cheap-model.json')) ? readJson(join(ROOT, 'cheap-model.json')) : undefined

const goalEntry = goals.find((entry) => entry.id === goalId)
if (!goalEntry) {
    console.error(`Unknown goal "${goalId}". Known: ${goals.map((entry) => entry.id).join(', ')}`)
    process.exit(1)
}
const dir = join(ROOT, 'results', goalId)
mkdirSync(dir, { recursive: true })
const designFile = join(dir, 'design.json')
const baselineFile = join(dir, 'baseline.json')
const modelInfo = {
    model: selectedChatModel.inputs?.modelName,
    temperature: selectedChatModel.inputs?.temperature,
    cheapModel: cheapChatModel?.inputs?.modelName || null
}

const commands = {
    async design() {
        const startedAt = Date.now()
        const data = await studio('design', { goal: goalEntry.goal, selectedChatModel })
        writeJson(designFile, { goalId, goal: goalEntry.goal, ...modelInfo, durationMs: Date.now() - startedAt, ...data })
        const { dev, test } = splitScenarios(data.design.scenarios)
        console.log(
            `design: ${data.design.tools.length} tools, ${dev.length} dev + ${test.length} test cases, ` +
                `${data.crewSummary?.agentCount} agents / ${data.crewSummary?.taskCount} tasks (${data.design.crew.process}), ` +
                `${data.validation?.warnings?.length || 0} warnings, ${Math.round((Date.now() - startedAt) / 1000)}s`
        )
    },

    async baseline() {
        const { design, goal } = readJson(designFile)
        const reps = Number(flag('reps', 1))
        const compiled = await compileTrial({
            goal,
            design,
            crew: design.crew,
            name: `${design.workflowName} [exp ${goalId} Baseline]`,
            selectedChatModel,
            cheapChatModel
        })
        const trial = { id: 'baseline', name: 'Baseline', parentId: null, round: 0, operator: null, ...compiled }
        const { dev, test } = splitScenarios(design.scenarios)
        const repetitions = []
        for (let rep = 1; rep <= reps; rep += 1) {
            const common = { goal, design, selectedChatModel, settings: DEFAULT_SETTINGS, runPrefix: `exp-${goalId}-base${rep}` }
            const devResults = await runScenarios({ ...common, trial, scenarios: dev })
            const testResults = await runScenarios({ ...common, trial, scenarios: test })
            repetitions.push({ rep, devResults, summary: summarizeStudioResults(devResults), testResults, testSummary: summarizeStudioResults(testResults) })
            const s = repetitions.at(-1)
            console.log(`baseline rep ${rep}: dev pass ${s.summary.passRate.toFixed(2)} q ${s.summary.quality.toFixed(2)} | test pass ${s.testSummary.passRate.toFixed(2)}`)
        }
        const { flowData: _flowData, ...stored } = trial
        writeJson(baselineFile, { goalId, ...modelInfo, trial: stored, flowData: compiled.flowData, repetitions })
    },

    async search() {
        const { design, goal } = readJson(designFile)
        const base = readJson(baselineFile)
        const strategy = flag('strategy', 'evidence_guided')
        const rep = Number(flag('rep', 1))
        const first = base.repetitions[0]
        // Reuse the first baseline measurement so every strategy starts from the same numbers.
        const baseline = { ...base.trial, flowData: base.flowData, devResults: first.devResults, summary: first.summary, testResults: first.testResults, testSummary: first.testSummary }
        const result = await runSearch({
            goal,
            design,
            baseline,
            selectedChatModel,
            cheapChatModel,
            settings: { strategy, seed: rep },
            runPrefix: `exp-${goalId}-${strategy}-${rep}`
        })
        writeJson(join(dir, `search-${strategy}-${rep}.json`), { goalId, strategy, rep, ...modelInfo, ...result })
        const selected = result.trials.find((trial) => trial.id === result.selectedTrialId)
        console.log(`search ${strategy} #${rep}: selected ${result.selectedTrialId} — dev pass ${selected?.summary?.passRate}, test pass ${selected?.testSummary?.passRate}`)
    }
}

/**
 * E2b: re-measure the crew a search selected (and the baseline) on dev + test,
 * `--reps` more times, to check whether a selected improvement survives fresh
 * runs or was noise amplified by selection.
 */
commands.confirm = async () => {
    const { design, goal } = readJson(designFile)
    const reps = Number(flag('reps', 2))
    const { dev, test } = splitScenarios(design.scenarios)
    const base = readJson(baselineFile)
    const { readdirSync } = await import('node:fs')
    for (const file of readdirSync(dir).filter((name) => /^search-.*\.json$/.test(name))) {
        const out = join(dir, file.replace(/^search-/, 'confirm-'))
        if (existsSync(out)) continue
        const search = readJson(join(dir, file))
        const selected = search.trials.find((trial) => trial.id === search.selectedTrialId)
        if (!selected || selected.id === 'baseline' || !selected.flowId) continue
        const measure = async (trial, label) => {
            const runsOut = []
            for (let rep = 1; rep <= reps; rep += 1) {
                // One case at a time for both crews: the saved trials no longer carry their graph size.
                const common = { goal, design, selectedChatModel, settings: { ...DEFAULT_SETTINGS, concurrency: 1 }, runPrefix: `confirm-${goalId}-${label}-${rep}` }
                const devResults = await runScenarios({ ...common, trial, scenarios: dev })
                const testResults = await runScenarios({ ...common, trial, scenarios: test })
                runsOut.push({ rep, summary: summarizeStudioResults(devResults), testSummary: summarizeStudioResults(testResults), devResults, testResults })
            }
            return runsOut
        }
        const selectedTrial = { ...selected, flowData: { nodes: [] } }
        const baselineTrial = { ...base.trial, flowData: { nodes: [] } }
        const result = {
            goalId,
            source: file,
            strategy: search.strategy,
            rep: search.rep,
            selectedTrialId: selected.id,
            selected: { searchSummary: selected.summary, searchTestSummary: selected.testSummary, runs: await measure(selectedTrial, `${search.strategy}-${search.rep}-sel`) },
            baseline: { runs: await measure(baselineTrial, `${search.strategy}-${search.rep}-base`) }
        }
        writeJson(out, result)
        const avg = (runs, key) => runs.reduce((sum, run) => sum + run.summary[key], 0) / runs.length
        console.log(`confirm ${file}: selected dev pass ${avg(result.selected.runs, 'passRate').toFixed(2)} vs baseline ${avg(result.baseline.runs, 'passRate').toFixed(2)} (search reported ${selected.summary.passRate.toFixed(2)})`)
    }
}

if (!commands[command]) {
    console.error('Usage: run.mjs design|baseline|search <goalId> [options]')
    process.exit(1)
}
commands[command]().catch((error) => {
    console.error(error)
    process.exit(1)
})
