#!/usr/bin/env node
/**
 * Tables of the repeated experiment on the validated test world (E4, thesis
 * section 6.5): what the validation changed, the re-scored original baselines,
 * the new baselines, the three strategies run in the same period, Fisher tests
 * and the re-measurement of recommended crews.
 *
 *   node experiments/autopilot/summarize-validated.mjs [--tex <dir>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'

const ORIGINAL = join(ROOT, 'results')
// --world repaired: the second repeated experiment (E5) on the repaired world,
// compared with E4 instead of the original experiment.
const worldIndex = process.argv.indexOf('--world')
const world = worldIndex > 0 ? process.argv[worldIndex + 1] : 'validated'
const VALIDATED = join(ROOT, world === 'repaired' ? 'results-repaired' : 'results-validated')
const REFERENCE = world === 'repaired' ? join(ROOT, 'results-validated') : ORIGINAL
const TEX = world === 'repaired' ? 'e5' : 'e4'
const MACRO = world === 'repaired' ? 'EFive' : 'EFour'
const COLUMNS = world === 'repaired' ? 'validated & repaired' : 'original & validated'
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
const pct = (part, whole) => (whole ? `${fmt((part / whole) * 100, 0)}\\,\\%` : '--')
const esc = (text) => String(text).replace(/_/g, '\\_')

const goals = read(join(ROOT, 'goals.json')).filter((goal) => existsSync(join(VALIDATED, goal.id, 'design.json')))
const STRATEGIES = ['random', 'evidence_guided_v2', 'regenerate']
const LABEL = { random: 'Random', evidence_guided_v2: 'Evidence-guided v2', regenerate: 'Regenerate' }
const summary = { validation: [], rescore: [], baselines: [], searches: [], confirm: [] }

/* ---------------- validation ---------------- */
for (const goal of goals) {
    const validated = read(join(VALIDATED, goal.id, 'design.json'))
    const original = read(join(ORIGINAL, goal.id, 'design.json'))
    const count = (design) => design.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0)
    const changes = validated.testWorldChanges || []
    summary.validation.push({
        goal: goal.id,
        before: count(original.design),
        after: count(validated.design),
        droppedArguments: changes.filter((c) => c.action === 'drop_argument').length,
        callOnly: changes.filter((c) => c.action === 'require_call_only').length,
        droppedByRule: changes.filter((c) => c.action === 'drop_assertion' && c.source === 'rule').length,
        droppedByReview: changes.filter((c) => c.action === 'drop_assertion' && c.source === 'review').length
    })
}

/* ---------------- environment repair and held-out extension (E5) ---------------- */
summary.environment = []
if (world === 'repaired') {
    for (const goal of goals) {
        const repaired = read(join(VALIDATED, goal.id, 'design.json'))
        const reference = read(join(REFERENCE, goal.id, 'design.json'))
        const changes = repaired.environmentChanges || []
        const heldOut = (design) => design.scenarios.filter((scenario) => scenario.split === 'test').length
        summary.environment.push({
            goal: goal.id,
            heldOutBefore: heldOut(reference.design),
            heldOutAfter: heldOut(repaired.design),
            added: changes.filter((c) => c.action === 'add_fixture').length,
            rejected: changes.filter((c) => c.action === 'reject').length,
            skipped: changes.filter((c) => c.action === 'skip').length,
            assertionChanges: (repaired.testWorldChanges || []).length
        })
    }
}

/* ---------------- re-scored original baselines ---------------- */
for (const goal of goals) {
    const file = join(VALIDATED, goal.id, 'rescore-baseline.json')
    if (!existsSync(file)) continue
    const { cases } = read(file)
    summary.rescore.push({
        goal: goal.id,
        replies: cases.length,
        passedBefore: cases.filter((item) => item.original.passed).length,
        passedAfter: cases.filter((item) => item.evaluation.passed).length,
        criticalBefore: cases.filter((item) => item.original.criticalViolation).length,
        criticalAfter: cases.filter((item) => item.evaluation.criticalViolation).length,
        hardBefore: mean(cases.map((item) => item.original.assertionScore)),
        hardAfter: mean(cases.map((item) => item.evaluation.assertionScore)),
        factChecks: cases.reduce((sum, item) => sum + Number(item.evaluation.factChecks || 0), 0)
    })
}

/* ---------------- baselines ---------------- */
for (const goal of goals) {
    const file = join(VALIDATED, goal.id, 'baseline.json')
    if (!existsSync(file)) continue
    const reps = read(file).repetitions
    const originalReps = read(join(REFERENCE, goal.id, 'baseline.json')).repetitions
    summary.baselines.push({
        goal: goal.id,
        domain: goal.domain,
        devPass: reps.map((rep) => rep.summary.passRate),
        testPass: reps.map((rep) => rep.testSummary.passRate),
        quality: reps.map((rep) => rep.summary.quality),
        originalDevPass: originalReps.map((rep) => rep.summary.passRate),
        originalTestPass: originalReps.map((rep) => rep.testSummary.passRate),
        tokens: reps.map((rep) => rep.summary.averageTokens)
    })
}

/* ---------------- searches ---------------- */
for (const goal of goals) {
    const dir = join(VALIDATED, goal.id)
    for (const file of readdirSync(dir).filter((name) => /^search-.*\.json$/.test(name))) {
        const s = read(join(dir, file))
        const base = s.trials[0]
        const selected = s.trials.find((trial) => trial.id === s.selectedTrialId) || null
        const candidates = s.trials.slice(1)
        const devCount = new Set(base.devResults.map((result) => result.scenarioId)).size
        const oneCase = devCount ? 1 / devCount : 0
        summary.searches.push({
            goal: goal.id,
            strategy: s.strategy,
            rep: s.rep,
            file,
            minutes: s.durationMs / 60000,
            candidates: candidates.length,
            rejected: candidates.filter((t) => t.status === 'rejected').length,
            betterThanParent: candidates.filter((t) => {
                const parent = s.trials.find((p) => p.id === t.parentId)
                return t.summary && parent?.summary && t.summary.passRate > parent.summary.passRate
            }).length,
            measured: candidates.filter((t) => t.summary).length,
            basePass: base.summary.passRate,
            bestPass: Math.max(...s.trials.filter((t) => t.summary).map((t) => t.summary.passRate)),
            oneCase,
            outcome: !selected ? 'none' : selected.id === 'baseline' ? 'base' : 'new',
            dDev: selected && selected.id !== 'baseline' ? selected.summary.passRate - base.summary.passRate : null,
            dTest: selected && selected.id !== 'baseline' && selected.testSummary && base.testSummary ? selected.testSummary.passRate - base.testSummary.passRate : null,
            dTokens: selected && selected.id !== 'baseline' ? (selected.summary.averageTokens / base.summary.averageTokens - 1) * 100 : null
        })
    }
}

/* ---------------- re-measurement ---------------- */
for (const goal of goals) {
    const dir = join(VALIDATED, goal.id)
    for (const file of readdirSync(dir).filter((name) => /^confirm-.*\.json$/.test(name))) {
        const c = read(join(dir, file))
        const avg = (runs, field) => mean(runs.map((run) => run[field]?.passRate).filter(Number.isFinite))
        summary.confirm.push({
            goal: goal.id,
            strategy: c.strategy,
            dDev: avg(c.selected.runs, 'summary') - avg(c.baseline.runs, 'summary'),
            dTest: avg(c.selected.runs, 'testSummary') - avg(c.baseline.runs, 'testSummary')
        })
    }
}

/* ---------------- Fisher's exact test ---------------- */
const logFactorial = (() => {
    const cache = [0]
    return (n) => {
        for (let i = cache.length; i <= n; i += 1) cache[i] = cache[i - 1] + Math.log(i)
        return cache[n]
    }
})()
const fisher = (a, b, c, d) => {
    const row1 = a + b
    const col1 = a + c
    const n = a + b + c + d
    const p = (x) =>
        Math.exp(
            logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n) - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(n - row1 - col1 + x)
        )
    const observed = p(a)
    let total = 0
    for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x += 1) if (p(x) <= observed * (1 + 1e-9)) total += p(x)
    return Math.min(1, total)
}
const pooled = Object.fromEntries(
    STRATEGIES.map((strategy) => {
        const runs = summary.searches.filter((s) => s.strategy === strategy)
        return [
            strategy,
            {
                searches: runs.length,
                candidates: runs.reduce((sum, s) => sum + s.candidates, 0),
                measured: runs.reduce((sum, s) => sum + s.measured, 0),
                rejected: runs.reduce((sum, s) => sum + s.rejected, 0),
                better: runs.reduce((sum, s) => sum + s.betterThanParent, 0),
                improved: runs.filter((s) => s.bestPass > s.basePass + 1e-9).length,
                improvedByCase: runs.filter((s) => s.bestPass >= s.basePass + s.oneCase - 1e-9).length,
                newCrew: runs.filter((s) => s.outcome === 'new'),
                none: runs.filter((s) => s.outcome === 'none').length,
                base: runs.filter((s) => s.outcome === 'base').length
            }
        ]
    })
)
const tests = []
for (let i = 0; i < STRATEGIES.length; i += 1) {
    for (let j = i + 1; j < STRATEGIES.length; j += 1) {
        const x = pooled[STRATEGIES[i]]
        const y = pooled[STRATEGIES[j]]
        if (!x.searches || !y.searches) continue
        tests.push({
            left: STRATEGIES[i],
            right: STRATEGIES[j],
            pBetter: fisher(x.better, x.measured - x.better, y.better, y.measured - y.better),
            pImproved: fisher(x.improvedByCase, x.searches - x.improvedByCase, y.improvedByCase, y.searches - y.improvedByCase)
        })
    }
}
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
summary.pooled = Object.fromEntries(Object.entries(pooled).map(([k, v]) => [k, { ...v, newCrew: v.newCrew.length }]))
summary.tests = tests
writeFileSync(join(VALIDATED, 'summary.json'), JSON.stringify(summary, null, 2))

for (const [strategy, p] of Object.entries(pooled)) {
    console.log(
        `${strategy}: ${p.searches} searches, better ${p.better}/${p.measured}, improved ${p.improved} (by a case ${p.improvedByCase}), new ${p.newCrew.length}, dDev ${fmt(mean(p.newCrew.map((s) => s.dDev)))}, dTest ${fmt(mean(p.newCrew.map((s) => s.dTest).filter(Number.isFinite)))}`
    )
}
for (const t of tests) console.log(`${t.left} vs ${t.right}: p ${fmt(t.pBetter, 3)} (Holm ${fmt(t.pBetterHolm, 2)}) / ${fmt(t.pImproved, 3)} (Holm ${fmt(t.pImprovedHolm, 2)})`)

if (texDir) {
    mkdirSync(texDir, { recursive: true })
    const header = '% Generated by experiments/autopilot/summarize-validated.mjs -- do not edit by hand.\n'
    const byGoal = Object.fromEntries(goals.map((goal) => [goal.id, goal.domain]))

    if (summary.environment.length) {
        const envRows = summary.environment.map(
            (e) =>
                `        ${esc(byGoal[e.goal])} & ${e.heldOutBefore} & ${e.heldOutAfter} & ${e.added} & ${e.rejected} & ${e.skipped} & ${e.assertionChanges} \\\\`
        )
        const etotal = (key) => summary.environment.reduce((sum, e) => sum + e[key], 0)
        envRows.push(
            `        \\midrule\n        All & ${etotal('heldOutBefore')} & ${etotal('heldOutAfter')} & ${etotal('added')} & ${etotal('rejected')} & ${etotal('skipped')} & ${etotal('assertionChanges')} \\\\`
        )
        writeFileSync(
            join(texDir, `${TEX}_environment.tex`),
            `${header}\\begin{tabular}{lrrrrrr}\n    \\toprule\n    & \\multicolumn{2}{c}{Held-out cases} & \\multicolumn{3}{c}{Repair fixtures} & \\\\\n    \\cmidrule(lr){2-3}\\cmidrule(lr){4-6}\n    Domain & before & after & added & rejected & skipped & Assertion changes \\\\\n    \\midrule\n${envRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
        )
    }
    const valRows = summary.validation.map((v) => {
        const r = summary.rescore.find((item) => item.goal === v.goal)
        return `        ${esc(byGoal[v.goal])} & ${v.before} & ${v.droppedArguments} & ${v.callOnly} & ${v.droppedByRule + v.droppedByReview} & ${v.after} & ${r ? `${r.passedBefore}/${r.replies}` : '--'} & ${r ? `${r.passedAfter}/${r.replies}` : '--'} \\\\`
    })
    const total = (key) => summary.validation.reduce((sum, v) => sum + v[key], 0)
    const rtotal = (key) => summary.rescore.reduce((sum, r) => sum + r[key], 0)
    valRows.push(
        `        \\midrule\n        All & ${total('before')} & ${total('droppedArguments')} & ${total('callOnly')} & ${total('droppedByRule') + total('droppedByReview')} & ${total('after')} & ${rtotal('passedBefore')}/${rtotal('replies')} & ${rtotal('passedAfter')}/${rtotal('replies')} \\\\`
    )
    writeFileSync(
        join(texDir, `${TEX}_validation.tex`),
        `${header}\\begin{tabular}{lrrrrrcc}\n    \\toprule\n    & \\multicolumn{5}{c}{Assertions} & \\multicolumn{2}{c}{Original baseline replies passed} \\\\\n    \\cmidrule(lr){2-6}\\cmidrule(lr){7-8}\n    Domain & Before & Args dropped & Call only & Dropped & After & as recorded & re-scored \\\\\n    \\midrule\n${valRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const baseRows = summary.baselines.map(
        (b) => `        ${esc(b.domain)} & ${pm(b.originalDevPass)} & ${pm(b.devPass)} & ${pm(b.originalTestPass)} & ${pm(b.testPass)} \\\\`
    )
    writeFileSync(
        join(texDir, `${TEX}_baseline.tex`),
        `${header}\\begin{tabular}{lcccc}\n    \\toprule\n    & \\multicolumn{2}{c}{Dev pass} & \\multicolumn{2}{c}{Test pass} \\\\\n    \\cmidrule(lr){2-3}\\cmidrule(lr){4-5}\n    Domain & ${COLUMNS} & ${COLUMNS} \\\\\n    \\midrule\n${baseRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const stratRows = STRATEGIES.filter((s) => pooled[s].searches).map((strategy) => {
        const p = pooled[strategy]
        const confirm = summary.confirm.filter((c) => c.strategy === strategy)
        return `        ${LABEL[strategy]} & ${p.searches} & ${p.candidates} & ${pct(p.better, p.measured)} & ${p.improvedByCase}/${p.searches} & ${p.newCrew.length}/${p.base}/${p.none} & ${pm(p.newCrew.map((s) => s.dDev))} & ${pm(p.newCrew.map((s) => s.dTest).filter(Number.isFinite))} & ${pm(confirm.map((c) => c.dTest).filter(Number.isFinite))} & ${pm(p.newCrew.map((s) => s.dTokens), 0)} \\\\`
    })
    writeFileSync(
        join(texDir, `${TEX}_strategies.tex`),
        `${header}\\begin{tabular}{lrrrrcccccc}\n    \\toprule\n    & & & Cand.\\ better & Search improved & Selected & \\multicolumn{3}{c}{Selected crew} & \\\\\n    \\cmidrule(lr){7-9}\n    Strategy & Searches & Cand. & than parent & by $\\geq$ 1 case & new/base/none & $\\Delta$ dev & $\\Delta$ test & $\\Delta$ test (re-meas.) & $\\Delta$ tokens [\\%] \\\\\n    \\midrule\n${stratRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const testRows = tests.map(
        (t) => `        ${LABEL[t.left]} vs.\\ ${LABEL[t.right]} & ${fmt(t.pBetter, 2)} (${fmt(t.pBetterHolm, 2)}) & ${fmt(t.pImproved, 2)} (${fmt(t.pImprovedHolm, 2)}) \\\\`
    )
    writeFileSync(
        join(texDir, `${TEX}_tests.tex`),
        `${header}\\begin{tabular}{lcc}\n    \\toprule\n    Comparison & Cand.\\ better than parent & Search improved by $\\geq$ 1 case \\\\\n    \\midrule\n${testRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const allNew = STRATEGIES.flatMap((s) => pooled[s].newCrew)
    const macros = {
        EFourAssertBefore: total('before'),
        EFourAssertAfter: total('after'),
        EFourChanges: summary.validation.reduce((sum, v) => sum + v.droppedArguments + v.callOnly + v.droppedByRule + v.droppedByReview, 0),
        EFourReviewDrops: total('droppedByReview'),
        EFourReplies: rtotal('replies'),
        EFourPassedBefore: rtotal('passedBefore'),
        EFourPassedAfter: rtotal('passedAfter'),
        EFourFactChecks: rtotal('factChecks'),
        EFourBaseDevOld: fmt(mean(summary.baselines.flatMap((b) => b.originalDevPass))),
        EFourBaseDevNew: fmt(mean(summary.baselines.flatMap((b) => b.devPass))),
        EFourBaseDevStdNew: fmt(Math.max(...summary.baselines.map((b) => std(b.devPass)))),
        EFourSearches: summary.searches.length,
        EFourNewCrews: allNew.length,
        EFourNewDev: fmt(mean(allNew.map((s) => s.dDev))),
        EFourNewTest: fmt(mean(allNew.map((s) => s.dTest).filter(Number.isFinite))),
        EFourNewTestN: allNew.filter((s) => Number.isFinite(s.dTest)).length,
        EFourConfirmDev: fmt(mean(summary.confirm.map((c) => c.dDev).filter(Number.isFinite))),
        EFourConfirmTest: fmt(mean(summary.confirm.map((c) => c.dTest).filter(Number.isFinite))),
        EFourConfirmN: summary.confirm.length,
        EFourMinPHolm: fmt(Math.min(...tests.map((t) => Math.min(t.pBetterHolm, t.pImprovedHolm))), 2),
        EFourMinutes: fmt(mean(summary.searches.map((s) => s.minutes)), 0)
    }
    writeFileSync(
        join(texDir, `${TEX}_numbers.tex`),
        header + Object.entries(macros).map(([k, v]) => `\\newcommand{\\${k.replace('EFour', MACRO)}}{${v}}%`).join('\n') + '\n'
    )
    console.log(`LaTeX tables written to ${texDir}`)
}
