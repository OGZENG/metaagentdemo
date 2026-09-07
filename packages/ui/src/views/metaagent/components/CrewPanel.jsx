import PropTypes from 'prop-types'
import {
    Alert,
    Box,
    Chip,
    MenuItem,
    Select,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material'

const ROLE_COLOR = { router: 'warning', specialist: 'primary', orchestrator: 'info', validator: 'success' }

const linesToArray = (text = '') =>
    String(text)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

/**
 * CrewIR, the structure both the generator and the optimizer work on.
 *
 * The graph is compiled from this deterministically, so everything shown here
 * is the actual contract of the running workflow rather than a summary of it.
 */
const CrewPanel = ({ crew, tools, validation, onChange, disabled }) => {
    const toolNames = tools.map((tool) => tool.name)
    const updateAgent = (agentId, patch) =>
        onChange({ ...crew, agents: crew.agents.map((agent) => (agent.id === agentId ? { ...agent, ...patch } : agent)) })

    return (
        <Stack spacing={2}>
            <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                <Chip size='small' color='primary' label={`process: ${crew.process}`} />
                <Chip size='small' variant='outlined' label={`${crew.agents.length} agents`} />
                <Chip size='small' variant='outlined' label={`${crew.tasks.length} tasks`} />
                <Chip size='small' variant='outlined' label={`final: ${crew.finalTaskId}`} />
                <Chip
                    size='small'
                    variant='outlined'
                    label={`${crew.agents.reduce((sum, agent) => sum + agent.tools.length, 0)} tool bindings`}
                />
            </Stack>

            {validation?.warnings?.length > 0 && (
                <Alert severity='warning'>
                    <Typography variant='subtitle2'>Generator warnings:</Typography>
                    <ul style={{ margin: '4px 0 0 18px' }}>
                        {validation.warnings.map((warning) => (
                            <li key={warning}>
                                <Typography variant='caption'>{warning}</Typography>
                            </li>
                        ))}
                    </ul>
                </Alert>
            )}

            <Box>
                <Typography variant='subtitle2' sx={{ mb: 0.5 }}>
                    Agents
                </Typography>
                <Stack spacing={1}>
                    {crew.agents.map((agent) => (
                        <Stack key={agent.id} spacing={1} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
                            <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                                <Chip size='small' color={ROLE_COLOR[agent.role] || 'default'} label={agent.role} />
                                <Typography variant='subtitle2'>{agent.name}</Typography>
                                <Typography variant='caption' color='text.secondary'>
                                    <code>{agent.id}</code>
                                </Typography>
                                <Box sx={{ flexGrow: 1 }} />
                                <TextField
                                    select
                                    size='small'
                                    label='Model tier'
                                    sx={{ minWidth: 130 }}
                                    value={agent.modelTier}
                                    disabled={disabled}
                                    onChange={(event) => updateAgent(agent.id, { modelTier: event.target.value })}
                                >
                                    <MenuItem value='default'>default</MenuItem>
                                    <MenuItem value='cheap'>cheap</MenuItem>
                                </TextField>
                            </Stack>
                            <TextField
                                fullWidth
                                multiline
                                minRows={2}
                                size='small'
                                label='Goal'
                                value={agent.goal}
                                disabled={disabled}
                                onChange={(event) => updateAgent(agent.id, { goal: event.target.value })}
                            />
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                                <Box sx={{ minWidth: 240 }}>
                                    <Typography variant='caption' color='text.secondary'>
                                        Tools
                                    </Typography>
                                    <Select
                                        multiple
                                        fullWidth
                                        size='small'
                                        value={agent.tools}
                                        disabled={disabled || !toolNames.length}
                                        onChange={(event) => updateAgent(agent.id, { tools: event.target.value })}
                                        renderValue={(selected) =>
                                            selected.length ? selected.join(', ') : 'no tools — pure reasoning step'
                                        }
                                        displayEmpty
                                    >
                                        {toolNames.map((tool) => (
                                            <MenuItem key={tool} value={tool}>
                                                {tool}
                                            </MenuItem>
                                        ))}
                                    </Select>
                                </Box>
                                <TextField
                                    fullWidth
                                    multiline
                                    minRows={2}
                                    size='small'
                                    label='Guardrails (one per line)'
                                    value={agent.guardrails.join('\n')}
                                    disabled={disabled}
                                    onChange={(event) => updateAgent(agent.id, { guardrails: linesToArray(event.target.value) })}
                                />
                            </Stack>
                        </Stack>
                    ))}
                </Stack>
            </Box>

            <Box>
                <Typography variant='subtitle2' sx={{ mb: 0.5 }}>
                    Tasks
                </Typography>
                <Table size='small'>
                    <TableHead>
                        <TableRow>
                            <TableCell>Task</TableCell>
                            <TableCell>Agent</TableCell>
                            <TableCell>Depends on</TableCell>
                            <TableCell>Expected output</TableCell>
                            <TableCell>State key</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {crew.tasks.map((task) => (
                            <TableRow key={task.id} selected={task.id === crew.finalTaskId}>
                                <TableCell>
                                    <Typography variant='body2'>{task.name}</Typography>
                                    <Typography variant='caption' color='text.secondary'>
                                        <code>{task.id}</code>
                                    </Typography>
                                </TableCell>
                                <TableCell>{task.agentId}</TableCell>
                                <TableCell>{task.dependsOn.length ? task.dependsOn.join(', ') : '—'}</TableCell>
                                <TableCell>
                                    <Typography variant='caption'>{task.expectedOutput}</Typography>
                                </TableCell>
                                <TableCell>
                                    <code>{task.outputKey}</code>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Box>

            {crew.process === 'routed' && (
                <Box>
                    <Typography variant='subtitle2' sx={{ mb: 0.5 }}>
                        Routes from {crew.routerAgentId}
                    </Typography>
                    <Stack spacing={0.5}>
                        {crew.routes.map((route, index) => (
                            <Typography key={route.taskId} variant='caption'>
                                <strong>{index}</strong> → <code>{route.taskId}</code> when {route.when}
                            </Typography>
                        ))}
                    </Stack>
                </Box>
            )}
        </Stack>
    )
}

CrewPanel.propTypes = {
    crew: PropTypes.object.isRequired,
    tools: PropTypes.array.isRequired,
    validation: PropTypes.object,
    onChange: PropTypes.func.isRequired,
    disabled: PropTypes.bool
}

export default CrewPanel
