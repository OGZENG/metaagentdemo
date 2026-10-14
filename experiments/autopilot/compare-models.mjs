#!/usr/bin/env node
/**
 * Model comparison on the repaired world: gpt-5.4-mini (E5, results-repaired)
 * against the self-hosted Qwen model (results-repaired-qwen), same frozen
 * designs and protocol. Prints baselines, pooled searches, operators and the
 * re-measurement of recommended crews; --json <file> also writes the numbers.
 *
 *   node experiments/autopilot/compare-models.mjs [--json out.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'

const MODELS = [
    { label: 'gpt-5.4-mini', dir: join(ROOT, 'results-repaired') },
    { label: 'qwen3.5-9b', dir: join(ROOT, 'results-repaired-qwen') }
]
const GOALS = ['support', 'helpdesk', 'travel', 'hr_leave', 'restaurant', 'insurance']
const STRATEGIES = ['random', 'evidence_guided_v2', 'regenerate']

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN)
const std = (values) => {
    if (values.length < 2) return 0
    const m = mean(values)
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}
const f = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '--')
const pm = (values, digits = 2) => (values.length ? `${f(mean(values), digits)} ± ${f(std(values), digits)}` : '--')
const pad = (text, width) => String(text).padEnd(width)
const table = (header, rows) => {
    const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((row) => String(row[i]).length)))
    console.log(header.map((h, i) => pad(h, widths[i])).join('  '))
    for (const row of rows) console.log(row.map((cell, i) => pad(cell, widths[i])).join('  '))
    console.log()
}
const isError = (result) => !result.evaluation || Boolean(result.error)
const out = {}

console.log('Baselines (three repetitions; tokens and latency per development case)\n')
const baselineRows = []
for (const goal of GOALS) {
    for (const model of MODELS) {
        const file = join(model.dir, goal, 'baseline.json')
        if (!existsSync(file)) continue
        const { repetitions } = read(file)
        const all = repetitions.flatMap((rep) => rep.devResults.concat(rep.testResults))
        const dev = repetitions.flatMap((rep) => rep.devResults)
        const row = {
            devPass: repetitions.map((rep) => rep.summary.passRate),
            testPass: repetitions.map((rep) => rep.testSummary.passRate),
            assertionScore: mean(all.map((result) => result.evaluation?.assertionScore ?? 0)),
            score: mean(all.map((result) => result.evaluation?.score ?? 0)),
            tokens: mean(dev.map((result) => result.totalTokens || 0)),
            latency: mean(dev.map((result) => (result.durationMs || 0) / 1000)),
            failures: all.filter(isError).length,
            cases: all.length
        }
        ;(out.baselines ??= {})[`${goal}/${model.label}`] = row
        baselineRows.push([goal, model.label, pm(row.devPass), pm(row.testPass), f(row.assertionScore, 1), f(row.score, 1), Math.round(row.tokens), f(row.latency, 1), `${row.failures}/${row.cases}`])
    }
}
table(['goal', 'model', 'dev pass', 'test pass', 'assert', 'score', 'tokens', 'latency s', 'exec fail'], baselineRows)

const searchesOf = (model, goal, strategy) =>
    existsSync(join(model.dir, goal))
        ? readdirSync(join(model.dir, goal))
              .filter((name) => name.startsWith(`search-${strategy}-`) && name.endsWith('.json'))
              .map((name) => read(join(model.dir, goal, name)))
        : []

console.log('Crew search pooled over goals\n')
const searchRows = []
const operatorStats = {}
for (const model of MODELS) {
    for (const strategy of STRATEGIES) {
        let searches = 0
        let candidates = 0
        let rejected = 0
        let betterThanParent = 0
        let improved = 0
        let selectedNew = 0
        let selectedNone = 0
        for (const goal of GOALS) {
            for (const search of searchesOf(model, goal, strategy)) {
                searches += 1
                const byId = Object.fromEntries(search.trials.map((trial) => [trial.id, trial]))
                const baseline = search.trials.find((trial) => !trial.parentId)
                let anyImproved = false
                for (const trial of search.trials.filter((item) => item.parentId)) {
                    candidates += 1
                    const parent = byId[trial.parentId]
                    const type = trial.operator?.type || strategy
                    const stats = (operatorStats[`${model.label}|${type}`] ??= { applied: 0, rejected: 0, better: 0, deltas: [], tokens: [] })
                    stats.applied += 1
                    if (!trial.summary || trial.status === 'rejected') {
                        rejected += 1
                        stats.rejected += 1
                        continue
                    }
                    const delta = trial.summary.passRate - parent.summary.passRate
                    stats.deltas.push(delta)
                    if (parent.summary.averageTokens) stats.tokens.push(trial.summary.averageTokens / parent.summary.averageTokens - 1)
                    if (delta > 1e-9) {
                        betterThanParent += 1
                        stats.better += 1
                    }
                    if (trial.summary.passRate > baseline.summary.passRate + 1e-9) anyImproved = true
                }
                if (anyImproved) improved += 1
                if (!search.selectedTrialId) selectedNone += 1
                else if (search.selectedTrialId !== baseline.id) selectedNew += 1
            }
        }
        ;(out.searches ??= {})[`${model.label}/${strategy}`] = { searches, candidates, rejected, betterThanParent, improved, selectedNew, selectedNone }
        searchRows.push([
            model.label,
            strategy,
            searches,
            candidates,
            rejected,
            `${betterThanParent} (${f((betterThanParent / Math.max(1, candidates - rejected)) * 100, 0)}%)`,
            `${improved}/${searches}`,
            `${selectedNew}/${searches}`,
            `${selectedNone}/${searches}`
        ])
    }
}
table(['model', 'strategy', 'searches', 'candidates', 'rejected', 'better than parent', 'search improved', 'new crew', 'no feasible'], searchRows)

console.log('Operators (relative to the parent crew)\n')
const operatorRows = Object.entries(operatorStats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, stats]) => {
        const [model, type] = key.split('|')
        return [model, type, stats.applied, stats.rejected, pm(stats.deltas), `${f((stats.better / Math.max(1, stats.deltas.length)) * 100, 0)}%`, stats.tokens.length ? `${f(mean(stats.tokens) * 100, 0)}%` : '--']
    })
out.operators = operatorStats
table(['model', 'operator', 'applied', 'rejected', 'Δ dev pass', 'improved', 'Δ tokens'], operatorRows)

console.log('Recommended crews re-measured (selected minus baseline, same conditions)\n')
const confirmRows = []
for (const model of MODELS) {
    for (const goal of GOALS) {
        const dir = join(model.dir, goal)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir).filter((item) => /^confirm-.*\.json$/.test(item))) {
            const confirm = read(join(dir, name))
            if (!confirm.selected?.runs?.length) continue
            const devDelta = mean(confirm.selected.runs.map((run) => run.summary.passRate)) - mean(confirm.baseline.runs.map((run) => run.summary.passRate))
            const testDelta = mean(confirm.selected.runs.map((run) => run.testSummary.passRate)) - mean(confirm.baseline.runs.map((run) => run.testSummary.passRate))
            const reportedDev = confirm.selected.searchSummary?.passRate
            ;(out.confirm ??= []).push({ model: model.label, goal, file: name, devDelta, testDelta })
            confirmRows.push([model.label, goal, name.replace(/^confirm-|\.json$/g, ''), f(reportedDev), f(devDelta), f(testDelta)])
        }
    }
}
table(['model', 'goal', 'search', 'reported dev pass', 'Δ dev (re-measured)', 'Δ test (re-measured)'], confirmRows)
for (const model of MODELS) {
    const rows = (out.confirm || []).filter((row) => row.model === model.label)
    console.log(`${model.label}: ${rows.length} recommended crews, mean Δ dev ${f(mean(rows.map((row) => row.devDelta)))}, mean Δ test ${f(mean(rows.map((row) => row.testDelta)))}`)
}

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex > 0) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(out, null, 2))
