import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
    Alert,
    Box,
    Card,
    CardActionArea,
    CardContent,
    Chip,
    CircularProgress,
    Grid,
    MenuItem,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography,
    useTheme
} from '@mui/material'
import { Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { IconActivity, IconChartHistogram, IconClock, IconCoins, IconPlayerPlay, IconRobot } from '@tabler/icons-react'

import chatflowsApi from '@/api/chatflows'
import executionsApi from '@/api/executions'
import useApi from '@/hooks/useApi'
import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import ExecutionAnalyticsDrawer from './ExecutionAnalyticsDrawer'

const formatNumber = (value) => new Intl.NumberFormat().format(Math.round(value || 0))
const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`
const formatDuration = (value) => (value < 1000 ? `${Math.round(value || 0)} ms` : `${(value / 1000).toFixed(1)} s`)

const Analytics = () => {
    const theme = useTheme()
    const navigate = useNavigate()
    const { agentflowId } = useParams()
    const analyticsApi = useApi(executionsApi.getExecutionAnalytics)
    const agentflowsApi = useApi(chatflowsApi.getAllAgentflows)
    const [days, setDays] = useState(30)
    const [search, setSearch] = useState('')
    const [selectedExecutionId, setSelectedExecutionId] = useState(null)

    useEffect(() => {
        agentflowsApi.request('AGENTFLOW', { page: 1, limit: 1000 })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!agentflowId) return
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - days)
        analyticsApi.request({ agentflowId, startDate: startDate.toISOString(), limit: 1000 })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentflowId, days])

    const agentflows = agentflowsApi.data?.data || []
    const selectedAgentflow = agentflows.find((flow) => flow.id === agentflowId)
    const filteredAgentflows = agentflows.filter((flow) => {
        const query = search.trim().toLowerCase()
        if (!query) return true
        return (
            flow.name?.toLowerCase().includes(query) ||
            flow.category?.toLowerCase().includes(query) ||
            flow.id.toLowerCase().includes(query)
        )
    })
    const data = analyticsApi.data || { summary: {}, daily: [], nodes: [], runs: [], agents: [] }
    const summary = data.summary || {}
    const cards = [
        { label: 'Total Runs', value: formatNumber(summary.totalRuns), icon: IconPlayerPlay, color: '#0065BD' },
        { label: 'Total Tokens', value: formatNumber(summary.totalTokens), icon: IconChartHistogram, color: '#7B2CBF' },
        { label: 'Estimated Cost', value: formatCost(summary.estimatedCost), icon: IconCoins, color: '#D97706' },
        { label: 'Avg. Duration', value: formatDuration(summary.averageDurationMs), icon: IconClock, color: '#0891B2' },
        { label: 'Success Rate', value: `${Number(summary.successRate || 0).toFixed(1)}%`, icon: IconActivity, color: '#16A34A' },
        { label: 'Validation Pass Rate', value: `${Number(summary.firstPassRate || 0).toFixed(1)}%`, icon: IconActivity, color: '#0D9488' }
    ]

    if (!agentflowId) {
        return (
            <MainCard>
                <Stack spacing={3}>
                    <ViewHeader
                        title='Token Analytics'
                        description='Select an Agentflow to inspect its runs, agents, trends and node usage.'
                        search
                        searchPlaceholder='Search Agentflows'
                        onSearchChange={(event) => setSearch(event.target.value)}
                    />
                    {agentflowsApi.error && <Alert severity='error'>Unable to load Agentflows.</Alert>}
                    {agentflowsApi.loading ? (
                        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                            <CircularProgress />
                        </Box>
                    ) : (
                        <Grid container spacing={2}>
                            {filteredAgentflows.map((flow) => (
                                <Grid item xs={12} sm={6} lg={4} key={flow.id}>
                                    <Card variant='outlined' sx={{ height: '100%' }}>
                                        <CardActionArea onClick={() => navigate(`/analytics/${flow.id}`)} sx={{ height: '100%' }}>
                                            <CardContent
                                                sx={{
                                                    minHeight: 170,
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    justifyContent: 'space-between'
                                                }}
                                            >
                                                <Box>
                                                    <Typography variant='h3'>{flow.name || 'Untitled Agentflow'}</Typography>
                                                    {flow.category && (
                                                        <Typography color='text.secondary' sx={{ mt: 1 }}>
                                                            {flow.category}
                                                        </Typography>
                                                    )}
                                                </Box>
                                                <Stack direction='row' alignItems='center' spacing={1} color='primary.main'>
                                                    <IconRobot size={24} />
                                                    <Typography variant='body2'>View token analytics</Typography>
                                                </Stack>
                                            </CardContent>
                                        </CardActionArea>
                                    </Card>
                                </Grid>
                            ))}
                            {!filteredAgentflows.length && (
                                <Grid item xs={12}>
                                    <Alert severity='info'>No matching Agentflows found.</Alert>
                                </Grid>
                            )}
                        </Grid>
                    )}
                </Stack>
            </MainCard>
        )
    }

    return (
        <MainCard>
            <Stack spacing={3}>
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent='space-between' alignItems={{ sm: 'center' }} spacing={2}>
                    <ViewHeader
                        isBackButton
                        onBack={() => navigate('/analytics')}
                        title={selectedAgentflow?.name || data.runs?.[0]?.agentflowName || 'Agentflow Analytics'}
                        description='Token usage and execution metrics for this Agentflow only.'
                    />
                    <TextField
                        select
                        size='small'
                        label='Time range'
                        value={days}
                        onChange={(event) => setDays(Number(event.target.value))}
                        sx={{ minWidth: 150 }}
                    >
                        <MenuItem value={7}>Last 7 days</MenuItem>
                        <MenuItem value={30}>Last 30 days</MenuItem>
                        <MenuItem value={90}>Last 90 days</MenuItem>
                    </TextField>
                </Stack>

                {analyticsApi.error && <Alert severity='error'>{analyticsApi.error.message || 'Unable to load analytics.'}</Alert>}
                {analyticsApi.loading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                        <CircularProgress />
                    </Box>
                ) : (
                    <>
                        <Grid container spacing={2}>
                            {cards.map(({ label, value, icon: Icon, color }) => (
                                <Grid item xs={12} sm={6} md key={label}>
                                    <Card variant='outlined' sx={{ height: '100%' }}>
                                        <CardContent>
                                            <Stack direction='row' justifyContent='space-between' alignItems='center'>
                                                <Box>
                                                    <Typography color='text.secondary' variant='body2'>
                                                        {label}
                                                    </Typography>
                                                    <Typography variant='h3' sx={{ mt: 1 }}>
                                                        {value}
                                                    </Typography>
                                                </Box>
                                                <Box sx={{ p: 1.2, borderRadius: 2, color, bgcolor: `${color}18`, display: 'flex' }}>
                                                    <Icon size={26} />
                                                </Box>
                                            </Stack>
                                        </CardContent>
                                    </Card>
                                </Grid>
                            ))}
                        </Grid>

                        <Card variant='outlined'>
                            <CardContent sx={{ pb: 0 }}>
                                <Typography variant='h4'>Recent runs</Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                                    Click a run to inspect its Agent timeline, validation result and errors.
                                </Typography>
                            </CardContent>
                            <TableContainer>
                                <Table size='small'>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Time</TableCell>
                                            <TableCell>Run</TableCell>
                                            <TableCell align='right'>Tokens</TableCell>
                                            <TableCell align='right'>Cost</TableCell>
                                            <TableCell align='right'>Duration</TableCell>
                                            <TableCell>Status</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {(data.runs || []).slice(0, 50).map((run) => (
                                            <TableRow
                                                key={run.executionId}
                                                hover
                                                onClick={() => setSelectedExecutionId(run.executionId)}
                                                sx={{ cursor: 'pointer' }}
                                            >
                                                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                                    {new Date(run.createdDate).toLocaleString()}
                                                </TableCell>
                                                <TableCell>{run.executionId.slice(0, 8)}</TableCell>
                                                <TableCell align='right'>{formatNumber(run.totalTokens)}</TableCell>
                                                <TableCell align='right'>{formatCost(run.estimatedCost)}</TableCell>
                                                <TableCell align='right'>{formatDuration(run.durationMs)}</TableCell>
                                                <TableCell>
                                                    <Chip
                                                        size='small'
                                                        label={run.state}
                                                        color={
                                                            run.state === 'FINISHED'
                                                                ? 'success'
                                                                : run.state === 'ERROR'
                                                                ? 'error'
                                                                : run.state === 'STOPPED'
                                                                ? 'warning'
                                                                : 'default'
                                                        }
                                                    />
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                        {!data.runs?.length && (
                                            <TableRow>
                                                <TableCell colSpan={6} align='center' sx={{ py: 5, color: 'text.secondary' }}>
                                                    No executions in this time range.
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Card>

                        <Card variant='outlined'>
                            <CardContent sx={{ pb: 0 }}>
                                <Typography variant='h4'>Agent ranking</Typography>
                            </CardContent>
                            <TableContainer>
                                <Table size='small'>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Agent / Node</TableCell>
                                            <TableCell align='right'>Calls</TableCell>
                                            <TableCell align='right'>Tokens</TableCell>
                                            <TableCell align='right'>Cost</TableCell>
                                            <TableCell align='right'>Avg. Duration</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {(data.agents || []).slice(0, 20).map((row) => (
                                            <TableRow key={row.name}>
                                                <TableCell>{row.name}</TableCell>
                                                <TableCell align='right'>{row.calls}</TableCell>
                                                <TableCell align='right'>{formatNumber(row.totalTokens)}</TableCell>
                                                <TableCell align='right'>{formatCost(row.estimatedCost)}</TableCell>
                                                <TableCell align='right'>{formatDuration(row.averageDurationMs)}</TableCell>
                                            </TableRow>
                                        ))}
                                        {!data.agents?.length && (
                                            <TableRow>
                                                <TableCell colSpan={5} align='center' sx={{ py: 3, color: 'text.secondary' }}>
                                                    No usage data.
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Card>

                        <Card variant='outlined'>
                            <CardContent>
                                <Typography variant='h4' sx={{ mb: 2 }}>
                                    Usage trend
                                </Typography>
                                {data.daily?.length ? (
                                    <Box sx={{ width: '100%', height: 310 }}>
                                        <ResponsiveContainer>
                                            <AreaChart data={data.daily} margin={{ top: 10, right: 20, left: 5, bottom: 0 }}>
                                                <defs>
                                                    <linearGradient id='tokenColor' x1='0' y1='0' x2='0' y2='1'>
                                                        <stop offset='5%' stopColor='#0065BD' stopOpacity={0.35} />
                                                        <stop offset='95%' stopColor='#0065BD' stopOpacity={0} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray='3 3' stroke={theme.palette.divider} />
                                                <XAxis dataKey='date' tick={{ fontSize: 12 }} />
                                                <YAxis yAxisId='tokens' tick={{ fontSize: 12 }} />
                                                <YAxis
                                                    yAxisId='cost'
                                                    orientation='right'
                                                    tick={{ fontSize: 12 }}
                                                    tickFormatter={formatCost}
                                                />
                                                <Tooltip
                                                    formatter={(value, name) =>
                                                        name === 'Estimated cost' ? formatCost(value) : formatNumber(value)
                                                    }
                                                />
                                                <Legend />
                                                <Area
                                                    type='monotone'
                                                    yAxisId='tokens'
                                                    dataKey='totalTokens'
                                                    name='Tokens'
                                                    stroke='#0065BD'
                                                    fill='url(#tokenColor)'
                                                    strokeWidth={2}
                                                />
                                                <Line
                                                    type='monotone'
                                                    yAxisId='cost'
                                                    dataKey='estimatedCost'
                                                    name='Estimated cost'
                                                    stroke='#D97706'
                                                    strokeWidth={2}
                                                    dot={false}
                                                />
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    </Box>
                                ) : (
                                    <Typography color='text.secondary'>Run this Agentflow to populate the chart.</Typography>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}
            </Stack>
            <ExecutionAnalyticsDrawer
                executionId={selectedExecutionId}
                open={Boolean(selectedExecutionId)}
                onClose={() => setSelectedExecutionId(null)}
            />
        </MainCard>
    )
}

export default Analytics
