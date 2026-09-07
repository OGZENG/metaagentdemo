#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { rescoreReport, saveReports } from './benchmark-lib.mjs'

const reportPath = process.argv[2]
if (!reportPath) {
    console.error('Usage: node rescore-report.mjs <path-to-benchmark-results.json>')
    process.exitCode = 1
} else {
    const absolutePath = path.resolve(reportPath)
    const report = rescoreReport(JSON.parse(await readFile(absolutePath, 'utf8')))
    await saveReports({ outputDir: path.dirname(absolutePath), report })
    console.log(`Rescored report: ${absolutePath}`)
}
