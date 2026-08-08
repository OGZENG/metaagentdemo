import { useEffect, useMemo } from 'react'
import PropTypes from 'prop-types'
import { Alert, Box, Card, CardContent, Chip, CircularProgress, Divider, Drawer, Grid, IconButton, Stack, Typography } from '@mui/material'
import { IconAlertCircle, IconCheck, IconClock, IconCoins, IconX } from '@tabler/icons-react'

import executionsApi from '@/api/executions'
import useApi from '@/hooks/useApi'

const numberValue = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null && item !== '')
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

const formatNumber = (value) => new Intl.NumberFormat().format(Math.round(value || 0))
const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`
const formatDuration = (value) => (value < 1000 ? `${Math.round(value || 0)} ms` : `${(value / 1000).toFixed(1)} s`)

const statusColor = (status) => {
    if (status === 'FINISHED') return 'success'
    if (status === 'ERROR' || status === 'TERMINATED' || status === 'TIMEOUT') return 'error'
    if (status === 'STOPPED') return 'warning'
    return 'default'
}

const ExecutionAnalyticsDrawer = ({ executionId, open, onClose }) => {
    const executionApi = useApi(executionsApi.getExecutionById)

    useEffect(() => {
        if (open && executionId) executionApi.request(executionId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [executionId, open])

    const execution = executionApi.data
    const nodes = useMemo(() => {
        if (!execution?.executionData) return []
        try {
            const parsed = typeof execution.executionData === 'string' ? JSON.parse(execution.executionData) : execution.executionData
            if (!Array.isArray(parsed)) return []
            const callCounts = {}
            const callTotals = parsed.reduce((counts, node, index) => {
                const name = node.nodeLabel || node.nodeId || `Node ${index + 1}`
                counts[name] = (counts[name] || 0) + 1
                return counts
            }, {})
            return parsed.map((node, index) => {
                const output = node?.data?.output || {}
                const usage = output.usageMetadata || output.usage_metadata || {}
                const inputTokens = numberValue(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
                const outputTokens = numberValue(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
                const name = node.nodeLabel || node.nodeId || `Node ${index + 1}`
                callCounts[name] = (callCounts[name] || 0) + 1
                return {
                    id: `${node.nodeId}-${index}`,
                    name,
                    callNumber: callCounts[name],
                    callTotal: callTotals[name],
                    status: node.status || execution.state,
                    inputTokens,
                    outputTokens,
                    totalTokens: numberValue(usage.total_tokens, usage.totalTokens, inputTokens + outputTokens),
                    cost: numberValue(usage.total_cost, usage.totalCost, usage.cost),
                    durationMs: numberValue(output.timeMetadata?.delta, output.time_metadata?.delta),
                    validationStatus: output.validation_status || output.validationStatus,
                    validationSummary: output.validation_summary || output.validationSummary,
                    revisionInstructions: output.revision_instructions || output.revisionInstructions,
                    error: node?.data?.error || output.error
                }
            })
        } catch (_) {
            return []
        }
    }, [execution])

    const totals = useMemo(
        () => ({
            tokens: nodes.reduce((sum, node) => sum + node.totalTokens, 0),
            cost: nodes.reduce((sum, node) => sum + node.cost, 0),
            nodeDuration: nodes.reduce((sum, node) => sum + node.durationMs, 0)
        }),
        [nodes]
    )
    const runDuration = execution ? Math.max(0, new Date(execution.updatedDate).getTime() - new Date(execution.createdDate).getTime()) : 0

    return (
        <Drawer anchor='right' open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 760 }, p: 3 } }}>
            <Stack direction='row' justifyContent='space-between' alignItems='flex-start'>
                <Box>
                    <Typography variant='h2'>Execution detail</Typography>
                    <Typography color='text.secondary' sx={{ mt: 0.5, wordBreak: 'break-all' }}>
                        {executionId}
                    </Typography>
                </Box>
                <IconButton onClick={onClose} aria-label='Close execution detail'>
                    <IconX />
                </IconButton>
            </Stack>
            <Divider sx={{ my: 2 }} />

            {executionApi.loading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                    <CircularProgress />
                </Box>
            )}
            {executionApi.error && <Alert severity='error'>{executionApi.error.message || 'Unable to load execution.'}</Alert>}
            {!executionApi.loading && execution && (
                <Stack spacing={3}>
                    <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Box>
                            <Typography variant='h3'>{execution.agentflow?.name || 'Agentflow execution'}</Typography>
                            <Typography color='text.secondary'>{new Date(execution.createdDate).toLocaleString()}</Typography>
                        </Box>
                        <Chip label={execution.state} color={statusColor(execution.state)} />
                    </Stack>

                    <Grid container spacing={2}>
                        {[
                            { label: 'Total tokens', value: formatNumber(totals.tokens), icon: IconCheck },
                            { label: 'Estimated cost', value: formatCost(totals.cost), icon: IconCoins },
                            { label: 'Run duration', value: formatDuration(runDuration), icon: IconClock },
                            { label: 'Measured nodes', value: nodes.length, icon: IconCheck }
                        ].map(({ label, value, icon: Icon }) => (
                            <Grid item xs={6} md={3} key={label}>
                                <Card variant='outlined'>
                                    <CardContent>
                                        <Stack direction='row' spacing={1} alignItems='center'>
                                            <Icon size={18} />
                                            <Typography color='text.secondary' variant='caption'>
                                                {label}
                                            </Typography>
                                        </Stack>
                                        <Typography variant='h4' sx={{ mt: 1 }}>
                                            {value}
                                        </Typography>
                                    </CardContent>
                                </Card>
                            </Grid>
                        ))}
                    </Grid>

                    <Box>
                        <Typography variant='h3' sx={{ mb: 2 }}>
                            Agent timeline
                        </Typography>
                        <Stack spacing={0}>
                            {nodes.map((node, index) => (
                                <Box key={node.id} sx={{ display: 'grid', gridTemplateColumns: '30px 1fr', gap: 1.5 }}>
                                    <Stack alignItems='center'>
                                        <Box
                                            sx={{
                                                width: 16,
                                                height: 16,
                                                borderRadius: '50%',
                                                bgcolor: node.status === 'ERROR' ? 'error.main' : 'success.main',
                                                mt: 0.5
                                            }}
                                        />
                                        {index < nodes.length - 1 && <Box sx={{ width: 2, minHeight: 105, flex: 1, bgcolor: 'divider' }} />}
                                    </Stack>
                                    <Card variant='outlined' sx={{ mb: 1.5 }}>
                                        <CardContent>
                                            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent='space-between' spacing={1}>
                                                <Box>
                                                    <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
                                                        <Typography variant='h4'>{node.name}</Typography>
                                                        {node.callTotal > 1 && (
                                                            <Chip size='small' variant='outlined' label={`Call ${node.callNumber}`} />
                                                        )}
                                                    </Stack>
                                                    <Chip
                                                        size='small'
                                                        label={node.status}
                                                        color={statusColor(node.status)}
                                                        sx={{ mt: 1 }}
                                                    />
                                                </Box>
                                                <Stack direction='row' spacing={2} flexWrap='wrap' justifyContent={{ sm: 'flex-end' }}>
                                                    <Typography variant='body2'>Input {formatNumber(node.inputTokens)}</Typography>
                                                    <Typography variant='body2'>Output {formatNumber(node.outputTokens)}</Typography>
                                                    <Typography variant='body2'>Total {formatNumber(node.totalTokens)}</Typography>
                                                    <Typography variant='body2' color='primary.main'>
                                                        {totals.tokens ? ((node.totalTokens / totals.tokens) * 100).toFixed(1) : '0.0'}% of
                                                        run
                                                    </Typography>
                                                    <Typography variant='body2'>{formatCost(node.cost)}</Typography>
                                                    <Typography variant='body2'>{formatDuration(node.durationMs)}</Typography>
                                                </Stack>
                                            </Stack>
                                            {node.validationStatus && (
                                                <Alert severity={node.validationStatus === 'PASS' ? 'success' : 'warning'} sx={{ mt: 2 }}>
                                                    <strong>Validator: {node.validationStatus}</strong>
                                                    {node.validationSummary ? ` — ${node.validationSummary}` : ''}
                                                    {node.revisionInstructions && (
                                                        <Box sx={{ mt: 1 }}>Revision: {node.revisionInstructions}</Box>
                                                    )}
                                                </Alert>
                                            )}
                                            {node.error && (
                                                <Alert icon={<IconAlertCircle />} severity='error' sx={{ mt: 2 }}>
                                                    {typeof node.error === 'string' ? node.error : JSON.stringify(node.error)}
                                                </Alert>
                                            )}
                                        </CardContent>
                                    </Card>
                                </Box>
                            ))}
                            {!nodes.length && <Alert severity='info'>This execution has no node data.</Alert>}
                        </Stack>
                    </Box>
                    <Typography variant='caption' color='text.secondary'>
                        Node processing time: {formatDuration(totals.nodeDuration)} · Session: {execution.sessionId}
                    </Typography>
                </Stack>
            )}
        </Drawer>
    )
}

ExecutionAnalyticsDrawer.propTypes = {
    executionId: PropTypes.string,
    open: PropTypes.bool.isRequired,
    onClose: PropTypes.func.isRequired
}

export default ExecutionAnalyticsDrawer
