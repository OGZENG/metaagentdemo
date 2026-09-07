import PropTypes from 'prop-types'
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Box,
    Button,
    Chip,
    IconButton,
    MenuItem,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import { IconChevronDown, IconPlus, IconTrash } from '@tabler/icons-react'

const ASSERTION_TYPES = [
    { id: 'tool_called', label: 'tool_called', hint: 'The named tool must be invoked, optionally with these arguments.' },
    { id: 'tool_not_called', label: 'tool_not_called', hint: 'The named tool must never be invoked.' },
    { id: 'tool_succeeded', label: 'tool_succeeded', hint: 'The named tool must return ok:true at least once.' },
    { id: 'output_contains', label: 'output_contains', hint: 'The reply must contain at least one of these phrases.' },
    { id: 'output_not_contains', label: 'output_not_contains', hint: 'The reply must contain none of these phrases.' },
    { id: 'output_matches', label: 'output_matches', hint: 'The reply must match this regular expression.' },
    { id: 'grounded', label: 'grounded', hint: 'If the tool never succeeded, none of these phrases may appear.' }
]

const linesToArray = (text = '') =>
    String(text)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

const pairsToText = (pairs = []) => pairs.map((pair) => `${pair.key}=${pair.value}`).join('\n')

const textToPairs = (text = '') =>
    linesToArray(text).map((line) => {
        const separator = line.indexOf('=')
        if (separator < 0) return { key: line, value: '' }
        return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
    })

const newAssertion = (index) => ({
    id: `assert_${index + 1}`,
    type: 'output_contains',
    severity: 'major',
    description: 'Describe what this checks',
    tool: '',
    withArgs: [],
    anyOf: [],
    pattern: '',
    forbidden: []
})

const severityColor = { critical: 'error', major: 'warning', minor: 'default' }

const AssertionEditor = ({ assertion, tools, disabled, onChange, onDelete }) => {
    const meta = ASSERTION_TYPES.find((item) => item.id === assertion.type)
    const usesTool = ['tool_called', 'tool_not_called', 'tool_succeeded', 'grounded'].includes(assertion.type)
    const usesPhrases = ['output_contains', 'output_not_contains'].includes(assertion.type)

    return (
        <Stack spacing={1} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
                <TextField
                    select
                    size='small'
                    label='Type'
                    sx={{ minWidth: 190 }}
                    value={assertion.type}
                    disabled={disabled}
                    onChange={(event) => onChange({ type: event.target.value })}
                >
                    {ASSERTION_TYPES.map((item) => (
                        <MenuItem key={item.id} value={item.id}>
                            {item.label}
                        </MenuItem>
                    ))}
                </TextField>
                <TextField
                    select
                    size='small'
                    label='Severity'
                    sx={{ minWidth: 130 }}
                    value={assertion.severity}
                    disabled={disabled}
                    onChange={(event) => onChange({ severity: event.target.value })}
                >
                    {['critical', 'major', 'minor'].map((item) => (
                        <MenuItem key={item} value={item}>
                            {item}
                        </MenuItem>
                    ))}
                </TextField>
                <TextField
                    fullWidth
                    size='small'
                    label='Description'
                    value={assertion.description}
                    disabled={disabled}
                    onChange={(event) => onChange({ description: event.target.value })}
                />
                <IconButton size='small' color='error' disabled={disabled} onClick={onDelete}>
                    <IconTrash size={16} />
                </IconButton>
            </Stack>
            <Typography variant='caption' color='text.secondary'>
                {meta?.hint}
            </Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                {usesTool && (
                    <TextField
                        select
                        size='small'
                        label='Tool'
                        sx={{ minWidth: 200 }}
                        value={assertion.tool || ''}
                        disabled={disabled}
                        onChange={(event) => onChange({ tool: event.target.value })}
                    >
                        {tools.map((tool) => (
                            <MenuItem key={tool} value={tool}>
                                {tool}
                            </MenuItem>
                        ))}
                    </TextField>
                )}
                {assertion.type === 'tool_called' && (
                    <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        size='small'
                        label='Required arguments (key=value per line)'
                        value={pairsToText(assertion.withArgs)}
                        disabled={disabled}
                        onChange={(event) => onChange({ withArgs: textToPairs(event.target.value) })}
                    />
                )}
                {usesPhrases && (
                    <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        size='small'
                        label='Phrases (one per line)'
                        value={(assertion.anyOf || []).join('\n')}
                        disabled={disabled}
                        onChange={(event) => onChange({ anyOf: linesToArray(event.target.value) })}
                    />
                )}
                {assertion.type === 'output_matches' && (
                    <TextField
                        fullWidth
                        size='small'
                        label='Regular expression'
                        value={assertion.pattern || ''}
                        disabled={disabled}
                        onChange={(event) => onChange({ pattern: event.target.value })}
                    />
                )}
                {assertion.type === 'grounded' && (
                    <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        size='small'
                        label='Phrases that require a successful tool result'
                        value={(assertion.forbidden || []).join('\n')}
                        disabled={disabled}
                        onChange={(event) => onChange({ forbidden: linesToArray(event.target.value) })}
                    />
                )}
            </Stack>
        </Stack>
    )
}

AssertionEditor.propTypes = {
    assertion: PropTypes.object.isRequired,
    tools: PropTypes.array.isRequired,
    disabled: PropTypes.bool,
    onChange: PropTypes.func.isRequired,
    onDelete: PropTypes.func.isRequired
}

/**
 * The acceptance suite.
 *
 * `expectedBehavior` explains a case to a human; the assertions decide whether
 * it passed. The dev/test split is what keeps the reported result honest: the
 * optimizer only ever sees dev cases.
 */
const ScenarioPanel = ({ scenarios, tools, onChange, disabled }) => {
    const toolNames = tools.map((tool) => tool.name)
    const devCount = scenarios.filter((scenario) => scenario.split !== 'test').length
    const testCount = scenarios.length - devCount

    const updateScenario = (index, patch) =>
        onChange(scenarios.map((scenario, position) => (position === index ? { ...scenario, ...patch } : scenario)))

    const addScenario = () =>
        onChange([
            ...scenarios,
            {
                id: `case_${scenarios.length + 1}_${Date.now().toString(36)}`,
                title: 'New acceptance case',
                category: 'custom',
                split: 'dev',
                input: '',
                expectedBehavior: ['Describe the behaviour a human reviewer expects.'],
                requiredTools: [],
                mustNot: [],
                assertions: []
            }
        ])

    return (
        <Stack spacing={1.5}>
            <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                <Chip size='small' color='primary' variant='outlined' label={`${devCount} dev cases drive the search`} />
                <Chip size='small' color='secondary' variant='outlined' label={`${testCount} held-out test cases`} />
                <Box sx={{ flexGrow: 1 }} />
                <Button size='small' startIcon={<IconPlus size={14} />} disabled={disabled} onClick={addScenario}>
                    Add case
                </Button>
            </Stack>
            {!testCount && (
                <Alert severity='warning'>
                    Every case is in the dev split, so the reported score is the one the optimizer was allowed to tune against. Mark some
                    cases as held-out test cases before quoting a result.
                </Alert>
            )}
            {scenarios.map((scenario, index) => (
                <Accordion key={scenario.id} disableGutters>
                    <AccordionSummary expandIcon={<IconChevronDown size={18} />}>
                        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                            <Chip
                                size='small'
                                color={scenario.split === 'test' ? 'secondary' : 'primary'}
                                variant='outlined'
                                label={scenario.split === 'test' ? 'test' : 'dev'}
                            />
                            <Typography variant='subtitle2'>{scenario.title}</Typography>
                            <Chip size='small' variant='outlined' label={scenario.category} />
                            {(scenario.assertions || []).length ? (
                                <Chip
                                    size='small'
                                    variant='outlined'
                                    color={
                                        severityColor[
                                            (scenario.assertions || []).some((item) => item.severity === 'critical') ? 'critical' : 'major'
                                        ]
                                    }
                                    label={`${scenario.assertions.length} assertions`}
                                />
                            ) : (
                                <Chip size='small' color='warning' variant='outlined' label='judged by rubric only' />
                            )}
                        </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                        <Stack spacing={1.5}>
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                                <TextField
                                    fullWidth
                                    size='small'
                                    label='Title'
                                    value={scenario.title}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { title: event.target.value })}
                                />
                                <TextField
                                    size='small'
                                    label='Category'
                                    sx={{ minWidth: 180 }}
                                    value={scenario.category}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { category: event.target.value })}
                                />
                                <TextField
                                    select
                                    size='small'
                                    label='Split'
                                    sx={{ minWidth: 140 }}
                                    value={scenario.split || 'dev'}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { split: event.target.value })}
                                >
                                    <MenuItem value='dev'>dev</MenuItem>
                                    <MenuItem value='test'>test (held out)</MenuItem>
                                </TextField>
                                <IconButton
                                    size='small'
                                    color='error'
                                    disabled={disabled}
                                    onClick={() => onChange(scenarios.filter((_item, position) => position !== index))}
                                >
                                    <IconTrash size={16} />
                                </IconButton>
                            </Stack>
                            <TextField
                                fullWidth
                                multiline
                                minRows={3}
                                size='small'
                                label='Input the workflow receives'
                                value={scenario.input}
                                disabled={disabled}
                                onChange={(event) => updateScenario(index, { input: event.target.value })}
                            />
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                                <TextField
                                    fullWidth
                                    multiline
                                    minRows={2}
                                    size='small'
                                    label='Expected behaviour (one per line)'
                                    value={(scenario.expectedBehavior || []).join('\n')}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { expectedBehavior: linesToArray(event.target.value) })}
                                />
                                <TextField
                                    fullWidth
                                    multiline
                                    minRows={2}
                                    size='small'
                                    label='Must not (one per line)'
                                    value={(scenario.mustNot || []).join('\n')}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { mustNot: linesToArray(event.target.value) })}
                                />
                                <TextField
                                    fullWidth
                                    multiline
                                    minRows={2}
                                    size='small'
                                    label='Required tools (one per line)'
                                    value={(scenario.requiredTools || []).join('\n')}
                                    disabled={disabled}
                                    onChange={(event) => updateScenario(index, { requiredTools: linesToArray(event.target.value) })}
                                />
                            </Stack>

                            <Stack direction='row' spacing={1} alignItems='center'>
                                <Typography variant='subtitle2'>Machine assertions</Typography>
                                <Button
                                    size='small'
                                    startIcon={<IconPlus size={14} />}
                                    disabled={disabled}
                                    onClick={() =>
                                        updateScenario(index, {
                                            assertions: [...(scenario.assertions || []), newAssertion((scenario.assertions || []).length)]
                                        })
                                    }
                                >
                                    Add assertion
                                </Button>
                            </Stack>
                            {(scenario.assertions || []).map((assertion, assertionIndex) => (
                                <AssertionEditor
                                    key={assertion.id || assertionIndex}
                                    assertion={assertion}
                                    tools={toolNames}
                                    disabled={disabled}
                                    onChange={(patch) =>
                                        updateScenario(index, {
                                            assertions: scenario.assertions.map((item, position) =>
                                                position === assertionIndex ? { ...item, ...patch } : item
                                            )
                                        })
                                    }
                                    onDelete={() =>
                                        updateScenario(index, {
                                            assertions: scenario.assertions.filter((_item, position) => position !== assertionIndex)
                                        })
                                    }
                                />
                            ))}
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            ))}
        </Stack>
    )
}

ScenarioPanel.propTypes = {
    scenarios: PropTypes.array.isRequired,
    tools: PropTypes.array.isRequired,
    onChange: PropTypes.func.isRequired,
    disabled: PropTypes.bool
}

export default ScenarioPanel
