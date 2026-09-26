#!/usr/bin/env node
/**
 * Aggregates experiment results into results/summary.json and LaTeX tables.
 *
 *   node experiments/autopilot/summarize.mjs [--tex <dir>]
 *
 * With --tex, the tables are written as .tex files into <dir> (the thesis'
 * tables folder), so every number in chapter 6 is regenerated from raw results.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/api.mjs'

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
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '--')
const pm = (values, digits = 2) => (values.length ? `${fmt(mean(values), digits)} $\\pm$ ${fmt(std(values), digits)}` : '--')
const esc = (text) => String(text).replace(/_/g, '\\_').replace(/&/g, '\\&')

const goals = read(join(ROOT, 'goals.json'))
const summary = { generation: [], search: [], parallel: null }

/* ---------------- E1: generation and baseline ---------------- */
for (const goal of goals) {
    const dir = join(RES, goal.id)
    if (!existsSync(join(dir, 'design.json'))) continue
    const d = read(join(dir, 'design.json'))
    const scenarios = d.design.scenarios
    const row = {
        goal: goal.id,
        domain: goal.domain,
        designSeconds: d.durationMs / 1000,
        tools: d.design.tools.length,
        fixtures: d.design.tools.reduce((sum, tool) => sum + tool.fixtures.length, 0),
        failureFixtures: d.design.tools.reduce((sum, tool) => sum + tool.fixtures.filter((fixture) => fixture.error).length, 0),
        dev: scenarios.filter((s) => s.split !== 'test').length,
        test: scenarios.filter((s) => s.split === 'test').length,
        assertions: scenarios.reduce((sum, s) => sum + (s.assertions || []).length, 0),
        agents: d.crewSummary?.agentCount,
        tasks: d.crewSummary?.taskCount,
        process: d.design.crew.process,
        warnings: d.validation?.warnings?.length || 0,
        errors: d.validation?.errors?.length || 0,
        baseline: null
    }
    if (existsSync(join(dir, 'baseline.json'))) {
        const b = read(join(dir, 'baseline.json'))
        const reps = b.repetitions
        const pick = (key, field = 'summary') => reps.map((rep) => Number(rep[field]?.[key])).filter(Number.isFinite)
        row.baseline = {
            reps: reps.length,
            devPass: pick('passRate'),
            devQuality: pick('quality'),
            testPass: pick('passRate', 'testSummary'),
            failed: reps.map((rep) => rep.summary.failed + rep.testSummary.failed),
            tokens: pick('averageTokens'),
            cost: pick('averageCost'),
            latency: pick('averageDurationMs').map((ms) => ms / 1000),
            modelCalls: pick('averageModelCalls')
        }
    }
    summary.generation.push(row)
}

/* ---------------- E1: assertion statistics over all baseline runs ---------------- */
{
    const byType = {}
    const hard = []
    const soft = []
    let cases = 0
    let critical = 0
    for (const goal of goals) {
        const file = join(RES, goal.id, 'baseline.json')
        if (!existsSync(file)) continue
        for (const rep of read(file).repetitions) {
            for (const result of [...rep.devResults, ...rep.testResults]) {
                const evaluation = result.evaluation
                if (!evaluation) continue
                cases += 1
                if (evaluation.criticalViolation) critical += 1
                hard.push(evaluation.assertionScore)
                soft.push(evaluation.softScore)
                for (const assertion of evaluation.assertionResults) {
                    const entry = (byType[assertion.type] ||= { total: 0, failed: 0, criticalFailed: 0 })
                    entry.total += 1
                    if (!assertion.passed) {
                        entry.failed += 1
                        if (assertion.severity === 'critical') entry.criticalFailed += 1
                    }
                }
            }
        }
    }
    const mh = mean(hard)
    const ms = mean(soft)
    const correlation =
        hard.reduce((sum, h, i) => sum + (h - mh) * (soft[i] - ms), 0) /
        Math.sqrt(hard.reduce((sum, h) => sum + (h - mh) ** 2, 0) * soft.reduce((sum, s) => sum + (s - ms) ** 2, 0))
    summary.assertions = { cases, casesWithCriticalViolation: critical, byType, assertionScore: { mean: mh, std: std(hard) }, rubricScore: { mean: ms, std: std(soft) }, correlation }
}

/* ---------------- E2: search ---------------- */
for (const goal of goals) {
    const dir = join(RES, goal.id)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((name) => /^search-.*\.json$/.test(name))) {
        const s = read(join(dir, file))
        const base = s.trials[0]
        const selected = s.trials.find((trial) => trial.id === s.selectedTrialId) || null
        const candidates = s.trials.slice(1)
        summary.search.push({
            goal: goal.id,
            // rep >= 4 of v1 is the control run made in the same time window as v2
            strategy: s.strategy === 'evidence_guided' && s.rep >= 4 ? 'evidence_guided_control' : s.strategy,
            rep: s.rep,
            minutes: s.durationMs / 60000,
            proposed: candidates.length,
            rejected: candidates.filter((t) => t.status === 'rejected').length,
            improving: candidates.filter((t) => t.status === 'accepted').length,
            operators: candidates.map((t) => t.operator?.type),
            selected: selected?.id || null,
            selectedOperator: selected?.operator?.type || (selected?.id === 'baseline' ? 'baseline' : null),
            base: { devPass: base.summary?.passRate, devQuality: base.summary?.quality, testPass: base.testSummary?.passRate, tokens: base.summary?.averageTokens, cost: base.summary?.averageCost, latency: base.summary?.averageDurationMs / 1000 },
            best: selected && { devPass: selected.summary?.passRate, devQuality: selected.summary?.quality, testPass: selected.testSummary?.passRate, tokens: selected.summary?.averageTokens, cost: selected.summary?.averageCost, latency: selected.summary?.averageDurationMs / 1000 },
            bestDevPassAny: Math.max(...s.trials.filter((t) => t.summary).map((t) => t.summary.passRate)),
            // Effect of each applied operator relative to the crew it was applied to.
            steps: candidates.map((t) => {
                const parent = s.trials.find((p) => p.id === t.parentId)
                return {
                    operator: t.operator?.type,
                    rejected: t.status === 'rejected',
                    dPass: t.summary && parent?.summary ? t.summary.passRate - parent.summary.passRate : null,
                    dQuality: t.summary && parent?.summary ? t.summary.quality - parent.summary.quality : null,
                    dTokensPct: t.summary && parent?.summary?.averageTokens ? (t.summary.averageTokens / parent.summary.averageTokens - 1) * 100 : null
                }
            })
        })
    }
}

/*
 * Consistency of evidence-guided choices: for removal operators, does the
 * model's own rationale argue for keeping, binding or using the thing it
 * removes? Keyword-based and deliberately conservative; every flagged case is
 * listed in summary.json for manual inspection.
 */
{
    const CONTRADICTS = /\b(bind(ing)?|keep(ing)?|ensur(e|ing)|necessary|would not help|would worsen|worsen|preserve|give .* access|access to)\b/i
    const removal = new Set(['unbind_tool'])
    const picks = []
    const dropped = []
    for (const goal of goals) {
        const dir = join(RES, goal.id)
        if (!existsSync(dir)) continue
        for (const file of readdirSync(dir).filter((name) => /^search-evidence_guided(_v2)?-.*\.json$/.test(name))) {
            const run = read(join(dir, file))
            for (const trial of run.trials.slice(1)) {
                picks.push({ goal: goal.id, strategy: run.strategy, file, id: trial.id, operator: trial.operator?.type, rationale: trial.rationale || '' })
            }
            for (const round of run.rounds || []) dropped.push(...(round.inconsistentSelections || []).map((item) => ({ goal: goal.id, strategy: run.strategy, file, ...item })))
        }
    }
    const byOperator = {}
    for (const pick of picks) {
        const entry = (byOperator[`${pick.strategy}:${pick.operator}`] ||= { picks: 0, contradicting: 0 })
        entry.picks += 1
        if (removal.has(pick.operator) && CONTRADICTS.test(pick.rationale)) entry.contradicting += 1
    }
    summary.evidenceConsistency = {
        picks: picks.length,
        byOperator,
        droppedAsInconsistent: dropped,
        flagged: picks.filter((pick) => removal.has(pick.operator) && CONTRADICTS.test(pick.rationale))
    }
}

/* ---------------- E2b: confirmation of selected crews ---------------- */
summary.confirm = []
for (const goal of goals) {
    const dir = join(RES, goal.id)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((name) => /^confirm-.*\.json$/.test(name))) {
        const c = read(join(dir, file))
        const search = read(join(dir, c.source))
        const avg = (runs, field, key) => mean(runs.map((run) => run[field]?.[key]).filter(Number.isFinite))
        summary.confirm.push({
            goal: goal.id,
            strategy: c.strategy === 'evidence_guided' && c.rep >= 4 ? 'evidence_guided_control' : c.strategy,
            rep: c.rep,
            reportedDev: c.selected.searchSummary.passRate - search.trials[0].summary.passRate,
            reportedTest: Number.isFinite(c.selected.searchTestSummary?.passRate) && Number.isFinite(search.trials[0].testSummary?.passRate) ? c.selected.searchTestSummary.passRate - search.trials[0].testSummary.passRate : null,
            confirmedDev: avg(c.selected.runs, 'summary', 'passRate') - avg(c.baseline.runs, 'summary', 'passRate'),
            confirmedTest: avg(c.selected.runs, 'testSummary', 'passRate') - avg(c.baseline.runs, 'testSummary', 'passRate'),
            confirmedTokensPct: (avg(c.selected.runs, 'summary', 'averageTokens') / avg(c.baseline.runs, 'summary', 'averageTokens') - 1) * 100
        })
    }
}

/* ---------------- E3: parallel ---------------- */
if (existsSync(join(RES, 'parallel', 'parallel.json'))) {
    const p = read(join(RES, 'parallel', 'parallel.json'))
    const of = (variant, key) => p.runs.filter((run) => run.variant === variant && !run.error).map((run) => Number(run[key]))
    const serial = of('serial', 'durationMs').map((ms) => ms / 1000)
    const parallel = of('parallel', 'durationMs').map((ms) => ms / 1000)
    // Paired speed-up per (rep, question).
    const pairs = p.runs
        .filter((run) => run.variant === 'serial' && !run.error)
        .map((run) => [run, p.runs.find((other) => other.variant === 'parallel' && other.rep === run.rep && other.question === run.question && !other.error)])
        .filter(([, other]) => other)
        .map(([a, b]) => a.durationMs / b.durationMs)
    summary.parallel = {
        runs: p.runs.length,
        errors: p.runs.filter((run) => run.error).length,
        serial,
        parallel,
        speedup: pairs,
        serialTokens: of('serial', 'totalTokens'),
        parallelTokens: of('parallel', 'totalTokens')
    }
}

writeFileSync(join(RES, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(`E1 goals: ${summary.generation.length}, E2 searches: ${summary.search.length}, E3: ${summary.parallel ? 'yes' : 'no'}`)

/* ---------------- LaTeX tables ---------------- */
if (texDir) {
    mkdirSync(texDir, { recursive: true })
    const header = '% Generated by experiments/autopilot/summarize.mjs -- do not edit by hand.\n'

    const genRows = summary.generation
        .map((r) => `        ${esc(r.domain)} & ${r.tools} & ${r.fixtures} (${r.failureFixtures}) & ${r.dev}/${r.test} & ${r.assertions} & ${r.agents}/${r.tasks} & ${r.process} & ${r.warnings} \\\\`)
        .join('\n')
    writeFileSync(
        join(texDir, 'e1_generation.tex'),
        `${header}\\begin{tabular}{lrrrrrlr}\n    \\toprule\n    Domain & Tools & Fixtures (fail.) & Cases dev/test & Assert. & Agents/tasks & Process & Repairs \\\\\n    \\midrule\n${genRows}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const baseRows = summary.generation
        .filter((r) => r.baseline)
        .map((r) => {
            const b = r.baseline
            const runs = b.reps * (r.dev + r.test)
            return `        ${esc(r.domain)} & ${pm(b.devPass)} & ${pm(b.devQuality)} & ${pm(b.testPass)} & ${pm(b.tokens, 0)} & ${pm(b.cost.map((c) => c * 1000), 1)} & ${pm(b.latency, 1)} & ${pm(b.modelCalls, 1)} & ${b.failed.reduce((x, y) => x + y, 0)}/${runs} \\\\`
        })
        .join('\n')
    writeFileSync(
        join(texDir, 'e1_baseline.tex'),
        `${header}\\begin{tabular}{lcccccccc}\n    \\toprule\n    Domain & Dev pass & Dev quality & Test pass & Tokens & Cost [m\\$] & Latency [s] & Calls & Failures \\\\\n    \\midrule\n${baseRows}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    const a = summary.assertions
    const order = ['tool_called', 'tool_not_called', 'tool_succeeded', 'grounded', 'output_contains', 'output_not_contains', 'output_matches']
    const assertionRows = order
        .filter((type) => a.byType[type])
        .map((type) => {
            const entry = a.byType[type]
            return `        \\code{${esc(type)}} & ${entry.total} & ${entry.failed} & ${fmt((entry.failed / entry.total) * 100, 0)}\\,\\% & ${entry.criticalFailed} \\\\`
        })
        .join('\n')
    writeFileSync(
        join(texDir, 'e1_assertions.tex'),
        `${header}\\begin{tabular}{lrrrr}\n    \\toprule\n    Assertion type & Evaluated & Failed & Failure rate & Critical failures \\\\\n    \\midrule\n${assertionRows}\n    \\bottomrule\n\\end{tabular}%\n`
    )
    writeFileSync(
        join(texDir, 'e1_numbers.tex'),
        `${header}\\newcommand{\\EOneCases}{${a.cases}}%\n\\newcommand{\\EOneCritical}{${a.casesWithCriticalViolation}}%\n\\newcommand{\\EOneHard}{${fmt(a.assertionScore.mean, 1)}}%\n\\newcommand{\\EOneSoft}{${fmt(a.rubricScore.mean, 1)}}%\n\\newcommand{\\EOneCorr}{${fmt(a.correlation, 2)}}%\n`
    )

    const strategies = ['random', 'greedy', 'evidence_guided', 'evidence_guided_control', 'evidence_guided_v2']
    const label = {
        random: 'Random',
        greedy: 'Greedy',
        evidence_guided: 'Evidence-guided',
        evidence_guided_control: 'Evidence-guided (control)',
        evidence_guided_v2: 'Evidence-guided v2'
    }
    const searchRows = []
    for (const goal of [...new Set(summary.search.map((s) => s.goal))]) {
        for (const strategy of strategies) {
            const runs = summary.search.filter((s) => s.goal === goal && s.strategy === strategy)
            if (!runs.length) continue
            const delta = (key) => runs.filter((s) => s.best && Number.isFinite(s.best[key]) && Number.isFinite(s.base[key])).map((s) => s.best[key] - s.base[key])
            const rel = (key) => runs.filter((s) => s.best && s.base[key] > 0).map((s) => (s.best[key] / s.base[key] - 1) * 100)
            const changed = runs.filter((s) => s.selected && s.selected !== 'baseline').length
            const kept = runs.filter((s) => s.selected === 'baseline').length
            const none = runs.filter((s) => !s.selected).length
            const bestAny = runs.map((s) => s.bestDevPassAny - s.base.devPass)
            searchRows.push(
                `        ${esc(goal)} & ${label[strategy]} & ${runs.length} & ${fmt(mean(runs.map((s) => s.proposed)), 1)} & ${changed}/${kept}/${none} & ${pm(bestAny)} & ${pm(delta('devPass'))} & ${pm(delta('testPass'))} & ${pm(rel('tokens'), 0)} \\\\`
            )
        }
    }
    writeFileSync(
        join(texDir, 'e2_search.tex'),
        `${header}\\begin{tabular}{llrrccccc}\n    \\toprule\n    & & & & Selected & \\multicolumn{1}{c}{Best cand.} & \\multicolumn{3}{c}{Selected crew} \\\\\n    \\cmidrule(lr){6-6}\\cmidrule(lr){7-9}\n    Goal & Strategy & Runs & Cand. & new/base/none & $\\Delta$ dev pass & $\\Delta$ dev pass & $\\Delta$ test pass & $\\Delta$ tokens [\\%] \\\\\n    \\midrule\n${searchRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    // Pooled over goals, one row per strategy.
    const pooledRows = strategies
        .map((strategy) => {
            const runs = summary.search.filter((s) => s.strategy === strategy)
            if (!runs.length) return null
            const steps = runs.flatMap((s) => s.steps)
            const measured = steps.filter((step) => step.dPass !== null)
            const improvedAny = runs.filter((s) => s.bestDevPassAny > s.base.devPass).length
            const changed = runs.filter((s) => s.selected && s.selected !== 'baseline')
            return `        ${label[strategy]} & ${runs.length} & ${steps.length} & ${fmt((steps.filter((x) => x.rejected).length / steps.length) * 100, 0)}\\,\\% & ${fmt((measured.filter((x) => x.dPass > 0).length / measured.length) * 100, 0)}\\,\\% & ${improvedAny}/${runs.length} & ${pm(runs.map((s) => s.bestDevPassAny - s.base.devPass))} & ${changed.length}/${runs.length} \\\\`
        })
        .filter(Boolean)
    writeFileSync(
        join(texDir, 'e2_strategies.tex'),
        `${header}\\begin{tabular}{lrrrrrcr}\n    \\toprule\n    Strategy & Searches & Candidates & Rejected & Cand. better than parent & Search improved & $\\Delta$ best dev pass & New crew selected \\\\\n    \\midrule\n${pooledRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )

    // Per operator type, pooled over all searches.
    const opStats = {}
    for (const step of summary.search.flatMap((s) => s.steps.map((x) => ({ ...x, strategy: s.strategy })))) {
        const entry = (opStats[step.operator] ||= { n: 0, rejected: 0, dPass: [], dTokens: [], byStrategy: {} })
        entry.n += 1
        entry.byStrategy[step.strategy] = (entry.byStrategy[step.strategy] || 0) + 1
        if (step.rejected) entry.rejected += 1
        if (step.dPass !== null) entry.dPass.push(step.dPass)
        if (step.dTokensPct !== null) entry.dTokens.push(step.dTokensPct)
    }
    summary.operators = opStats
    const opRows = Object.entries(opStats)
        .sort((x, y) => y[1].n - x[1].n)
        .map(([op, e]) => `        \\code{${esc(op)}} & ${e.byStrategy.random || 0} & ${e.byStrategy.greedy || 0} & ${e.byStrategy.evidence_guided || 0} & ${e.rejected} & ${pm(e.dPass)} & ${fmt((e.dPass.filter((d) => d > 0).length / Math.max(1, e.dPass.length)) * 100, 0)}\\,\\% & ${pm(e.dTokens, 0)} \\\\`)
    writeFileSync(
        join(texDir, 'e2_operators.tex'),
        `${header}\\begin{tabular}{lrrrrcrc}\n    \\toprule\n    Operator & Random & Greedy & Evidence & Rejected & $\\Delta$ dev pass & Improved & $\\Delta$ tokens [\\%] \\\\\n    \\midrule\n${opRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
    )
    writeFileSync(join(RES, 'summary.json'), JSON.stringify(summary, null, 2))

    if (summary.confirm.length) {
        const confirmRows = strategies
            .map((strategy) => {
                const rows = summary.confirm.filter((row) => row.strategy === strategy)
                if (!rows.length) return null
                const pick = (key) => rows.map((row) => row[key]).filter((value) => Number.isFinite(value))
                return `        ${label[strategy]} & ${rows.length} & ${pm(pick('reportedDev'))} & ${pm(pick('confirmedDev'))} & ${pm(pick('reportedTest'))} & ${pm(pick('confirmedTest'))} & ${pm(pick('confirmedTokensPct'), 0)} \\\\`
            })
            .filter(Boolean)
        const all = (key) => summary.confirm.map((row) => row[key]).filter((value) => Number.isFinite(value))
        confirmRows.push(`        \\midrule\n        All & ${summary.confirm.length} & ${pm(all('reportedDev'))} & ${pm(all('confirmedDev'))} & ${pm(all('reportedTest'))} & ${pm(all('confirmedTest'))} & ${pm(all('confirmedTokensPct'), 0)} \\\\`)
        writeFileSync(
            join(texDir, 'e2b_confirm.tex'),
            `${header}\\begin{tabular}{lrccccc}\n    \\toprule\n    & & \\multicolumn{2}{c}{$\\Delta$ dev pass} & \\multicolumn{2}{c}{$\\Delta$ test pass} & \\\\\n    \\cmidrule(lr){3-4}\\cmidrule(lr){5-6}\n    Strategy & Crews & reported & re-measured & reported & re-measured & $\\Delta$ tokens [\\%] \\\\\n    \\midrule\n${confirmRows.join('\n')}\n    \\bottomrule\n\\end{tabular}%\n`
        )
    }

    if (summary.parallel) {
        const p = summary.parallel
        const sorted = [...p.speedup].sort((x, y) => x - y)
        const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        writeFileSync(
            join(texDir, 'e3_numbers.tex'),
            `${header}\\newcommand{\\EThreePairs}{${p.speedup.length}}%\n\\newcommand{\\EThreeFaster}{${p.speedup.filter((s) => s > 1).length}}%\n\\newcommand{\\EThreeMedian}{${fmt(median, 2)}}%\n\\newcommand{\\EThreeMin}{${fmt(sorted[0], 2)}}%\n\\newcommand{\\EThreeMax}{${fmt(sorted.at(-1), 1)}}%\n\\newcommand{\\EThreeSerial}{${fmt(mean(p.serial), 1)}}%\n\\newcommand{\\EThreeParallel}{${fmt(mean(p.parallel), 1)}}%\n`
        )
        writeFileSync(
            join(texDir, 'e3_parallel.tex'),
            `${header}\\begin{tabular}{lccc}\n    \\toprule\n    Executor & Latency [s] & Tokens & Runs \\\\\n    \\midrule\n        Serial (concurrency 1) & ${pm(p.serial, 1)} & ${pm(p.serialTokens, 0)} & ${p.serial.length} \\\\\n        Parallel (concurrency 4) & ${pm(p.parallel, 1)} & ${pm(p.parallelTokens, 0)} & ${p.parallel.length} \\\\\n    \\midrule\n        Paired speed-up & \\multicolumn{3}{l}{${pm(p.speedup, 2)}} \\\\\n    \\bottomrule\n\\end{tabular}%\n`
        )
    }
    console.log(`LaTeX tables written to ${texDir}`)
}
