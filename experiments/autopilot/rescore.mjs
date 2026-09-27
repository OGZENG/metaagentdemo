#!/usr/bin/env node
/**
 * Re-scores the recorded baseline replies of the original experiment (E1) with
 * the validated test world and the revised evaluator (semantic phrase checks,
 * judging at temperature 0). The crews are not run again, so the difference to
 * the recorded scores is the effect of the evaluation alone.
 *
 *   node experiments/autopilot/rescore.mjs [--concurrency 4]
 *
 * Writes results-validated/<goal>/rescore-baseline.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, studio } from './lib/api.mjs'

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const index = process.argv.indexOf('--concurrency')
const concurrency = index > 0 ? Number(process.argv[index + 1]) : 4
const selectedChatModel = read(join(ROOT, 'model.json'))
const goals = read(join(ROOT, 'goals.json'))

for (const { id: goalId } of goals) {
    const out = join(ROOT, 'results-validated', goalId, 'rescore-baseline.json')
    if (existsSync(out)) continue
    const { design, goal } = read(join(ROOT, 'results-validated', goalId, 'design.json'))
    const baseline = read(join(ROOT, 'results', goalId, 'baseline.json'))
    const jobs = baseline.repetitions.flatMap((rep) =>
        [...rep.devResults, ...rep.testResults].filter((result) => !result.error).map((result) => ({ rep: rep.rep, result }))
    )
    const rescored = new Array(jobs.length)
    let cursor = 0
    const worker = async () => {
        for (;;) {
            const at = cursor
            cursor += 1
            if (at >= jobs.length) return
            const { rep, result } = jobs[at]
            const scenario = design.scenarios.find((item) => item.id === result.scenarioId)
            const evaluation = await studio('evaluate', {
                goal,
                scenario,
                output: result.output,
                toolCalls: result.toolCalls,
                successCriteria: design.successCriteria,
                constraints: design.constraints,
                acceptanceScoreThreshold: 70,
                selectedChatModel,
                semanticAssertions: true,
                judgeTemperature: 0
            })
            rescored[at] = {
                rep,
                scenarioId: result.scenarioId,
                split: result.split,
                original: { passed: result.evaluation.passed, score: result.evaluation.score, assertionScore: result.evaluation.assertionScore, softScore: result.evaluation.softScore, criticalViolation: result.evaluation.criticalViolation },
                evaluation
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    writeFileSync(out, JSON.stringify({ goalId, rescoredAt: new Date().toISOString(), cases: rescored }, null, 2))
    const passed = (key) => rescored.filter((item) => (key === 'original' ? item.original.passed : item.evaluation.passed)).length
    console.log(`${goalId}: ${rescored.length} replies, passed ${passed('original')} as recorded -> ${passed('new')} re-scored`)
}
