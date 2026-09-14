import { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material'
import { IconHistory } from '@tabler/icons-react'

import deploymentsApi from '@/api/autopilotDeployments'
import useConfirm from '@/hooks/useConfirm'
import { errorMessage } from '../studioRunner'
import { formatCost, formatDate, formatDuration, formatNumber, formatPercent } from './format'

const MetricChips = ({ label, metrics }) =>
    metrics ? (
        <Stack direction='row' spacing={0.5} alignItems='center' flexWrap='wrap' useFlexGap>
            <Typography variant='caption' color='text.secondary' sx={{ minWidth: 64 }}>
                {label}
            </Typography>
            <Chip size='small' variant='outlined' label={`pass ${formatPercent(metrics.passRate)}`} />
            <Chip size='small' variant='outlined' label={`quality ${formatPercent(metrics.quality)}`} />
            <Chip size='small' variant='outlined' label={`${formatNumber(metrics.averageTokens)} tokens`} />
            <Chip size='small' variant='outlined' label={formatCost(metrics.averageCost)} />
            <Chip size='small' variant='outlined' label={formatDuration(metrics.averageDurationMs)} />
        </Stack>
    ) : null

MetricChips.propTypes = { label: PropTypes.string, metrics: PropTypes.object }

/**
 * Every published crew, the evidence it was published on, and a way back. A
 * rollback recompiles the stored CrewIR, so an old version comes back exactly
 * as it was measured.
 */
const VersionsPanel = ({ deployment, onChange }) => {
    const { confirm } = useConfirm()
    const [busyVersion, setBusyVersion] = useState(null)
    const [error, setError] = useState('')
    const versions = [...deployment.versions].sort((left, right) => right.version - left.version)

    const rollback = async (version) => {
        const confirmed = await confirm({
            title: `Roll back to version ${version.version}`,
            description:
                `Recompile version ${version.version} and make it live? The AgentFlow is updated in place, so the chat and API ` +
                'endpoint stay the same. No version is deleted; you can switch back again.',
            confirmButtonName: 'Roll back',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        setBusyVersion(version.version)
        setError('')
        try {
            const { data } = await deploymentsApi.rollbackDeployment(deployment.id, version.version)
            onChange(data)
        } catch (rollbackError) {
            setError(errorMessage(rollbackError))
        } finally {
            setBusyVersion(null)
        }
    }

    return (
        <Stack spacing={1.25}>
            {error && (
                <Alert severity='error' onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            {versions.map((version) => {
                const live = version.version === deployment.currentVersion
                const crew = version.crew || {}
                return (
                    <Box
                        key={version.version}
                        sx={{ border: 1, borderColor: live ? 'primary.main' : 'divider', borderRadius: 1.5, p: 1.25 }}
                    >
                        <Stack direction='row' spacing={0.75} alignItems='center' flexWrap='wrap' useFlexGap>
                            <Typography variant='subtitle2'>Version {version.version}</Typography>
                            {live && <Chip size='small' color='primary' label='live' />}
                            <Typography variant='caption' color='text.secondary'>
                                {formatDate(version.createdAt)}
                            </Typography>
                            <Box sx={{ flexGrow: 1 }} />
                            {!live && (
                                <Button
                                    size='small'
                                    startIcon={<IconHistory size={14} />}
                                    disabled={busyVersion !== null}
                                    onClick={() => rollback(version)}
                                >
                                    {busyVersion === version.version ? 'Rolling back…' : 'Roll back'}
                                </Button>
                            )}
                        </Stack>
                        <Typography variant='caption' display='block' color='text.secondary' sx={{ mt: 0.25 }}>
                            {(crew.agents || []).length} agent(s) · {(crew.tasks || []).length} task(s) · {crew.process}
                        </Typography>
                        {version.note && (
                            <Typography variant='caption' display='block' sx={{ mt: 0.25 }}>
                                {version.note}
                            </Typography>
                        )}
                        {version.operatorDescriptions.map((description) => (
                            <Typography key={description} variant='caption' display='block'>
                                <strong>Change:</strong> {description}
                            </Typography>
                        ))}
                        {version.incorporatedCaseIds.length > 0 && (
                            <Typography variant='caption' display='block' color='text.secondary'>
                                Incorporated {version.incorporatedCaseIds.length} case(s) from real conversations.
                            </Typography>
                        )}
                        <Stack spacing={0.5} sx={{ mt: 0.75 }}>
                            <MetricChips label='Suite' metrics={version.metrics} />
                            <MetricChips label='Online' metrics={version.onlineMetrics} />
                            <MetricChips label='Held-out' metrics={version.heldOutMetrics} />
                        </Stack>
                    </Box>
                )
            })}
        </Stack>
    )
}

VersionsPanel.propTypes = {
    deployment: PropTypes.object.isRequired,
    onChange: PropTypes.func.isRequired
}

export default VersionsPanel
