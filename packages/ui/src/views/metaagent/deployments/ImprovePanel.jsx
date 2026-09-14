import { useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import {
    Alert,
    Box,
    Button,
    Chip,
    FormControlLabel,
    LinearProgress,
    MenuItem,
    Stack,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography
} from '@mui/material'
import { IconCheck, IconPlayerPlay, IconRestore, IconRocket, IconSquare, IconTrash, IconX } from '@tabler/icons-react'

import deploymentsApi from '@/api/autopilotDeployments'
import useConfirm from '@/hooks/useConfirm'
import { errorMessage } from '../studioRunner'
import { buildImprovementSuite } from '../studioUtils'
import useImprovementRun from './useImprovementRun'
import { formatDate, formatNumber, formatPercent } from './format'

const STATUS_COLOR = { pending: 'warning', accepted: 'info', rejected: 'default', incorporated: 'success' }
const SOURCE_LABEL = { user_feedback: 'user feedback', model_review: 'model review' }

const metric = (summary, key, format = formatPercent) => (summary ? format(summary[key]) : '—')

const CaseCard = ({ item, busy, onStatus, onDelete }) => {
    const acceptable = Boolean(item.scenario || item.instruction)
    const settled = item.status === 'incorporated'
    return (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1 }}>
            <Stack direction='row' spacing={0.5} alignItems='center' flexWrap='wrap' useFlexGap>
                <Chip size='small' color={STATUS_COLOR[item.status]} label={item.status} />
                <Chip size='small' variant='outlined' label={SOURCE_LABEL[item.source] || item.source} />
                <Chip size='small' variant='outlined' label={`from v${item.version}`} />
                <Box sx={{ flexGrow: 1 }} />
                <Typography variant='caption' color='text.secondary'>
                    {formatDate(item.createdAt)}
                </Typography>
            </Stack>
            <Typography variant='body2' sx={{ fontWeight: 600, mt: 0.75 }}>
                {item.question}
            </Typography>
            {item.feedback && (
                <Typography variant='caption' display='block' sx={{ mt: 0.25 }}>
                    <strong>Feedback:</strong> {item.feedback}
                </Typography>
            )}
            {item.summary && (
                <Typography variant='caption' display='block' color='text.secondary' sx={{ mt: 0.25 }}>
                    {item.summary}
                </Typography>
            )}
            {item.issues.slice(0, 4).map((issue) => (
                <Typography key={issue} variant='caption' display='block' color='text.secondary'>
                    • {issue}
                </Typography>
            ))}
            {item.instruction && (
                <Typography variant='caption' display='block' sx={{ mt: 0.5 }}>
                    <strong>Proposed rule:</strong> {item.instruction}
                </Typography>
            )}
            {item.scenario ? (
                <Typography variant='caption' display='block' sx={{ mt: 0.25 }}>
                    <strong>Regression case:</strong> {item.scenario.title} · {item.scenario.assertions.length} assertion(s)
                </Typography>
            ) : (
                <Typography variant='caption' display='block' color='text.secondary' sx={{ mt: 0.25 }}>
                    No regression case was drafted for this reply.
                </Typography>
            )}
            {item.environmentGaps.length > 0 && (
                <Typography variant='caption' display='block' color='warning.main' sx={{ mt: 0.25 }}>
                    Simulated environment lacks: {item.environmentGaps.join('; ')}
                </Typography>
            )}
            {!settled && (
                <Stack direction='row' spacing={0.5} sx={{ mt: 0.75 }} flexWrap='wrap' useFlexGap>
                    {item.status !== 'accepted' && (
                        <Tooltip title={acceptable ? '' : 'Needs a regression case or a rule to be useful'}>
                            <span>
                                <Button
                                    size='small'
                                    startIcon={<IconCheck size={14} />}
                                    disabled={busy || !acceptable}
                                    onClick={() => onStatus(item, 'accepted')}
                                >
                                    Accept
                                </Button>
                            </span>
                        </Tooltip>
                    )}
                    {item.status !== 'rejected' && (
                        <Button
                            size='small'
                            color='inherit'
                            startIcon={<IconX size={14} />}
                            disabled={busy}
                            onClick={() => onStatus(item, 'rejected')}
                        >
                            Reject
                        </Button>
                    )}
                    {item.status !== 'pending' && (
                        <Button
                            size='small'
                            color='inherit'
                            startIcon={<IconRestore size={14} />}
                            disabled={busy}
                            onClick={() => onStatus(item, 'pending')}
                        >
                            Back to pending
                        </Button>
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    <Button size='small' color='error' startIcon={<IconTrash size={14} />} disabled={busy} onClick={() => onDelete(item)}>
                        Delete
                    </Button>
                </Stack>
            )}
        </Box>
    )
}

CaseCard.propTypes = {
    item: PropTypes.object.isRequired,
    busy: PropTypes.bool,
    onStatus: PropTypes.func.isRequired,
    onDelete: PropTypes.func.isRequired
}

/**
 * The human-gated improvement loop. Signals from real use become pending cases;
 * a person decides which ones count; a regression run measures candidates
 * against the original suite plus those cases; the server's gate decides which
 * candidates may be published; a person publishes one.
 */
const ImprovePanel = ({ deployment, onChange }) => {
    const { confirm } = useConfirm()
    const improvement = useImprovementRun(deployment.id)
    const [candidateCount, setCandidateCount] = useState(2)
    const [runHeldOut, setRunHeldOut] = useState(true)
    const [showSettled, setShowSettled] = useState(false)
    const [pendingAction, setPendingAction] = useState('')
    const [actionError, setActionError] = useState('')

    const suite = useMemo(() => buildImprovementSuite(deployment.design, deployment.onlineCases), [deployment])
    const latestRun = deployment.improvementRuns[deployment.improvementRuns.length - 1]
    const realTools = ['real', 'mixed'].includes(deployment.summary?.toolMode)
    const busy = improvement.busy || Boolean(pendingAction)

    const openCases = deployment.onlineCases.filter((item) => ['pending', 'accepted'].includes(item.status))
    const settledCases = deployment.onlineCases.filter((item) => ['rejected', 'incorporated'].includes(item.status))
    const shownCases = [...openCases, ...(showSettled ? settledCases : [])].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
    )

    const act = async (key, action) => {
        setPendingAction(key)
        setActionError('')
        try {
            const { data } = await action()
            if (data) onChange(data.deployment || data)
        } catch (error) {
            setActionError(errorMessage(error))
        } finally {
            setPendingAction('')
        }
    }

    const setStatus = (item, status) => act(`case-${item.id}`, () => deploymentsApi.updateOnlineCase(deployment.id, item.id, { status }))

    const removeCase = async (item) => {
        const confirmed = await confirm({
            title: 'Delete case',
            description: 'Delete this collected case? Rejecting keeps a record of the decision; deleting does not.',
            confirmButtonName: 'Delete',
            cancelButtonName: 'Cancel'
        })
        if (confirmed) act(`case-${item.id}`, () => deploymentsApi.deleteOnlineCase(deployment.id, item.id))
    }

    const startRun = async () => {
        const regressionRuns = suite.dev.length * (1 + Number(candidateCount))
        const confirmed = await confirm({
            title: 'Run improvement',
            description:
                `Measure the live version and up to ${candidateCount} candidate crew(s) on ${suite.dev.length} regression case(s) ` +
                `(${suite.onlineIds.length} from real conversations) — about ${regressionRuns} crew executions plus one evaluation ` +
                'each. The live flow is not touched.' +
                (realTools ? ' This deployment is bound to real tools, which these executions will call.' : ''),
            confirmButtonName: 'Run',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        const result = await improvement.run(deployment, { candidates: candidateCount, runHeldOut })
        if (result?.deployment) onChange(result.deployment)
    }

    const publish = async (candidate) => {
        const confirmed = await confirm({
            title: 'Publish candidate',
            description:
                `Make "${candidate.operatorDescription}" version ${deployment.currentVersion + 1}? The AgentFlow is recompiled and ` +
                'updated in place, so the chat and API endpoint stay the same, and the cases this run measured are marked ' +
                'incorporated. You can roll back from the Versions tab.',
            confirmButtonName: 'Publish',
            cancelButtonName: 'Cancel'
        })
        if (confirmed) act('publish', () => deploymentsApi.publishImprovement(deployment.id, latestRun.id, candidate.id))
    }

    const runIsCurrent = latestRun && latestRun.baseVersion === deployment.currentVersion && !latestRun.publishedVersion

    return (
        <Stack spacing={2.5}>
            {actionError && (
                <Alert severity='error' onClose={() => setActionError('')}>
                    {actionError}
                </Alert>
            )}

            <Box>
                <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1 }}>
                    <Typography variant='subtitle1'>Collected cases</Typography>
                    {settledCases.length > 0 && (
                        <FormControlLabel
                            sx={{ mr: 0 }}
                            control={
                                <Switch size='small' checked={showSettled} onChange={(event) => setShowSettled(event.target.checked)} />
                            }
                            label={<Typography variant='caption'>Show settled ({settledCases.length})</Typography>}
                        />
                    )}
                </Stack>
                {shownCases.length ? (
                    <Stack spacing={1}>
                        {shownCases.map((item) => (
                            <CaseCard key={item.id} item={item} busy={busy} onStatus={setStatus} onDelete={removeCase} />
                        ))}
                    </Stack>
                ) : (
                    <Typography variant='body2' color='text.secondary'>
                        No open cases. Flag a reply or run a review on the Monitor tab to collect one.
                    </Typography>
                )}
            </Box>

            <Box>
                <Typography variant='subtitle1' sx={{ mb: 1 }}>
                    Improvement run
                </Typography>
                <Typography variant='caption' color='text.secondary' display='block' sx={{ mb: 1.25 }}>
                    Regression suite: {suite.dev.length - suite.onlineIds.length} original development case(s) + {suite.onlineIds.length}{' '}
                    accepted online case(s)
                    {suite.instructions.length ? `, with ${suite.instructions.length} rule(s) handed to the search` : ''}. A candidate
                    passes the gate only if it does not regress on pass rate, failures, critical violations, online cases or held-out cases,
                    and measurably improves something.
                </Typography>
                {realTools && (
                    <Alert severity='warning' sx={{ mb: 1.25 }}>
                        This deployment calls real tools. Regression runs execute them too.
                    </Alert>
                )}
                <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                    <TextField
                        select
                        size='small'
                        label='Candidates'
                        value={candidateCount}
                        disabled={busy}
                        onChange={(event) => setCandidateCount(Number(event.target.value))}
                        sx={{ width: 120 }}
                    >
                        {[1, 2, 3, 4].map((count) => (
                            <MenuItem key={count} value={count}>
                                {count}
                            </MenuItem>
                        ))}
                    </TextField>
                    <FormControlLabel
                        control={
                            <Switch
                                size='small'
                                checked={runHeldOut}
                                disabled={busy}
                                onChange={(event) => setRunHeldOut(event.target.checked)}
                            />
                        }
                        label={<Typography variant='caption'>Held-out check</Typography>}
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    {improvement.busy ? (
                        <Button variant='outlined' color='error' startIcon={<IconSquare size={14} />} onClick={improvement.stop}>
                            Stop
                        </Button>
                    ) : (
                        <Button
                            variant='contained'
                            startIcon={<IconPlayerPlay size={14} />}
                            disabled={busy || !suite.caseIds.length}
                            onClick={startRun}
                        >
                            Run improvement
                        </Button>
                    )}
                </Stack>
                {!suite.caseIds.length && (
                    <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: 0.75 }}>
                        Accept at least one collected case to enable a run.
                    </Typography>
                )}
                {(improvement.busy || improvement.status) && (
                    <Box sx={{ mt: 1.25 }}>
                        {improvement.busy && (
                            <LinearProgress
                                variant={improvement.progress.total ? 'determinate' : 'indeterminate'}
                                value={improvement.progress.total ? (improvement.progress.current / improvement.progress.total) * 100 : 0}
                            />
                        )}
                        <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: 0.5 }}>
                            {improvement.status}
                            {improvement.busy && improvement.progress.total
                                ? ` (${improvement.progress.current}/${improvement.progress.total})`
                                : ''}
                        </Typography>
                    </Box>
                )}
                {improvement.error && (
                    <Alert severity='error' sx={{ mt: 1 }}>
                        {improvement.error}
                    </Alert>
                )}
            </Box>

            {latestRun && (
                <Box>
                    <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1 }}>
                        <Typography variant='subtitle1'>Latest run</Typography>
                        <Typography variant='caption' color='text.secondary'>
                            {formatDate(latestRun.completedAt)} · measured v{latestRun.baseVersion}
                        </Typography>
                    </Stack>
                    {latestRun.note && (
                        <Alert severity='info' sx={{ mb: 1 }}>
                            {latestRun.note}
                        </Alert>
                    )}
                    <TableContainer>
                        <Table size='small'>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Crew</TableCell>
                                    <TableCell align='right'>Pass</TableCell>
                                    <TableCell align='right'>Online</TableCell>
                                    <TableCell align='right'>Quality</TableCell>
                                    <TableCell align='right'>Tokens</TableCell>
                                    <TableCell align='right'>Held-out</TableCell>
                                    <TableCell align='right'>Gate</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {[latestRun.current, ...latestRun.candidates].map((row) => {
                                    const isCurrent = row.id === 'current'
                                    const recommended = row.id === latestRun.recommendedCandidateId
                                    return (
                                        <TableRow key={row.id} selected={recommended}>
                                            <TableCell>
                                                <Typography variant='caption' sx={{ fontWeight: isCurrent || recommended ? 700 : 400 }}>
                                                    {row.operatorDescription}
                                                </Typography>
                                            </TableCell>
                                            <TableCell align='right'>{metric(row.summary, 'passRate')}</TableCell>
                                            <TableCell align='right'>{metric(row.onlineSummary, 'passRate')}</TableCell>
                                            <TableCell align='right'>{metric(row.summary, 'quality')}</TableCell>
                                            <TableCell align='right'>
                                                {metric(row.summary, 'averageTokens', (value) => formatNumber(value))}
                                            </TableCell>
                                            <TableCell align='right'>{metric(row.testSummary, 'passRate')}</TableCell>
                                            <TableCell align='right' sx={{ whiteSpace: 'nowrap' }}>
                                                {isCurrent ? (
                                                    <Chip size='small' variant='outlined' label='live' />
                                                ) : row.eligible ? (
                                                    <Button
                                                        size='small'
                                                        variant={recommended ? 'contained' : 'outlined'}
                                                        startIcon={<IconRocket size={14} />}
                                                        disabled={busy || !runIsCurrent}
                                                        onClick={() => publish(row)}
                                                    >
                                                        Publish
                                                    </Button>
                                                ) : (
                                                    <Tooltip title={row.gateReason || row.error}>
                                                        <Chip size='small' color='default' label='rejected' />
                                                    </Tooltip>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </TableContainer>
                    <Stack spacing={0.25} sx={{ mt: 1 }}>
                        {latestRun.candidates.map((candidate) => (
                            <Typography key={candidate.id} variant='caption' color='text.secondary'>
                                <strong>{candidate.operatorDescription}:</strong>{' '}
                                {candidate.eligible ? candidate.rationale || 'passed the gate.' : candidate.gateReason || candidate.error}
                            </Typography>
                        ))}
                    </Stack>
                    {latestRun.publishedVersion ? (
                        <Alert severity='success' sx={{ mt: 1 }}>
                            Published as version {latestRun.publishedVersion}.
                        </Alert>
                    ) : (
                        latestRun.baseVersion !== deployment.currentVersion && (
                            <Alert severity='warning' sx={{ mt: 1 }}>
                                This run measured version {latestRun.baseVersion}; version {deployment.currentVersion} is live now, so its
                                candidates can no longer be published. Run again.
                            </Alert>
                        )
                    )}
                </Box>
            )}
        </Stack>
    )
}

ImprovePanel.propTypes = {
    deployment: PropTypes.object.isRequired,
    onChange: PropTypes.func.isRequired
}

export default ImprovePanel
