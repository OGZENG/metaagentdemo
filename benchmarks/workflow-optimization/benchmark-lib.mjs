import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const numberValue = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '')
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

export const extractAnswer = (text = '') => {
    const candidates = [
        /final\s+answer\s*:[\s\S]{0,80}?["']answer["']\s*:\s*["'](?:option\s*)?([A-D])\b/i,
        /final\s+answer\s*:\s*(?:option\s*)?([A-D])\b/i,
        /consensus[_\s-]*answer["']?\s*[:=]\s*["']?(?:option\s*)?([A-D])\b/i,
        /(?:answer|option|choice)\s*(?:is|:|=)\s*(?:option\s*)?([A-D])\b/i,
        /^\s*([A-D])(?:[.)]|\s)/im
    ]

    for (const pattern of candidates) {
        const match = String(text).match(pattern)
        if (match) return match[1].toUpperCase()
    }
    return null
}

export const summarizeExecution = (prediction, wallClockMs) => {
    const executionData = Array.isArray(prediction?.agentFlowExecutedData) ? prediction.agentFlowExecutedData : []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let estimatedCost = 0
    let measuredNodeDurationMs = 0
    let modelCalls = 0
    let validationVerdict = null
    let revisionNodeCalls = 0
    const nodeCallCounts = {}

    for (const node of executionData) {
        const label = node?.nodeLabel || node?.nodeId || 'Unknown'
        nodeCallCounts[label] = (nodeCallCounts[label] || 0) + 1
        const output = node?.data?.output || {}
        const usage = output.usageMetadata || output.usage_metadata

        if (usage) {
            const nodeInputTokens = numberValue(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
            const nodeOutputTokens = numberValue(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
            inputTokens += nodeInputTokens
            outputTokens += nodeOutputTokens
            totalTokens += numberValue(usage.total_tokens, usage.totalTokens, nodeInputTokens + nodeOutputTokens)
            estimatedCost += numberValue(usage.total_cost, usage.totalCost, usage.cost)
            modelCalls += 1
        }

        measuredNodeDurationMs += numberValue(output.timeMetadata?.delta, output.time_metadata?.delta)
        const verdict = output.verdict || output.validationStatus || output.validation_status
        if (verdict) validationVerdict = String(verdict).toLowerCase()
        if (/revise\s+and\s+re-?run|revision/i.test(label)) revisionNodeCalls += 1
    }

    const consensusCalls = Object.entries(nodeCallCounts)
        .filter(([label]) => /consensus\s+aggregator/i.test(label))
        .reduce((sum, [, count]) => sum + count, 0)
    const revisionRounds = Math.max(revisionNodeCalls, Math.max(0, consensusCalls - 1))

    return {
        executionId: prediction?.executionId || null,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
        durationMs: wallClockMs,
        measuredNodeDurationMs,
        modelCalls,
        validationVerdict,
        validationPassed: validationVerdict === 'pass',
        revisionRounds,
        nodeCallCounts
    }
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

export const aggregateResults = (results) => {
    const successful = results.filter((result) => !result.error)
    const scored = successful.filter((result) => result.predictedAnswer !== null)
    const correct = scored.filter((result) => result.correct).length
    const validationResults = successful.filter((result) => result.validationVerdict !== null)

    return {
        requestedRuns: results.length,
        completedRuns: successful.length,
        failedRuns: results.length - successful.length,
        scoredRuns: scored.length,
        answerExtractionRate: successful.length ? scored.length / successful.length : 0,
        accuracy: successful.length ? correct / successful.length : 0,
        conditionalAccuracy: scored.length ? correct / scored.length : 0,
        validationPassRate: validationResults.length
            ? validationResults.filter((result) => result.validationPassed).length / validationResults.length
            : null,
        revisionRate: successful.length ? successful.filter((result) => result.revisionRounds > 0).length / successful.length : 0,
        averageRevisionRounds: mean(successful.map((result) => result.revisionRounds)),
        averageInputTokens: mean(successful.map((result) => result.inputTokens)),
        averageOutputTokens: mean(successful.map((result) => result.outputTokens)),
        averageTotalTokens: mean(successful.map((result) => result.totalTokens)),
        totalTokens: successful.reduce((sum, result) => sum + result.totalTokens, 0),
        averageCost: mean(successful.map((result) => result.estimatedCost)),
        totalCost: successful.reduce((sum, result) => sum + result.estimatedCost, 0),
        averageDurationMs: mean(successful.map((result) => result.durationMs)),
        averageModelCalls: mean(successful.map((result) => result.modelCalls)),
        qualityPer1kTokens:
            successful.reduce((sum, result) => sum + result.totalTokens, 0) > 0
                ? (correct / successful.reduce((sum, result) => sum + result.totalTokens, 0)) * 1000
                : 0
    }
}

const requestPrediction = async ({ baseUrl, apiKey, flowId, question, sessionId, timeoutMs }) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    try {
        const response = await fetch(`${baseUrl}/prediction/${flowId}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                question,
                streaming: false,
                chatId: sessionId,
                overrideConfig: { sessionId }
            }),
            signal: controller.signal
        })
        const body = await response.text()
        if (!response.ok) throw new Error(`Prediction API returned ${response.status}: ${body.slice(0, 500)}`)
        return JSON.parse(body)
    } finally {
        clearTimeout(timeout)
    }
}

export const runWorkflow = async ({
    name,
    flowId,
    dataset,
    baseUrl,
    apiKey,
    runId,
    timeoutMs,
    repetitions = 1,
    checkpointDir,
    onProgress
}) => {
    const results = []
    const total = dataset.length * repetitions
    let current = 0
    if (checkpointDir) await mkdir(checkpointDir, { recursive: true })

    const saveCheckpoint = async () => {
        if (!checkpointDir) return
        const checkpoint = { name, flowId, summary: aggregateResults(results), results }
        await writeFile(path.join(checkpointDir, `${name.toLowerCase()}-checkpoint.json`), `${JSON.stringify(checkpoint, null, 2)}\n`)
    }

    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const testCase of dataset) {
            current += 1
            const sessionId = `${runId}-${name}-${testCase.id}-r${repetition}`.replace(/[^a-zA-Z0-9_-]/g, '-')
            onProgress?.({ current, total, name, testCase, repetition })
            const startedAt = Date.now()

            try {
                const prediction = await requestPrediction({
                    baseUrl,
                    apiKey,
                    flowId,
                    question: testCase.question,
                    sessionId,
                    timeoutMs
                })
                const wallClockMs = Date.now() - startedAt
                const predictedAnswer = extractAnswer(prediction?.text)
                results.push({
                    workflow: name,
                    flowId,
                    taskId: testCase.id,
                    difficulty: testCase.difficulty,
                    repetition,
                    sessionId,
                    predictedAnswer,
                    referenceAnswer: testCase.referenceAnswer,
                    correct: predictedAnswer === testCase.referenceAnswer,
                    answerText: prediction?.text || '',
                    ...summarizeExecution(prediction, wallClockMs)
                })
            } catch (error) {
                results.push({
                    workflow: name,
                    flowId,
                    taskId: testCase.id,
                    difficulty: testCase.difficulty,
                    repetition,
                    sessionId,
                    predictedAnswer: null,
                    referenceAnswer: testCase.referenceAnswer,
                    correct: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
            await saveCheckpoint()
        }
    }

    return { name, flowId, summary: aggregateResults(results), results }
}

const csvEscape = (value) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const resultsToCsv = (workflows) => {
    const columns = [
        'workflow',
        'flowId',
        'taskId',
        'difficulty',
        'repetition',
        'executionId',
        'predictedAnswer',
        'referenceAnswer',
        'correct',
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'estimatedCost',
        'durationMs',
        'modelCalls',
        'validationVerdict',
        'revisionRounds',
        'error'
    ]
    const rows = workflows.flatMap((workflow) => workflow.results)
    return [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))].join('\n')
}

const percent = (value) => (value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`)
const fixed = (value, digits = 2) => Number(value || 0).toFixed(digits)

export const buildMarkdownReport = ({ runId, datasetPath, workflows }) => {
    const lines = [
        '# Workflow Optimization Benchmark',
        '',
        `- Run ID: \`${runId}\``,
        `- Dataset: \`${datasetPath}\``,
        `- Generated: ${new Date().toISOString()}`,
        '',
        '| Workflow | Accuracy | Conditional Accuracy | Extraction | Avg Tokens | Avg Cost | Avg Latency | Avg Calls | Revision Rate |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
    ]

    for (const workflow of workflows) {
        const summary = workflow.summary
        lines.push(
            `| ${workflow.name} | ${percent(summary.accuracy)} | ${percent(summary.conditionalAccuracy)} | ${percent(
                summary.answerExtractionRate
            )} | ${fixed(
                summary.averageTotalTokens,
                0
            )} | $${fixed(summary.averageCost, 4)} | ${fixed(summary.averageDurationMs / 1000, 2)} s | ${fixed(
                summary.averageModelCalls,
                1
            )} | ${percent(summary.revisionRate)} |`
        )
    }

    if (workflows.length === 2) {
        const [first, second] = workflows.map((workflow) => workflow.summary)
        lines.push(
            '',
            '## Difference (second minus first)',
            '',
            `- Accuracy: ${((second.accuracy - first.accuracy) * 100).toFixed(1)} percentage points`,
            `- Average tokens: ${fixed(second.averageTotalTokens - first.averageTotalTokens, 0)}`,
            `- Average cost: $${fixed(second.averageCost - first.averageCost, 4)}`,
            `- Average latency: ${fixed((second.averageDurationMs - first.averageDurationMs) / 1000, 2)} seconds`,
            `- Average model calls: ${fixed(second.averageModelCalls - first.averageModelCalls, 1)}`
        )
    }

    lines.push(
        '',
        '## Scoring notes',
        '',
        '- Accuracy is strict: an answer extraction failure counts as incorrect.',
        '- Conditional Accuracy is calculated only over responses where an answer option was extracted.',
        '- Failed API calls are reported separately and are never counted as correct.',
        '- Every task and repetition uses an isolated chat/session ID.',
        ''
    )
    return lines.join('\n')
}

export const rescoreReport = (report) => {
    for (const workflow of report.workflows || []) {
        for (const result of workflow.results || []) {
            if (result.error) continue
            result.predictedAnswer = extractAnswer(result.answerText)
            result.correct = result.predictedAnswer === result.referenceAnswer
        }
        workflow.summary = aggregateResults(workflow.results || [])
    }
    return report
}

export const loadDataset = async (datasetPath) => {
    const dataset = JSON.parse(await readFile(datasetPath, 'utf8'))
    if (!Array.isArray(dataset) || dataset.length === 0) throw new Error('Dataset must be a non-empty JSON array.')
    const ids = new Set()
    for (const testCase of dataset) {
        if (!testCase.id || !testCase.question || !/^[A-D]$/.test(testCase.referenceAnswer)) {
            throw new Error(`Invalid dataset entry: ${JSON.stringify(testCase)}`)
        }
        if (ids.has(testCase.id)) throw new Error(`Duplicate task ID: ${testCase.id}`)
        ids.add(testCase.id)
    }
    return dataset
}

export const saveReports = async ({ outputDir, report }) => {
    await mkdir(outputDir, { recursive: true })
    await writeFile(path.join(outputDir, 'benchmark-results.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(outputDir, 'benchmark-results.csv'), `${resultsToCsv(report.workflows)}\n`)
    await writeFile(path.join(outputDir, 'benchmark-summary.md'), `${buildMarkdownReport(report)}\n`)
}
