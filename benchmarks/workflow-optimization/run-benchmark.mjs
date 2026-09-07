#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDataset, runWorkflow, saveReports } from './benchmark-lib.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const parseArgs = (argv) => {
    const args = {}
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (!argument.startsWith('--')) continue
        const [rawKey, inlineValue] = argument.slice(2).split('=', 2)
        const value = inlineValue ?? argv[index + 1]
        args[rawKey] = value
        if (inlineValue === undefined) index += 1
    }
    return args
}

const usage = () => {
    console.log(`Usage:
  node run-benchmark.mjs --baseline-id <uuid> --iterative-id <uuid> [options]

Options:
  --base-url <url>       Default: http://localhost:3000/api/v1
  --api-key <key>        Optional Flowise API key (or FLOWISE_API_KEY env)
  --dataset <path>       Default: math-mcq-20.json
  --output <dir>         Default: results/<timestamp>
  --repetitions <n>      Default: 1
  --timeout-ms <n>       Default: 300000
  --limit <n>            Run only the first n cases (useful for smoke tests)
`)
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (!args['baseline-id'] || !args['iterative-id']) {
        usage()
        process.exitCode = 1
        return
    }

    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const runId = `workflow-benchmark-${timestamp}`
    const datasetPath = path.resolve(args.dataset || path.join(scriptDir, 'math-mcq-20.json'))
    const outputDir = path.resolve(args.output || path.join(scriptDir, 'results', timestamp))
    const baseUrl = String(args['base-url'] || 'http://localhost:3000/api/v1').replace(/\/$/, '')
    const apiKey = args['api-key'] || process.env.FLOWISE_API_KEY || ''
    const repetitions = Number.parseInt(args.repetitions || '1', 10)
    const timeoutMs = Number.parseInt(args['timeout-ms'] || '300000', 10)
    const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined

    if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer.')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000.')

    let dataset = await loadDataset(datasetPath)
    if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.')
        dataset = dataset.slice(0, limit)
    }

    const workflowDefinitions = [
        { name: 'Baseline', flowId: args['baseline-id'] },
        { name: 'Iterative', flowId: args['iterative-id'] }
    ]
    const workflows = []

    console.log(`Running ${dataset.length} tasks × ${repetitions} repetition(s) for ${workflowDefinitions.length} workflows.`)
    for (const workflow of workflowDefinitions) {
        console.log(`\nStarting ${workflow.name} (${workflow.flowId})`)
        workflows.push(
            await runWorkflow({
                ...workflow,
                dataset,
                baseUrl,
                apiKey,
                runId,
                timeoutMs,
                repetitions,
                checkpointDir: outputDir,
                onProgress: ({ current, total, testCase, repetition }) =>
                    console.log(`[${current}/${total}] ${testCase.id} (${testCase.difficulty}, repetition ${repetition})`)
            })
        )
    }

    const report = { runId, datasetPath, baseUrl, repetitions, workflows }
    await saveReports({ outputDir, report })
    console.log(`\nBenchmark complete. Reports written to:\n${outputDir}`)
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
})
