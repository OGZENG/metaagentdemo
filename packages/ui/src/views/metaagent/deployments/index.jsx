import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    IconButton,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tooltip,
    Typography
} from '@mui/material'
import { IconMessageChatbot, IconSparkles, IconTrash } from '@tabler/icons-react'

import deploymentsApi from '@/api/autopilotDeployments'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import useConfirm from '@/hooks/useConfirm'
import { errorMessage } from '../studioRunner'
import { TOOL_MODE_LABELS, formatDate, formatPercent } from './format'

const AutopilotDeployments = () => {
    const navigate = useNavigate()
    const { confirm } = useConfirm()
    const [deployments, setDeployments] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')

    const load = async () => {
        setLoading(true)
        try {
            const { data } = await deploymentsApi.listDeployments()
            setDeployments(Array.isArray(data) ? data : [])
            setError('')
        } catch (loadError) {
            setError(errorMessage(loadError))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        load()
    }, [])

    const remove = async (deployment) => {
        const confirmed = await confirm({
            title: 'Delete deployment',
            description:
                `Delete "${deployment.name}" and its AgentFlow? Every published version, collected case and improvement run ` +
                'is removed. Executions already recorded stay in Token Analytics.',
            confirmButtonName: 'Delete',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        try {
            await deploymentsApi.deleteDeployment(deployment.id, true)
            await load()
        } catch (deleteError) {
            setError(errorMessage(deleteError))
        }
    }

    return (
        <MainCard>
            <ViewHeader
                title='Deployed Crews'
                description='Chat with crews promoted from Workflow Autopilot, monitor them and improve them.'
            >
                <Button variant='outlined' startIcon={<IconSparkles size={16} />} onClick={() => navigate('/meta-agent')}>
                    Workflow Autopilot
                </Button>
            </ViewHeader>

            {error && (
                <Alert severity='error' sx={{ mt: 2 }}>
                    {error}
                </Alert>
            )}

            {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                    <CircularProgress />
                </Box>
            ) : !deployments.length ? (
                <Alert severity='info' sx={{ mt: 2 }}>
                    Nothing is deployed yet. Run an experiment in Workflow Autopilot, then press <strong>Deploy</strong> on a crew in the
                    Results step.
                </Alert>
            ) : (
                <TableContainer sx={{ mt: 2 }}>
                    <Table size='small'>
                        <TableHead>
                            <TableRow>
                                <TableCell>Deployment</TableCell>
                                <TableCell>Version</TableCell>
                                <TableCell>Tools</TableCell>
                                <TableCell align='right'>Measured pass</TableCell>
                                <TableCell align='right'>Open cases</TableCell>
                                <TableCell>Updated</TableCell>
                                <TableCell />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {deployments.map((deployment) => (
                                <TableRow key={deployment.id} hover>
                                    <TableCell>
                                        <Typography variant='subtitle2'>{deployment.name}</Typography>
                                        <Typography variant='caption' color='text.secondary'>
                                            {deployment.error || deployment.workflowName}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        {deployment.currentVersion ? (
                                            <Chip size='small' label={`v${deployment.currentVersion} of ${deployment.versionCount}`} />
                                        ) : (
                                            '—'
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {deployment.toolMode && (
                                            <Chip
                                                size='small'
                                                variant='outlined'
                                                color={deployment.toolMode === 'simulated' ? 'default' : 'warning'}
                                                label={TOOL_MODE_LABELS[deployment.toolMode]}
                                            />
                                        )}
                                    </TableCell>
                                    <TableCell align='right'>
                                        {deployment.metrics ? formatPercent(deployment.metrics.passRate) : '—'}
                                    </TableCell>
                                    <TableCell align='right'>
                                        {deployment.pendingCases || deployment.acceptedCases ? (
                                            <Stack direction='row' spacing={0.5} justifyContent='flex-end'>
                                                {deployment.pendingCases > 0 && (
                                                    <Chip size='small' color='warning' label={`${deployment.pendingCases} pending`} />
                                                )}
                                                {deployment.acceptedCases > 0 && (
                                                    <Chip size='small' color='info' label={`${deployment.acceptedCases} accepted`} />
                                                )}
                                            </Stack>
                                        ) : (
                                            '—'
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant='caption'>{formatDate(deployment.updatedDate)}</Typography>
                                    </TableCell>
                                    <TableCell align='right' sx={{ whiteSpace: 'nowrap' }}>
                                        <Button
                                            size='small'
                                            variant='contained'
                                            startIcon={<IconMessageChatbot size={14} />}
                                            onClick={() => navigate(`/meta-agent/deployments/${deployment.id}`)}
                                        >
                                            Open
                                        </Button>
                                        <Tooltip title='Delete deployment'>
                                            <IconButton size='small' color='error' onClick={() => remove(deployment)} sx={{ ml: 0.5 }}>
                                                <IconTrash size={16} />
                                            </IconButton>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <ConfirmDialog />
        </MainCard>
    )
}

export default AutopilotDeployments
