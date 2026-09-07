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
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material'
import { IconChevronDown, IconPlus, IconTrash } from '@tabler/icons-react'

const emptyFixture = () => ({ match: [], result: [], error: '' })

const pairsToText = (pairs = []) => pairs.map((pair) => `${pair.key}=${pair.value}`).join('\n')

const textToPairs = (text = '') =>
    String(text)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const separator = line.indexOf('=')
            if (separator < 0) return { key: line, value: '' }
            return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
        })
        .filter((pair) => pair.key)

/**
 * The simulated world, in editable form.
 *
 * Fixtures are the ground truth an acceptance case is written against: a tool
 * answers the same way on every replay, which is what lets an assertion decide
 * pass or fail without a human in the loop.
 */
const ToolEnvironmentPanel = ({ tools, onChange, disabled }) => {
    const updateTool = (index, patch) => onChange(tools.map((tool, position) => (position === index ? { ...tool, ...patch } : tool)))

    const updateFixture = (toolIndex, fixtureIndex, patch) =>
        updateTool(toolIndex, {
            fixtures: tools[toolIndex].fixtures.map((fixture, position) => (position === fixtureIndex ? { ...fixture, ...patch } : fixture))
        })

    if (!tools.length) {
        return (
            <Alert severity='info'>
                This workflow declared no external systems, so the crew answers from reasoning alone. Every acceptance case will be judged
                on its reply only.
            </Alert>
        )
    }

    const emptyTools = tools.filter((tool) => !tool.fixtures.length)

    return (
        <Stack spacing={1.5}>
            <Alert severity='info'>
                Every tool is simulated and deterministic. A call matches by exact argument value first, then by containment, so a fixture
                keyed on <code>zx-500</code> also answers a search for &quot;ZX-500 wireless headset&quot;. Anything unmatched returns the
                fallback, and a fixture with an error message injects a tool failure.
            </Alert>
            {emptyTools.length > 0 && (
                <Alert severity='error'>
                    <Typography variant='subtitle2'>
                        {emptyTools.length} tool(s) have no fixtures and will answer every call with their fallback.
                    </Typography>
                    <Typography variant='caption'>
                        The crew will look broken when the environment is what is missing: {emptyTools.map((tool) => tool.name).join(', ')}.
                        Regenerate the environment or add fixtures below before compiling.
                    </Typography>
                </Alert>
            )}
            {tools.map((tool, toolIndex) => (
                <Accordion key={tool.name} disableGutters>
                    <AccordionSummary expandIcon={<IconChevronDown size={18} />}>
                        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                            <Typography variant='subtitle2'>{tool.name}</Typography>
                            <Chip size='small' variant='outlined' label={`${tool.params.length} params`} />
                            <Chip size='small' variant='outlined' label={`${tool.fixtures.length} fixtures`} />
                            {tool.fixtures.some((fixture) => fixture.error) && (
                                <Chip size='small' color='warning' variant='outlined' label='failure injected' />
                            )}
                        </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                        <Stack spacing={1.5}>
                            <TextField
                                fullWidth
                                multiline
                                minRows={2}
                                size='small'
                                label='Description shown to the agent'
                                value={tool.description}
                                disabled={disabled}
                                onChange={(event) => updateTool(toolIndex, { description: event.target.value })}
                            />
                            <Box>
                                <Typography variant='caption' color='text.secondary'>
                                    Parameters
                                </Typography>
                                <Table size='small'>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Name</TableCell>
                                            <TableCell>Type</TableCell>
                                            <TableCell>Description</TableCell>
                                            <TableCell>Required</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {tool.params.map((param) => (
                                            <TableRow key={param.name}>
                                                <TableCell>
                                                    <code>{param.name}</code>
                                                </TableCell>
                                                <TableCell>{param.type}</TableCell>
                                                <TableCell>{param.description}</TableCell>
                                                <TableCell>{param.required ? 'yes' : 'no'}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </Box>

                            <Stack direction='row' spacing={1} alignItems='center'>
                                <Typography variant='caption' color='text.secondary'>
                                    Fixtures — one `key=value` per line
                                </Typography>
                                <Button
                                    size='small'
                                    startIcon={<IconPlus size={14} />}
                                    disabled={disabled}
                                    onClick={() => updateTool(toolIndex, { fixtures: [...tool.fixtures, emptyFixture()] })}
                                >
                                    Add fixture
                                </Button>
                            </Stack>
                            {tool.fixtures.map((fixture, fixtureIndex) => (
                                <Stack
                                    key={`${tool.name}-fixture-${fixtureIndex}`}
                                    direction={{ xs: 'column', md: 'row' }}
                                    spacing={1}
                                    sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}
                                >
                                    <TextField
                                        fullWidth
                                        multiline
                                        minRows={2}
                                        size='small'
                                        label='Matches arguments'
                                        value={pairsToText(fixture.match)}
                                        disabled={disabled}
                                        onChange={(event) =>
                                            updateFixture(toolIndex, fixtureIndex, { match: textToPairs(event.target.value) })
                                        }
                                    />
                                    <TextField
                                        fullWidth
                                        multiline
                                        minRows={2}
                                        size='small'
                                        label='Returns data'
                                        value={pairsToText(fixture.result)}
                                        disabled={disabled || Boolean(fixture.error)}
                                        onChange={(event) =>
                                            updateFixture(toolIndex, fixtureIndex, { result: textToPairs(event.target.value) })
                                        }
                                    />
                                    <TextField
                                        fullWidth
                                        size='small'
                                        label='Or fails with'
                                        value={fixture.error}
                                        disabled={disabled}
                                        onChange={(event) => updateFixture(toolIndex, fixtureIndex, { error: event.target.value })}
                                    />
                                    <IconButton
                                        size='small'
                                        color='error'
                                        disabled={disabled}
                                        onClick={() =>
                                            updateTool(toolIndex, {
                                                fixtures: tool.fixtures.filter((_item, position) => position !== fixtureIndex)
                                            })
                                        }
                                    >
                                        <IconTrash size={16} />
                                    </IconButton>
                                </Stack>
                            ))}

                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                                <TextField
                                    select
                                    size='small'
                                    sx={{ minWidth: 160 }}
                                    label='Fallback status'
                                    SelectProps={{ native: true }}
                                    value={tool.fallbackStatus}
                                    disabled={disabled}
                                    onChange={(event) => updateTool(toolIndex, { fallbackStatus: event.target.value })}
                                >
                                    <option value='not_found'>not_found</option>
                                    <option value='error'>error</option>
                                </TextField>
                                <TextField
                                    fullWidth
                                    size='small'
                                    label='Fallback message'
                                    value={tool.fallbackMessage}
                                    disabled={disabled}
                                    onChange={(event) => updateTool(toolIndex, { fallbackMessage: event.target.value })}
                                />
                            </Stack>
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            ))}
        </Stack>
    )
}

ToolEnvironmentPanel.propTypes = {
    tools: PropTypes.array.isRequired,
    onChange: PropTypes.func.isRequired,
    disabled: PropTypes.bool
}

export default ToolEnvironmentPanel
