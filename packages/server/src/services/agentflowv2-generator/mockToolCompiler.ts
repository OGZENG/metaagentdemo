import { createHash } from 'crypto'
import { keyValuesToObject, type ToolSpec } from './studioSchemas'

/**
 * Compiles a declarative tool specification into a Flowise Custom Tool.
 *
 * Autopilot runs against a fully simulated world: no credentials, no network,
 * and identical behaviour on every replay. The generated function is a pure
 * lookup over fixtures embedded in the code itself, so a tool answers the same
 * way regardless of which acceptance case is running. That is what makes
 * `requiredTools` objectively checkable instead of a judgement call.
 */

export type CompiledMockTool = {
    name: string
    description: string
    color: string
    schema: string
    func: string
    specHash: string
}

const TOOL_COLOR = '#6E6EFD'

const normalizeForMatch = (value: unknown) =>
    String(value === undefined || value === null ? '' : value)
        .trim()
        .toLocaleLowerCase()

export const buildToolSchema = (spec: ToolSpec) =>
    JSON.stringify(
        spec.params.map((param) => ({
            property: param.name,
            type: param.type,
            description: param.description,
            required: param.required
        })),
        null,
        2
    )

/**
 * The sandbox only defines `$paramName` for arguments the model actually sent,
 * and referencing an undeclared identifier throws. `typeof` is the only safe
 * way to read a possibly-absent argument.
 */
const readArgumentExpression = (name: string) => `typeof $${name} === 'undefined' ? undefined : $${name}`

export const buildToolFunc = (spec: ToolSpec) => {
    const fixtures = spec.fixtures.map((fixture) => ({
        match: keyValuesToObject(fixture.match),
        result: keyValuesToObject(fixture.result),
        error: fixture.error || ''
    }))
    const argumentEntries = spec.params.map((param) => `    ${JSON.stringify(param.name)}: ${readArgumentExpression(param.name)}`)

    return `/* Workflow Autopilot simulated tool: ${spec.name} */
const FIXTURES = ${JSON.stringify(fixtures, null, 4)}
const FALLBACK = ${JSON.stringify({ status: spec.fallbackStatus, message: spec.fallbackMessage }, null, 4)}

const args = {
${argumentEntries.join(',\n')}
}

const normalize = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase()

const PARAMS = ${JSON.stringify(spec.params.map((param) => param.name))}
const argValues = Object.keys(args).map((key) => normalize(args[key])).filter((value) => value !== '')

const keysOf = (fixture) => Object.keys(fixture.match || {})

// A fixture key is normally a parameter name. Models also write the value as
// the key — { "zx-500": "zx-500" } instead of { "sku": "zx-500" } — which used
// to make the fixture unreachable and the whole tool answer "not found" to
// everything. Treat an unrecognised key as "this value should appear in some
// argument".
const entryMatches = (fixture, key, loose) => {
    const wanted = normalize(fixture.match[key])
    if (wanted === '') return false
    if (PARAMS.indexOf(key) >= 0) {
        const actual = normalize(args[key])
        return loose ? actual.includes(wanted) : actual === wanted
    }
    return argValues.some((value) => (loose ? value.includes(wanted) : value === wanted))
}

const fixtureMatches = (fixture, loose) =>
    keysOf(fixture).length > 0 && keysOf(fixture).every((key) => entryMatches(fixture, key, loose))

// An identifier argument arrives verbatim, so exact equality wins outright.
const exact = FIXTURES.find((fixture) => fixtureMatches(fixture, false))

// A search argument does not: the agent sends free text such as
// "ZX-500 wireless headset multipoint" for a record keyed on "zx-500". Fall back
// to containment, and prefer the most specific fixture so a short key cannot
// hijack a longer one.
const specificity = (fixture) => keysOf(fixture).reduce((total, key) => total + normalize(fixture.match[key]).length, 0)
const contained = FIXTURES.filter((fixture) => fixtureMatches(fixture, true)).sort(
    (left, right) => specificity(right) - specificity(left)
)

// A fixture with no match keys answers everything. A successful one is the
// intended default for an action tool; an unconditional *failure* would make
// every unmatched call look like an outage, so it is only the last resort.
const catchAlls = FIXTURES.filter((fixture) => keysOf(fixture).length === 0)
const catchAll = catchAlls.find((fixture) => !fixture.error) || catchAlls[0]

const matched = exact || contained[0] || catchAll

if (!matched) {
    return JSON.stringify({ ok: false, status: FALLBACK.status, message: FALLBACK.message, args: args })
}

if (matched.error) {
    return JSON.stringify({ ok: false, status: 'error', message: matched.error, args: args })
}

return JSON.stringify({ ok: true, status: 'ok', data: matched.result, args: args })
`
}

export const compileMockTool = (spec: ToolSpec): CompiledMockTool => {
    const schema = buildToolSchema(spec)
    const func = buildToolFunc(spec)
    return {
        name: spec.name,
        description: spec.description,
        color: TOOL_COLOR,
        schema,
        func,
        specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
    }
}

export const compileMockTools = (specs: ToolSpec[] = []) => specs.map(compileMockTool)

/**
 * Human-readable environment summary injected into agent prompts so a role
 * knows what it may look up rather than guessing from the tool schema alone.
 */
export const describeToolEnvironment = (specs: ToolSpec[] = []) => {
    if (!specs.length) return 'No simulated tools are available; answer from the request and upstream evidence only.'
    return specs
        .map((spec) => {
            const params = spec.params.map((param) => `${param.name}: ${param.type}${param.required ? '' : ' (optional)'}`).join(', ')
            return `- ${spec.name}(${params}) — ${spec.description}`
        })
        .join('\n')
}

export const validateToolCoverage = (specs: ToolSpec[] = [], requiredToolNames: string[] = []) => {
    const available = new Set(specs.map((spec) => spec.name))
    return [...new Set(requiredToolNames)].filter((name) => !available.has(name))
}

export { normalizeForMatch }
