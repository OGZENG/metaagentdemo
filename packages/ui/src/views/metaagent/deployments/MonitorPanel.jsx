import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { Link } from 'react-router-dom'
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    FormControlLabel,
    Stack,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Typography
} from '@mui/material'
import { IconSparkles, IconThumbDown } from '@tabler/icons-react'

import executionsApi from '@/api/executions'
import { LAB_DRIFT_RATIO, compareToLab, summarizeTurns } from '../studioUtils'
import { formatCost, formatDuration, formatNumber, formatPercent, formatRatio } from './format'

const Section = ({ title, action, children }) => (
    <Box>
        <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1 }} spacing={1}>
            <Typography variant='subtitle1'>{title}</Typography>
            {action}
        </Stack>
        {children}
    </Box>
)

Section.propTypes = { title: PropTypes.node, action: PropTypes.node, children: PropTypes.node }

const Stat = ({ label, value, hint }) => (
    <Box sx={{ flex: '1 1 100px', minWidth: 100, border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.25, py: 0.75 }}>
        <Typography variant='caption' color='text.secondary' display='block'>
            {label}
        </Typography>
        <Typography variant='h5'>{value}</Typography>
        {hint && (
            <Typography variant='caption' color='text.secondary'>
                {hint}
            </Typography>
        )}
    </Box>
)

Stat.propTypes = { label: PropTypes.node, value: PropTypes.node, hint: PropTypes.node }

const formatMetric = (key, value) => {
    if (key === 'averageCost') return formatCost(value)
    if (key === 'averageDurationMs') return formatDuration(value)
    return formatNumber(value, key === 'averageModelCalls' ? 1 : 0)
}

const VERDICT_CHIP = {
    ok: { color: 'success', label: 'review: ok' },
    improvable: { color: 'warning', label: 'review: improvable' }
}

/**
 * The crew's own telemetry while it is being used: the latest reply broken down
 * per agent, this session against the numbers the crew was deployed at, and
 * every reply with a way to flag it or have the reviewer model look at it.
 */
const MonitorPanel = ({ deployment, turns, chatId, loading, reviews, reviewing, autoReview, onAutoReviewChange, onReview, onFlag }) => {
    const [sessionAnalytics, setSessionAnalytics] = useState(null)
    const [flowAnalytics, setFlowAnalytics] = useState(null)

    const completedTurns = turns.filter((turn) => turn.complete)
    const lastTurn = completedTurns[completedTurns.length - 1]
    const liveVersion = deployment.versions.find((item) => item.version === deployment.currentVersion)
    const lab = liveVersion?.metrics || liveVersion?.heldOutMetrics

    useEffect(() => {
        let cancelled = false
        const since = new Date()
        since.setDate(since.getDate() - 30)
        Promise.all([
            executionsApi.getExecutionAnalytics({ agentflowId: deployment.flowId, startDate: since.toISOString(), limit: 1000 }),
            chatId ? executionsApi.getExecutionAnalytics({ agentflowId: deployment.flowId, sessionId: chatId, limit: 500 }) : null
        ])
            .then(([flow, session]) => {
                if (cancelled) return
                setFlowAnalytics(flow?.data || null)
                setSessionAnalytics(session?.data || null)
            })
            // Telemetry is advisory; the chat keeps working without it.
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [deployment.flowId, deployment.currentVersion, chatId, completedTurns.length])

    const live = useMemo(
        () => ({ ...summarizeTurns(turns), averageDurationMs: Number(sessionAnalytics?.summary?.averageDurationMs || 0) }),
        [turns, sessionAnalytics]
    )
    const comparison = compareToLab(live, lab)
    const drift = comparison.filter((row) => row.drift)
    const flowSummary = flowAnalytics?.summary

    return (
        <Stack spacing={2.5}>
            <Section title='Latest reply'>
                {lastTurn ? (
                    <>
                        <Stack direction='row' gap={1} flexWrap='wrap'>
                            <Stat
                                label='Tokens'
                                value={formatNumber(lastTurn.usage.totalTokens)}
                                hint={`${formatNumber(lastTurn.usage.inputTokens)} in · ${formatNumber(lastTurn.usage.outputTokens)} out`}
                            />
                            <Stat label='Cost' value={formatCost(lastTurn.usage.estimatedCost)} />
                            <Stat label='Model calls' value={lastTurn.usage.modelCalls} hint={`${lastTurn.usage.toolCalls} tool call(s)`} />
                        </Stack>
                        {lastTurn.usage.agents.length > 0 && (
                            <Table size='small' sx={{ mt: 1 }}>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Agent / node</TableCell>
                                        <TableCell align='right'>Calls</TableCell>
                                        <TableCell align='right'>Tokens</TableCell>
                                        <TableCell align='right'>Tools</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {lastTurn.usage.agents.map((agent) => (
                                        <TableRow key={agent.name}>
                                            <TableCell>{agent.name}</TableCell>
                                            <TableCell align='right'>{agent.calls}</TableCell>
                                            <TableCell align='right'>{formatNumber(agent.totalTokens)}</TableCell>
                                            <TableCell align='right'>{agent.toolCalls}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </>
                ) : (
                    <Typography variant='body2' color='text.secondary'>
                        {loading ? 'Waiting for the crew to answer…' : 'Ask the crew something to see its usage here.'}
                    </Typography>
                )}
            </Section>

            <Section
                title='Live vs. measured'
                action={<Chip size='small' variant='outlined' label={`version ${deployment.currentVersion}`} />}
            >
                {!lab ? (
                    <Typography variant='body2' color='text.secondary'>
                        This version was deployed without measured metrics, so there is nothing to compare against.
                    </Typography>
                ) : !live.turns ? (
                    <Typography variant='body2' color='text.secondary'>
                        The comparison appears after the first completed reply.
                    </Typography>
                ) : (
                    <>
                        <Table size='small'>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Metric</TableCell>
                                    <TableCell align='right'>Measured</TableCell>
                                    <TableCell align='right'>This session</TableCell>
                                    <TableCell align='right'>Ratio</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {comparison.map((row) => (
                                    <TableRow key={row.key}>
                                        <TableCell>{row.label}</TableCell>
                                        <TableCell align='right'>{formatMetric(row.key, row.expected)}</TableCell>
                                        <TableCell align='right'>{formatMetric(row.key, row.observed)}</TableCell>
                                        <TableCell align='right'>
                                            <Chip
                                                size='small'
                                                variant={row.drift ? 'filled' : 'outlined'}
                                                color={row.drift ? 'warning' : 'default'}
                                                label={formatRatio(row.ratio)}
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                        {drift.length > 0 && (
                            <Alert severity='warning' sx={{ mt: 1 }}>
                                {drift.map((row) => row.label).join(', ')} {drift.length === 1 ? 'is' : 'are'} at least ×{LAB_DRIFT_RATIO}{' '}
                                what the acceptance suite measured. Real requests may be harder than the suite, or the crew may be looping —
                                flag the replies responsible so they become regression cases.
                            </Alert>
                        )}
                        <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: 0.5 }}>
                            Measured is the average per acceptance case; this session is the average per reply. Cost stays at $0 unless the
                            model reports pricing.
                        </Typography>
                    </>
                )}
            </Section>

            <Section title='This session'>
                <Stack direction='row' gap={1} flexWrap='wrap'>
                    <Stat label='Replies' value={live.turns} />
                    <Stat label='Tokens' value={formatNumber(live.totalTokens)} />
                    <Stat label='Cost' value={formatCost(live.estimatedCost)} />
                    <Stat label='Avg. latency' value={live.averageDurationMs ? formatDuration(live.averageDurationMs) : '—'} />
                </Stack>
            </Section>

            <Section
                title='All sessions · 30 days'
                action={
                    <Button size='small' component={Link} to={`/analytics/${deployment.flowId}`}>
                        Details
                    </Button>
                }
            >
                {flowSummary ? (
                    <Stack direction='row' gap={1} flexWrap='wrap'>
                        <Stat label='Runs' value={formatNumber(flowSummary.totalRuns)} />
                        <Stat label='Tokens' value={formatNumber(flowSummary.totalTokens)} />
                        <Stat label='Cost' value={formatCost(flowSummary.estimatedCost)} />
                        <Stat label='Success' value={formatPercent(Number(flowSummary.successRate || 0) / 100)} />
                    </Stack>
                ) : (
                    <Typography variant='body2' color='text.secondary'>
                        No executions recorded yet.
                    </Typography>
                )}
            </Section>

            <Section
                title={`Replies (${turns.length})`}
                action={
                    <FormControlLabel
                        sx={{ mr: 0 }}
                        control={
                            <Switch size='small' checked={autoReview} onChange={(event) => onAutoReviewChange(event.target.checked)} />
                        }
                        label={<Typography variant='caption'>Auto-review</Typography>}
                    />
                }
            >
                <Typography variant='caption' color='text.secondary' display='block' sx={{ mb: 1 }}>
                    Flag a reply you are unhappy with, or let the reviewer model check it. A pending case is filed only for a flagged reply
                    or a defect the reviewer finds; each review is one extra model call.
                </Typography>
                <Stack spacing={1}>
                    {[...turns].reverse().map((turn) => {
                        const review = reviews[turn.key]
                        const verdict = review ? VERDICT_CHIP[review.verdict] : null
                        return (
                            <Box key={turn.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1 }}>
                                <Typography variant='body2' sx={{ fontWeight: 600 }} noWrap title={turn.question}>
                                    {turn.question}
                                </Typography>
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                                >
                                    {turn.answer || (turn.complete ? 'No reply text.' : 'Answering…')}
                                </Typography>
                                <Stack direction='row' spacing={0.5} alignItems='center' flexWrap='wrap' useFlexGap sx={{ mt: 0.75 }}>
                                    <Chip size='small' variant='outlined' label={`${formatNumber(turn.usage.totalTokens)} tokens`} />
                                    <Chip size='small' variant='outlined' label={`${turn.toolCalls.length} tool call(s)`} />
                                    {turn.failed && <Chip size='small' color='error' label='execution error' />}
                                    {verdict && <Chip size='small' color={verdict.color} label={verdict.label} />}
                                    {review?.recorded && <Chip size='small' color='info' variant='outlined' label='case filed' />}
                                    <Box sx={{ flexGrow: 1 }} />
                                    <Button
                                        size='small'
                                        startIcon={reviewing[turn.key] ? <CircularProgress size={12} /> : <IconSparkles size={14} />}
                                        disabled={!turn.complete || Boolean(reviewing[turn.key])}
                                        onClick={() => onReview(turn)}
                                    >
                                        Review
                                    </Button>
                                    <Button
                                        size='small'
                                        color='warning'
                                        startIcon={<IconThumbDown size={14} />}
                                        disabled={!turn.complete || Boolean(reviewing[turn.key])}
                                        onClick={() => onFlag(turn)}
                                    >
                                        Flag
                                    </Button>
                                </Stack>
                                {review && (review.issues || []).length > 0 && (
                                    <Box sx={{ mt: 0.5 }}>
                                        {review.issues.slice(0, 3).map((issue) => (
                                            <Typography key={issue} variant='caption' display='block' color='text.secondary'>
                                                • {issue}
                                            </Typography>
                                        ))}
                                    </Box>
                                )}
                            </Box>
                        )
                    })}
                </Stack>
            </Section>
        </Stack>
    )
}

MonitorPanel.propTypes = {
    deployment: PropTypes.object.isRequired,
    turns: PropTypes.array.isRequired,
    chatId: PropTypes.string,
    loading: PropTypes.bool,
    reviews: PropTypes.object.isRequired,
    reviewing: PropTypes.object.isRequired,
    autoReview: PropTypes.bool,
    onAutoReviewChange: PropTypes.func.isRequired,
    onReview: PropTypes.func.isRequired,
    onFlag: PropTypes.func.isRequired
}

export default MonitorPanel
