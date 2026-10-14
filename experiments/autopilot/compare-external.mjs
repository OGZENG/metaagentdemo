#!/usr/bin/env node
/**
 * Autopilot crews against the external baselines of baselines.mjs on one
 * results folder (default: the Qwen run on the repaired world). Every variant
 * is measured three times on the same frozen test world.
 *
 *   node experiments/autopilot/compare-external.mjs [--dir results-repaired-qwen] [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'

const dirIndex = process.argv.indexOf('--dir')
const dir = join(ROOT, dirIndex > 0 ? process.argv[dirIndex + 1] : 'results-repaired-qwen')
const GOALS = ['support', 'helpdesk', 'travel', 'hr_leave', 'restaurant', 'insurance']
const VARIANTS = [
    { id: 'autopilot', label: 'Autopilot crew', file: 'baseline.json' },
    { id: 'single', label: 'Single agent + contract', file: 'external-single.json' },
    { id: 'single_goal', label: 'Single agent, goal only', file: 'external-single_goal.json' }
]

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN)
const f = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '--')
const isError = (result) => !result.evaluation || Boolean(result.error)

const measure = (file) => {
    const { repetitions } = read(file)
    const all = repetitions.flatMap((rep) => rep.devResults.concat(rep.testResults))
    const dev = repetitions.flatMap((rep) => rep.devResults)
    return {
        devPass: mean(repetitions.map((rep) => rep.summary.passRate)),
        testPass: mean(repetitions.map((rep) => rep.testSummary.passRate)),
        // all cases of all repetitions, dev and held-out
        allPass: mean(all.map((result) => (result.evaluation?.passed ? 1 : 0))),
        assertionScore: mean(all.map((result) => result.evaluation?.assertionScore ?? 0)),
        tokens: mean(dev.map((result) => result.totalTokens || 0)),
        latency: mean(dev.map((result) => (result.durationMs || 0) / 1000)),
        modelCalls: mean(dev.map((result) => result.modelCalls || 0)),
        failures: all.filter(isError).length,
        cases: all.length
    }
}

const out = {}
const rows = []
for (const goal of GOALS) {
    for (const variant of VARIANTS) {
        const file = join(dir, goal, variant.file)
        if (!existsSync(file)) continue
        const m = measure(file)
        ;(out[goal] ??= {})[variant.id] = m
        rows.push([goal, variant.label, f(m.devPass), f(m.testPass), f(m.allPass), f(m.assertionScore, 1), Math.round(m.tokens), f(m.modelCalls, 1), f(m.latency, 1), `${m.failures}/${m.cases}`])
    }
}
const header = ['goal', 'variant', 'dev pass', 'test pass', 'all pass', 'assert', 'tokens', 'calls', 'latency s', 'exec fail']
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)))
const line = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')
console.log(line(header))
let previous = null
for (const row of rows) {
    if (previous && previous !== row[0]) console.log()
    previous = row[0]
    console.log(line(row))
}

console.log('\nMean over goals with all variants')
const complete = GOALS.filter((goal) => VARIANTS.every((variant) => out[goal]?.[variant.id]))
for (const variant of VARIANTS) {
    const values = complete.map((goal) => out[goal][variant.id])
    console.log(
        `${variant.label.padEnd(26)} all pass ${f(mean(values.map((m) => m.allPass)))}  assert ${f(mean(values.map((m) => m.assertionScore)), 1)}  ` +
            `tokens ${Math.round(mean(values.map((m) => m.tokens)))}  latency ${f(mean(values.map((m) => m.latency)), 1)} s  (${complete.length} goals)`
    )
}

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex > 0) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(out, null, 2))
