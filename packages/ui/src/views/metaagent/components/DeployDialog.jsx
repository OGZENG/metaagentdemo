import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    MenuItem,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import { IconRocket } from '@tabler/icons-react'

import deploymentsApi from '@/api/autopilotDeployments'
import toolsApi from '@/api/tools'
import { errorMessage } from '../studioRunner'
import { formatCost, formatNumber, formatPercent } from '../deployments/format'

const SIMULATED = ''

/**
 * Promotes one measured crew into a deployment people can chat with.
 *
 * Every declared tool is either kept simulated — answers come only from the
 * fixtures, which is honest for a demo — or bound to a real Flowise tool. The
 * crew itself is recompiled on the server with those bindings.
 */
const DeployDialog = ({ open, trial, session, selectedChatModel, cheapChatModel, onClose, onDeployed }) => {
    const design = session?.design
    const [name, setName] = useState('')
    const [bindings, setBindings] = useState({})
    const [tools, setTools] = useState([])
    const [loadingTools, setLoadingTools] = useState(false)
    const [deploying, setDeploying] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!open || !trial || !design) return
        setName(`${design.workflowName} · ${trial.id === 'baseline' ? 'baseline' : trial.operator?.type || trial.id}`)
        setBindings({})
        setError('')
        setLoadingTools(true)
        toolsApi
            .getAllTools()
            .then(({ data }) => {
                const rows = Array.isArray(data) ? data : data?.data || []
                // Simulated Autopilot rows are what "Simulated" already means.
                setTools(rows.filter((tool) => !String(tool.name || '').startsWith('autopilot__')))
            })
            .catch(() => setTools([]))
            .finally(() => setLoadingTools(false))
    }, [open, trial, design])

    const boundCount = useMemo(() => Object.values(bindings).filter(Boolean).length, [bindings])

    if (!trial || !design) return null

    const deploy = async () => {
        setDeploying(true)
        setError('')
        try {
            const { data } = await deploymentsApi.createDeployment({
                name: name.trim(),
                goal: session.goal,
                design,
                crew: trial.crew,
                selectedChatModel,
                cheapChatModel,
                toolBindings: bindings,
                metrics: trial.summary,
                heldOutMetrics: trial.testSummary,
                sourceTrialId: trial.id,
                note: trial.operatorDescription || ''
            })
            onDeployed(data)
        } catch (deployError) {
            setError(errorMessage(deployError))
        } finally {
            setDeploying(false)
        }
    }

    return (
        <Dialog open={open} onClose={deploying ? undefined : onClose} fullWidth maxWidth='sm'>
            <DialogTitle sx={{ fontSize: '1.1rem' }}>Deploy crew</DialogTitle>
            <DialogContent dividers>
                <Stack spacing={2}>
                    <TextField label='Deployment name' value={name} onChange={(event) => setName(event.target.value)} fullWidth />

                    <Box>
                        <Typography variant='subtitle2' sx={{ mb: 0.75 }}>
                            Measured before deployment
                        </Typography>
                        <Stack direction='row' spacing={0.75} flexWrap='wrap' useFlexGap>
                            <Chip size='small' label={`dev pass ${formatPercent(trial.summary?.passRate)}`} />
                            <Chip size='small' label={`quality ${formatPercent(trial.summary?.quality)}`} />
                            <Chip
                                size='small'
                                variant='outlined'
                                label={trial.testSummary ? `held-out ${formatPercent(trial.testSummary.passRate)}` : 'held-out not run'}
                            />
                            <Chip size='small' variant='outlined' label={`${formatNumber(trial.summary?.averageTokens)} tokens / case`} />
                            <Chip size='small' variant='outlined' label={`${formatCost(trial.summary?.averageCost)} / case`} />
                        </Stack>
                        <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: 0.5 }}>
                            These numbers become the expectation the playground monitor compares live usage against.
                        </Typography>
                    </Box>

                    {design.tools.length > 0 && (
                        <Box>
                            <Typography variant='subtitle2' sx={{ mb: 0.75 }}>
                                Tool environment
                            </Typography>
                            <Stack spacing={1.25}>
                                {design.tools.map((tool) => (
                                    <TextField
                                        key={tool.name}
                                        select
                                        size='small'
                                        fullWidth
                                        label={tool.label || tool.name}
                                        helperText={tool.description}
                                        value={bindings[tool.name] || SIMULATED}
                                        disabled={loadingTools}
                                        onChange={(event) => setBindings((current) => ({ ...current, [tool.name]: event.target.value }))}
                                    >
                                        <MenuItem value={SIMULATED}>Simulated ({tool.fixtures?.length || 0} fixtures)</MenuItem>
                                        {tools.map((option) => (
                                            <MenuItem key={option.id} value={option.id}>
                                                {option.name}
                                            </MenuItem>
                                        ))}
                                    </TextField>
                                ))}
                            </Stack>
                            {boundCount === 0 ? (
                                <Alert severity='info' sx={{ mt: 1.5 }}>
                                    Every tool stays simulated: the crew answers only from the fixtures it was tested against, and anything
                                    outside them comes back as “not found”. Bind a real tool to use live data.
                                </Alert>
                            ) : (
                                <Alert severity='warning' sx={{ mt: 1.5 }}>
                                    {boundCount} tool(s) will call real systems. A real tool must accept the same parameters as the
                                    simulated one, and improvement runs on this deployment will execute it too.
                                </Alert>
                            )}
                        </Box>
                    )}

                    {error && <Alert severity='error'>{error}</Alert>}
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: 3, py: 1.5 }}>
                <Button onClick={onClose} disabled={deploying}>
                    Cancel
                </Button>
                <Button
                    variant='contained'
                    startIcon={deploying ? <CircularProgress size={14} color='inherit' /> : <IconRocket size={16} />}
                    disabled={deploying || !name.trim() || !selectedChatModel?.name}
                    onClick={deploy}
                >
                    {deploying ? 'Deploying…' : 'Deploy and open playground'}
                </Button>
            </DialogActions>
        </Dialog>
    )
}

DeployDialog.propTypes = {
    open: PropTypes.bool,
    trial: PropTypes.object,
    session: PropTypes.object,
    selectedChatModel: PropTypes.object,
    cheapChatModel: PropTypes.object,
    onClose: PropTypes.func.isRequired,
    onDeployed: PropTypes.func.isRequired
}

export default DeployDialog
