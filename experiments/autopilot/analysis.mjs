#!/usr/bin/env node
/**
 * Offline analyses of the recorded searches (thesis chapter 6). No model calls
 * except for `--measure-heldout`.
 *
 *  1. Re-selection: every search is re-selected under the earlier cost-first
 *     rule and under the pass-first rule that is now the studio default.
 *  2. Significance: Fisher's exact test (two-sided) for the differences
 *     between strategies in candidates better than their parent and in
 *     searches that improved on the baseline.
 *  3. Robustness: the strategy comparison is repeated with every pass
 *     decision re-scored under other assertion weights and thresholds.
 *
 *   node experiments/autopilot/analysis.mjs [--tex <dir>]
 *   node experiments/autopilot/analysis.mjs --measure-heldout
 *
 * `--measure-heldout` runs the held-out cases for crews that only the
 * pass-first rule selects and that were therefore never measured on them. The
 * results go to results/<goal>/heldout-extra.json; raw search files stay as
 * recorded.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'
import { DEFAULT_SETTINGS } from './lib/runner.mjs'
import { selectNextTrial, splitScenarios, summarizeStudioResults } from '../../packages/ui/src/views/metaagent/studioUtils.js'

const RES = join(ROOT, 'results')
const texIndex = process.argv.indexOf('--tex')
const texDir = texIndex > 0 ? process.argv[texIndex + 1] : null
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN)
const std = (values) => {
    if (values.length < 2) return 0
    const m = mean(values)
    return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1))
}
const fmt = (value, digits = 2) => {
    if (!Number.isFinite(value)) return '--'
    const text = value.toFixed(digits)
    return /^-0\.?0*$/.test(text) ? text.slice(1) : text
}
const pm = (values, digits = 2) => (values.length ? `${fmt(mean(values), digits)} $\\pm$ ${fmt(std(values), digits)}` : '--')

const goals = read(join(ROOT, 'goals.json'))
const strategyOf = (search) => (search.strategy === 'evidence_guided' && search.rep >= 4 ? 'evidence_guided_control' : search.strategy)
const STRATEGIES = ['random', 'greedy', 'evidence_guided', 'evidence_guided_control', 'evidence_guided_v2', 'regenerate']
const LABEL = {
    random: 'Random',
    greedy: 'Greedy',
    evidence_guided: 'Evidence-guided',
    evidence_guided_control: 'Evidence-guided (control)',
    evidence_guided_v2: 'Evidence-guided v2',
    regenerate: 'Regenerate (no operators)'
}

const searches = []
for (const goal of goals) {
    const dir = join(RES, goal.id)
    if (!existsSync(join(dir, 'design.json'))) continue
    const extraFile = join(dir, 'heldout-extra.json')
    const extra = existsSync(extraFile) ? read(extraFile) : {}
    for (const file of readdirSync(dir).filter((name) => /^search-.*\.json$/.test(name)).sort()) {
        const search = read(join(dir, file))
        for (const trial of search.trials) {
            const key = `${file}/${trial.id}`
            if (!trial.testSummary && extra[key]) Object.assign(trial, { testSummary: extra[key].testSummary, testFromExtra: true })
        }
        searches.push({ goal: goal.id, file, dir, strategy: strategyOf(search), search })
    }
}

/* ---------------- 1. Re-selection under both rules ---------------- */
const settings = DEFAULT_SETTINGS
const select = (trials, rule) =>
    selectNextTrial(trials, Number(trials[0].summary?.quality || 0), settings.allowedQualityLoss, settings.minimumPassRate, settings.maximumFailureRate, rule)

const selection = searches.map(({ goal, file, strategy, search }) => {
    const base = search.trials[0]
    const entry = { goal, file, strategy }
    for (const rule of ['cost_first', 'pass_first']) {
        const picked = select(search.trials, rule)
        entry[rule] = {
            id: picked?.id || null,
            outcome: !picked ? 'none' : picked.id === 'baseline' ? 'base' : 'new',
            dDev: picked ? picked.summary.passRate - base.summary.passRate : null,
            dTest: picked && picked.testSummary && base.testSummary ? picked.testSummary.passRate - base.testSummary.passRate : null,
            missingTest: Boolean(picked && !picked.testSummary),
            dTokensPct: picked && base.summary.averageTokens ? (picked.summary.averageTokens / base.summary.averageTokens - 1) * 100 : null
        }
    }
    return entry
})

const missing = selection.filter((row) => row.pass_first.missingTest).map((row) => ({ goal: row.goal, file: row.file, id: row.pass_first.id }))

if (process.argv.includes('--measure-heldout')) {
    const { runScenarios } = await import('./lib/runner.mjs')
    const selectedChatModel = read(join(ROOT, 'model.json'))
    for (const item of missing) {
        const dir = join(RES, item.goal)
        const extraFile = join(dir, 'heldout-extra.json')
        const extra = existsSync(extraFile) ? read(extraFile) : {}
        const key = `${item.file}/${item.id}`
        if (extra[key]) continue
        const { design, goal } = read(join(dir, 'design.json'))
        const trial = read(join(dir, item.file)).trials.find((t) => t.id === item.id)
        const { test } = splitScenarios(design.scenarios)
        const testResults = await runScenarios({
            trial: { ...trial, flowData: { nodes: [] } },
            scenarios: test,
            goal,
            design,
            selectedChatModel,
            settings: { ...DEFAULT_SETTINGS, concurrency: 1 },
            runPrefix: `heldout-extra-${item.goal}`
        })
        extra[key] = { measuredAt: new Date().toISOString(), testResults, testSummary: summarizeStudioResults(testResults) }
        writeFileSync(extraFile, JSON.stringify(extra, null, 2))
        console.log(`held-out ${item.goal} ${key}: pass ${extra[key].testSummary.passRate.toFixed(2)}`)
    }
    process.exit(0)
}

/* ---------------- 2. Fisher's exact test ---------------- */
const logFactorial = (() => {
    const cache = [0]
    return (n) => {
        for (let i = cache.length; i <= n; i += 1) cache[i] = cache[i - 1] + Math.log(i)
        return cache[n]
    }
})()
/** Two-sided Fisher's exact test for [[a, b], [c, d]]. */
const fisher = (a, b, c, d) => {
    const row1 = a + b
    const col1 = a + c
    const n = a + b + c + d
    const p = (x) => Math.exp(logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n) - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(n - row1 - col1 + x))
    const observed = p(a)
    let total = 0
    for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x += 1) {
        const value = p(x)
        if (value <= observed * (1 + 1e-9)) total += value
    }
    return Math.min(1, total)
}

/**
 * Per-strategy counts with pass decisions possibly re-scored (weight w,
 * threshold t). With w = 0.6 and t = 70 the recorded decisions are reproduced.
 */
const decide = (evaluation, weight, threshold) => {
    const hasAssertions = (evaluation.assertionSummary?.total || 0) > 0
    const score = hasAssertions ? weight * evaluation.assertionScore + (1 - weight) * evaluation.softScore : evaluation.softScore
    return !evaluation.criticalViolation && score >= threshold
}
const passRate = (results, weight, threshold) => {
    const completed = (results || []).filter((result) => !result.error && result.evaluation)
    return completed.length ? completed.filter((result) => decide(result.evaluation, weight, threshold)).length / completed.length : 0
}
const countsFor = (weight, threshold) => {
    const counts = {}
    for (const { strategy, search } of searches) {
        const entry = (counts[strategy] ||= { candidates: 0, better: 0, searches: 0, improved: 0 })
        const rate = new Map(search.trials.map((trial) => [trial.id, trial.devResults?.length ? passRate(trial.devResults, weight, threshold) : null]))
        const base = rate.get('baseline')
        entry.searches += 1
        let improved = false
        for (const trial of search.trials.slice(1)) {
            entry.candidates += 1
            const own = rate.get(trial.id)
            const parent = rate.get(trial.parentId)
            if (own !== null && parent !== null && own > parent) entry.better += 1
            if (own !== null && own > base) improved = true
        }
        if (improved) entry.improved += 1
    }
    return counts
}

const recorded = countsFor(0.6, 70)
const present = STRATEGIES.filter((strategy) => recorded[strategy])
const tests = []
const compare = (left, right) => {
    const x = recorded[left]
    const y = recorded[right]
    if (!x || !y) return
    tests.push({
        left,
        right,
        betterLeft: `${x.better}/${x.candidates}`,
        betterRight: `${y.better}/${y.candidates}`,
        pBetter: fisher(x.better, x.candidates - x.better, y.better, y.candidates - y.better),
        improvedLeft: `${x.improved}/${x.searches}`,
        improvedRight: `${y.improved}/${y.searches}`,
        pImproved: fisher(x.improved, x.searches - x.improved, y.improved, y.searches - y.improved)
    })
}
for (const strategy of present.filter((s) => s !== 'random')) compare(strategy, 'random')
compare('evidence_guided_control', 'evidence_guided')
compare('evidence_guided_v2', 'evidence_guided_control')
if (recorded.regenerate) for (const strategy of ['greedy', 'evidence_guided', 'evidence_guided_v2']) compare(strategy, 'regenerate')

// Holm-Bonferroni over all p-values reported in the table.
{
    const all = tests.flatMap((t, i) => [
        { i, key: 'pBetter', p: t.pBetter },
        { i, key: 'pImproved', p: t.pImproved }
    ])
    all.sort((a, b) => a.p - b.p)
    let running = 0
    all.forEach((item, rank) => {
        running = Math.max(running, Math.min(1, (all.length - rank) * item.p))
        tests[item.i][`${item.key}Holm`] = running
    })
}

// Strategies whose searches ran in the same time window.
const PERIODS = [
    ['random', 'greedy', 'evidence_guided'],
    ['evidence_guided_control', 'evidence_guided_v2']
]

/* ---------------- 3. Robustness of the comparison to w and t ---------------- */
const robustness = []
for (const threshold of [60, 70, 80]) {
    for (const weight of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        const counts = countsFor(weight, threshold)
        const share = Object.fromEntries(present.map((s) => [s, counts[s].better / counts[s].candidates]))
        const order = [...present].sort((a, b) => share[b] - share[a])
        // Only strategies run in the same period are compared: the control runs
        // show that the period alone moves these shares (section 6.3).
        let minP = 1
        for (const group of PERIODS) {
            const members = group.filter((strategy) => counts[strategy])
            for (let i = 0; i < members.length; i += 1) {
                for (let j = i + 1; j < members.length; j += 1) {
                    const x = counts[members[i]]
                    const y = counts[members[j]]
                    minP = Math.min(minP, fisher(x.better, x.candidates - x.better, y.better, y.candidates - y.better))
                }
            }
        }
        const periodOrder = PERIODS[0].filter((strategy) => counts[strategy]).sort((a, b) => share[b] - share[a])
        robustness.push({ weight, threshold, share, order, periodOrder, minP })
    }
}

const summary = { selection, missingHeldOut: missing, recorded, tests, robustness }
writeFileSync(join(RES, 'analysis.json'), JSON.stringify(summary, null, 2))

// Pooled numbers ("All", macros) cover the operator-based searches; the
// regenerate baseline is reported in its own row.
const ruleStats = (rule, strategy) => {
    const rows = selection.filter((row) => (strategy ? row.strategy === strategy : row.strategy !== 'regenerate'))
    const picked = rows.map((row) => row[rule])
    const fresh = picked.filter((p) => p.outcome === 'new')
    return {
        rows: rows.length,
        n: fresh.length,
        base: picked.filter((p) => p.outcome === 'base').length,
        none: picked.filter((p) => p.outcome === 'none').length,
        dDev: fresh.map((p) => p.dDev),
        dTest: fresh.filter((p) => p.dTest !== null).map((p) => p.dTest),
        missingTest: fresh.filter((p) => p.missingTest).length,
        worseDev: fresh.filter((p) => p.dDev < 0).length,
        dTokens: fresh.map((p) => p.dTokensPct).filter(Number.isFinite)
    }
}
for (const rule of ['cost_first', 'pass_first']) {
    const s = ruleStats(rule)
    console.log(`${rule}: new ${s.n}/${s.rows} (base ${s.base}, none ${s.none}), dDev ${fmt(mean(s.dDev))}, dTest ${fmt(mean(s.dTest))} (n=${s.dTest.length}, missing ${s.missingTest}), worse on dev ${s.worseDev}`)
}
for (const t of tests) console.log(`${t.left} vs ${t.right}: better ${t.betterLeft} vs ${t.betterRight} p=${fmt(t.pBetter, 3)} (Holm ${fmt(t.pBetterHolm, 2)}) | improved ${t.improvedLeft} vs ${t.improvedRight} p=${fmt(t.pImproved, 3)} (Holm ${fmt(t.pImprovedHolm, 2)})`)
console.log(`robustness (same period): min p ${fmt(Math.min(...robustness.map((r) => r.minP)), 3)}; orders of the first period: ${[...new Set(robustness.map((r) => r.periodOrder.join('>')))].join(' | ')}`)
if (missing.length) console.log(`${missing.length} pass-first selection(s) lack held-out results; run with --measure-heldout`)

if (texDir) {
    mkdirSync(texDir, { recursive: true })
    const header = '% Generated by experiments/autopilot/analysis.mjs -- do not edit by hand.\n'
    const rows = []
    for (const rule of ['cost_first', 'pass_first']) {
        const name = rule === 'cost_first' ? 'Cost first (recorded)' : 'Pass first (new default)'
        rows.push(`        \\multicolumn{7}{l}{\\emph{${name}}} \\\\`)
        for (const strategy of present) {
            const s = ruleStats(rule, strategy)
            rows.push(`        \\quad ${LABEL[strategy]} & ${s.n}/${s.base}/${s.none} & ${s.worseDev} & ${pm(s.dDev)} & ${pm(s.dTest)} & ${pm(s.dTokens, 0)} \\\\`)
        }
        const all = ruleStats(rule)
        rows.push(`        \\quad All operator-based & ${all.n}/${all.base}/${all.none} & ${all.worseDev} & ${pm(all.dDev)} & ${pm(all.dTest)} & ${pm(all.dTokens, 0)} \\\\`)
    }
    writeFileSync(
        join(texDir, 'e2_selection.tex'),
        `${header}\\begin{tabular}{lccccc}\n    \\toprule\n    Rule and strategy & new/base/none & Worse dev & $\\Delta$ dev pass & $\\Delta$ test pass & $\\Delta$ tokens [\\%] \\\\\n    \\midrule\n${rows.join('\n').replace(/\\multicolumn\{7\}/g, '\\multicolumn{6}')}\n    \\bottomrule\n\\end{tabular}%\n`
    )
    const testRows = tests.map(
        (t) => `        ${LABEL[t.left]} vs.\\ ${LABEL[t.right]} & ${t.betterLeft} vs.\\ ${t.betterRight} & ${fmt(t.pBetter, 2)} (${fmt(t.pBetterHolm, 2)}) & ${t.improvedLeft} vs.\\ ${t.improvedRight} & ${fmt(t.pImproved, 2)} (${fmt(t.pImprovedHolm, 2)}) \\\\`
    )
    writeFileSync(
        join(texDir, 'e2_tests.tex'),
        `${header}\\begin{tabular}{lcccc}\n    \\toprule\n    Comparison & Cand.\\ better than parent & $p$ & Searches improved & $p$ \\\\\n    \\midrule\n${testRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )
    const pass = ruleStats('pass_first')
    const cost = ruleStats('cost_first')
    const minP = Math.min(...robustness.map((r) => r.minP))
    const macros = {
        SelCostNew: cost.n,
        SelCostWorse: cost.worseDev,
        SelCostTest: fmt(mean(cost.dTest)),
        SelPassNew: pass.n,
        SelPassWorse: pass.worseDev,
        SelPassDev: fmt(mean(pass.dDev)),
        SelPassTest: fmt(mean(pass.dTest)),
        SelPassTestN: pass.dTest.length,
        SelPassTokens: fmt(mean(pass.dTokens), 0),
        SelSearches: selection.filter((row) => row.strategy !== 'regenerate').length,
        TestMinP: fmt(Math.min(...tests.map((t) => Math.min(t.pBetter, t.pImproved))), 2),
        TestMinPHolm: fmt(Math.min(...tests.map((t) => Math.min(t.pBetterHolm, t.pImprovedHolm))), 2),
        // Comparisons among the operator-based strategies only.
        TestMinPHolmOps: fmt(
            Math.min(
                ...tests
                    .filter((t) => t.left !== 'regenerate' && t.right !== 'regenerate')
                    .map((t) => Math.min(t.pBetterHolm, t.pImprovedHolm))
            ),
            2
        ),
        RobustSettings: robustness.length,
        RobustMinP: fmt(minP, 2),
        RobustOrders: new Set(robustness.map((r) => r.periodOrder.join('>'))).size
    }
    writeFileSync(join(texDir, 'e2_analysis_numbers.tex'), header + Object.entries(macros).map(([k, v]) => `\\newcommand{\\${k}}{${v}}%`).join('\n') + '\n')
    console.log(`LaTeX tables written to ${texDir}`)
}
