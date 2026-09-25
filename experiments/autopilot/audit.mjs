#!/usr/bin/env node
/**
 * Finds result files contaminated by machine suspension: any case whose
 * recorded wall-clock duration exceeds twice the execution timeout cannot be a
 * genuine crew timeout. With --delete, such files are removed so that the
 * resumable run scripts repeat them.
 *
 *   node experiments/autopilot/audit.mjs [--delete]
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { EXECUTION_TIMEOUT, ROOT } from './lib/api.mjs'

const RES = join(ROOT, 'results')
const remove = process.argv.includes('--delete')
const LIMIT = 2 * EXECUTION_TIMEOUT

const casesOf = (data) => {
    const out = []
    const add = (results) => (results || []).forEach((result) => out.push(result))
    for (const rep of data.repetitions || []) add(rep.devResults), add(rep.testResults)
    for (const trial of data.trials || []) add(trial.devResults), add(trial.testResults)
    for (const part of [data.selected, data.baseline]) for (const run of part?.runs || []) add(run.devResults), add(run.testResults)
    return out
}

let flagged = 0
for (const goal of readdirSync(RES).filter((name) => existsSync(join(RES, name, 'design.json')))) {
    for (const file of readdirSync(join(RES, goal)).filter((name) => /^(baseline|search-|confirm-).*\.json$/.test(name))) {
        const path = join(RES, goal, file)
        const bad = casesOf(JSON.parse(readFileSync(path, 'utf8'))).filter((result) => Number(result.durationMs) > LIMIT)
        if (!bad.length) continue
        flagged += 1
        console.log(`${goal}/${file}: ${bad.length} case(s) over ${LIMIT / 60000} min${remove ? ' -> deleted' : ''}`)
        if (remove) unlinkSync(path)
    }
}
console.log(flagged ? `${flagged} contaminated file(s)` : 'no contaminated files')
