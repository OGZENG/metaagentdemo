/**
 * Exports the system prompts of Workflow Autopilot verbatim from the source
 * files, one plain-text file per prompt, for the appendix of the thesis
 * (included there with \lstinputlisting).
 *
 *   node export-prompts.mjs --out <thesis>/AIRStudentThesis/prompts
 *
 * Prompts are the string arrays `const NAME = [ ... ].join(sep)` of the
 * services; the agent system prompt is assembled per node in crewIR.ts and is
 * exported as its template. Non-ASCII punctuation is transliterated so that
 * pdflatex can typeset the files; any other non-ASCII character aborts.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const services = path.join(here, '../../packages/server/src/services/agentflowv2-generator')
const outIndex = process.argv.indexOf('--out')
if (outIndex < 0 || !process.argv[outIndex + 1]) {
    console.error('usage: node export-prompts.mjs --out <dir>')
    process.exit(1)
}
const outDir = process.argv[outIndex + 1]

// The suffix invokeStudioModel appends to every system prompt (studioService.ts).
const JSON_SUFFIX = 'Return one JSON object only. Do not use Markdown. Follow every requested field name and type exactly.'

const readPrompt = (file, name) => {
    const source = fs.readFileSync(path.join(services, file), 'utf8')
    const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join\\(('[^']*')\\)`))
    if (!match) throw new Error(`${name} not found in ${file}`)
    const lines = vm.runInNewContext(`[${match[1]}]`)
    return lines.join(vm.runInNewContext(match[2]))
}

// SELECTION_PROMPT_V2 is SELECTION_PROMPT without its last line, plus four lines.
const readSelectionV2 = () => {
    const source = fs.readFileSync(path.join(services, 'studioService.ts'), 'utf8')
    const match = source.match(/const SELECTION_PROMPT_V2 = \[\s*\.\.\.SELECTION_PROMPT\.split\('\\n'\)\.slice\(0, -1\),([\s\S]*?)\]\.join\('\\n'\)/)
    if (!match) throw new Error('SELECTION_PROMPT_V2 not found')
    const base = readPrompt('studioService.ts', 'SELECTION_PROMPT').split('\n').slice(0, -1)
    return [...base, ...vm.runInNewContext(`[${match[1]}]`)].join('\n')
}

const AGENT_TEMPLATE = `# Role
You are <agent name> (<agent role>).

# Backstory
<agent backstory>

# Agent goal
<agent goal>

# Business objective
<goal text of the user>

# Success criteria
- <success criterion of the contract> (one line each)

# Constraints
- <constraint of the contract> (one line each)

# Your task: <task name>
<task description>

# Expected output
<task expectedOutput>

# Context you receive
- <outputKey of an upstream task>: <its expectedOutput> (one line each)

# Tools
Call these tools to obtain facts. Never state a looked-up fact you did not receive from a tool.
<name, description and parameters of each tool bound to the agent>
A tool result is JSON. \`ok:true\` means the data is authoritative. \`ok:false\` means the record does not exist or the service failed -- report that honestly instead of inventing a value.

# Guardrails
- <guardrail of the agent> (one line each)

# Execution protocol
The complete user request is already supplied in your message. Process it now. Never ask the user to resend, paste or repeat it.

# Final answer            (only for the task that produces the user-facing answer)
You produce the user-facing answer. Return the complete reply only -- no internal commentary, no PASS/FAIL labels, no instructions addressed to other agents.

# Handoff                 (for every other task)
Return a concise, concrete result for downstream tasks. Do not address the end user.`

// Checks that the template above still matches the code it documents.
const checkAgentTemplate = () => {
    const source = fs.readFileSync(path.join(services, 'crewIR.ts'), 'utf8')
    for (const phrase of [
        'Call these tools to obtain facts. Never state a looked-up fact you did not receive from a tool.',
        'The complete user request is already supplied in your message. Process it now. Never ask the user to resend, paste or repeat it.',
        'Return a concise, concrete result for downstream tasks. Do not address the end user.',
        'You have no tools. Work only from the request and the context above.'
    ]) {
        if (!source.includes(phrase)) throw new Error(`crewIR.ts no longer contains: ${phrase}`)
    }
}

const ASCII = [
    [/\u2014/g, '--'],
    [/\u2013/g, '-'],
    [/[\u2018\u2019]/g, "'"],
    [/[\u201c\u201d]/g, '"'],
    [/\u2192/g, '->'],
    [/\u00d7/g, 'x'],
    [/\u2265/g, '>='],
    [/\u2264/g, '<=']
]

const toAscii = (name, text) => {
    let result = text
    for (const [pattern, replacement] of ASCII) result = result.replace(pattern, replacement)
    const rest = result.match(/[^\x00-\x7f]/)
    if (rest) throw new Error(`${name}: unhandled character ${JSON.stringify(rest[0])}`)
    return result
}

const prompts = {
    contract: readPrompt('studioService.ts', 'CONTRACT_PROMPT'),
    fixtures: readPrompt('studioService.ts', 'FIXTURE_PROMPT'),
    scenarios: readPrompt('studioService.ts', 'SCENARIO_PROMPT'),
    crew: readPrompt('studioService.ts', 'CREW_PROMPT'),
    'test-world-review': readPrompt('testWorldValidator.ts', 'TEST_WORLD_REVIEW_PROMPT'),
    'environment-repair': readPrompt('testWorldValidator.ts', 'ENVIRONMENT_REPAIR_PROMPT'),
    rubric: readPrompt('studioService.ts', 'RUBRIC_PROMPT'),
    diagnosis: readPrompt('studioService.ts', 'DIAGNOSIS_PROMPT'),
    selection: readPrompt('studioService.ts', 'SELECTION_PROMPT'),
    'selection-v2': readSelectionV2(),
    'online-review': readPrompt('deploymentService.ts', 'ONLINE_REVIEW_PROMPT'),
    'json-suffix': JSON_SUFFIX,
    agent: AGENT_TEMPLATE
}
checkAgentTemplate()

fs.mkdirSync(outDir, { recursive: true })
for (const [name, text] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(outDir, `${name}.txt`), `${toAscii(name, text)}\n`)
    console.log(`${name}.txt  ${text.split('\n').length} lines`)
}
