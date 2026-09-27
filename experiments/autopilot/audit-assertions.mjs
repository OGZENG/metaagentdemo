#!/usr/bin/env node
/**
 * Manual audit of failed assertions (thesis section 6.2).
 *
 * Draws a stratified random sample of assertions that failed in the baseline
 * runs and writes everything needed to judge them by hand: the case, the
 * assertion, the recorded tool calls and the reply. Each sampled item is then
 * labelled in results/assertion-audit-labels.json as
 *
 *   valid    the workflow really violated what the case intends
 *   false    the workflow behaved acceptably; the assertion is too literal,
 *            names the wrong tool or arguments, or contradicts the fixtures
 *   unclear  the case itself leaves the correct behavior open
 *
 * together with a short reason.
 *
 *   node experiments/autopilot/audit-assertions.mjs sample
 *   node experiments/autopilot/audit-assertions.mjs report [--tex <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'

const RES = join(ROOT, 'results')
const SAMPLE = join(RES, 'assertion-audit-sample.json')
const LABELS = join(RES, 'assertion-audit-labels.json')
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const goals = read(join(ROOT, 'goals.json'))
const [command] = process.argv.slice(2)
const texIndex = process.argv.indexOf('--tex')
const texDir = texIndex > 0 ? process.argv[texIndex + 1] : null

// Items per assertion type; small types are sampled completely or nearly so.
const QUOTA = { tool_called: 15, output_contains: 15, tool_succeeded: 10, tool_not_called: 5, grounded: 5, output_not_contains: 5, output_matches: 5 }
const ORDER = Object.keys(QUOTA)

// Deterministic PRNG (mulberry32) so the sample can be reproduced.
const rng = (seed) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

if (command === 'sample') {
    const pool = {}
    for (const goal of goals) {
        const file = join(RES, goal.id, 'baseline.json')
        if (!existsSync(file)) continue
        const { design } = read(join(RES, goal.id, 'design.json'))
        for (const rep of read(file).repetitions) {
            for (const result of [...rep.devResults, ...rep.testResults]) {
                const scenario = design.scenarios.find((s) => s.id === result.scenarioId)
                for (const assertion of result.evaluation?.assertionResults || []) {
                    if (assertion.passed) continue
                    const spec = scenario?.assertions?.find((a) => a.id === assertion.id) || {}
                    ;(pool[assertion.type] ||= []).push({
                        key: `${goal.id}/rep${rep.rep}/${result.scenarioId}/${assertion.id}`,
                        goal: goal.id,
                        type: assertion.type,
                        severity: assertion.severity,
                        case: { title: scenario?.title, input: scenario?.input, expectedBehavior: scenario?.expectedBehavior, mustNot: scenario?.mustNot },
                        assertion: { description: spec.description, tool: spec.tool, withArgs: spec.withArgs, anyOf: spec.anyOf, pattern: spec.pattern, forbidden: spec.forbidden },
                        detail: assertion.detail,
                        toolCalls: (result.toolCalls || []).map((call) => ({ tool: call.tool, input: call.toolInput, output: String(call.toolOutput || '').slice(0, 400) })),
                        reply: result.output
                    })
                }
            }
        }
    }
    const random = rng(20260927)
    const sample = []
    for (const type of ORDER) {
        const items = [...(pool[type] || [])]
        // Fisher-Yates shuffle, then take the quota.
        for (let i = items.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1))
            ;[items[i], items[j]] = [items[j], items[i]]
        }
        sample.push(...items.slice(0, QUOTA[type]).map((item) => ({ ...item, population: pool[type].length })))
    }
    writeFileSync(SAMPLE, JSON.stringify(sample, null, 2))
    console.log(`${sample.length} failed assertions sampled from ${Object.values(pool).reduce((sum, items) => sum + items.length, 0)}`)
} else if (command === 'report') {
    const sample = read(SAMPLE)
    const labels = read(LABELS)
    const rows = ORDER.map((type) => {
        const items = sample.filter((item) => item.type === type)
        const count = (label) => items.filter((item) => labels[item.key]?.label === label).length
        return { type, population: items[0]?.population || 0, n: items.length, valid: count('valid'), false: count('false'), unclear: count('unclear') }
    })
    const unlabelled = sample.filter((item) => !labels[item.key]).length
    if (unlabelled) console.log(`${unlabelled} item(s) not labelled yet`)
    // Population-weighted estimate of the false-failure share over all failed assertions.
    const population = rows.reduce((sum, row) => sum + row.population, 0)
    const weighted = rows.reduce((sum, row) => sum + (row.n ? (row.false / row.n) * row.population : 0), 0) / population
    // Reference point: baseline pass rate if cases were decided by the rubric alone.
    let cases = 0
    let recordedPass = 0
    let rubricPass = 0
    for (const goal of goals) {
        const file = join(RES, goal.id, 'baseline.json')
        if (!existsSync(file)) continue
        for (const rep of read(file).repetitions) {
            for (const result of [...rep.devResults, ...rep.testResults]) {
                if (!result.evaluation) continue
                cases += 1
                if (result.evaluation.passed) recordedPass += 1
                if (result.evaluation.softScore >= 70) rubricPass += 1
            }
        }
    }
    console.log(`baseline cases: ${cases}, passed ${recordedPass} as recorded, ${rubricPass} by rubric alone`)
    for (const row of rows) console.log(`${row.type}: ${row.valid} valid, ${row.false} false, ${row.unclear} unclear of ${row.n} (population ${row.population})`)
    console.log(`estimated false failures: ${(weighted * 100).toFixed(0)} % of ${population} failed assertions`)
    if (texDir) {
        mkdirSync(texDir, { recursive: true })
        const header = '% Generated by experiments/autopilot/audit-assertions.mjs -- do not edit by hand.\n'
        const body = rows.map((row) => `        \\code{${row.type.replace(/_/g, '\\_')}} & ${row.population} & ${row.n} & ${row.valid} & ${row.false} & ${row.unclear} \\\\`).join('\n')
        const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)
        writeFileSync(
            join(texDir, 'e1_audit.tex'),
            `${header}\\begin{tabular}{lrrrrr}\n    \\toprule\n    Assertion type & Failed & Sampled & Valid & False & Unclear \\\\\n    \\midrule\n${body}\n    \\midrule\n        Total & ${population} & ${total('n')} & ${total('valid')} & ${total('false')} & ${total('unclear')} \\\\\n    \\bottomrule\n\\end{tabular}%\n`
        )
        writeFileSync(
            join(texDir, 'e1_audit_numbers.tex'),
            `${header}\\newcommand{\\AuditN}{${total('n')}}%\n\\newcommand{\\AuditValid}{${total('valid')}}%\n\\newcommand{\\AuditFalse}{${total('false')}}%\n\\newcommand{\\AuditUnclear}{${total('unclear')}}%\n\\newcommand{\\AuditFalseWeighted}{${(weighted * 100).toFixed(0)}}%\n` +
                `\\newcommand{\\AuditPopulation}{${population}}%\n\\newcommand{\\AuditRecordedPass}{${((recordedPass / cases) * 100).toFixed(0)}}%\n\\newcommand{\\AuditRubricPass}{${((rubricPass / cases) * 100).toFixed(0)}}%\n`
        )
    }
} else {
    console.error('Usage: audit-assertions.mjs sample | report [--tex <dir>]')
    process.exit(1)
}
