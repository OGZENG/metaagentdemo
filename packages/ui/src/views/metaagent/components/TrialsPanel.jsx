import PropTypes from 'prop-types'
import { Link } from 'react-router-dom'
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Box,
    Button,
    Chip,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography
} from '@mui/material'
import { IconCheck, IconChevronDown, IconExternalLink, IconRocket, IconX } from '@tabler/icons-react'

import CrewGraph from './CrewGraph'
import { buildSearchTree } from '../studioUtils'

const formatPercent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`
const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`
const formatLatency = (value) => `${(Number(value || 0) / 1000).toFixed(2)} s`

const delta = (candidate, baseline, format) => {
    if (baseline === undefined || baseline === null) return ''
    const difference = Number(candidate || 0) - Number(baseline || 0)
    if (!difference) return ' (=)'
    return ` (${difference > 0 ? '+' : ''}${format(difference)})`
}

const SearchTreeNode = ({ node, depth, selectedTrialId, paretoTrialIds }) => (
    <Box sx={{ pl: depth * 2.5 }}>
        <Stack direction='row' spacing={0.75} alignItems='center' sx={{ py: 0.35 }} flexWrap='wrap' useFlexGap>
            <Typography variant='caption' color='text.secondary'>
                {depth ? '└─' : '●'}
            </Typography>
            <Typography variant='body2' sx={{ fontWeight: node.id === selectedTrialId ? 700 : 400 }}>
                {node.operatorDescription || node.name}
            </Typography>
            {node.summary && <Chip size='small' variant='outlined' label={`pass ${formatPercent(node.summary.passRate)}`} />}
            {paretoTrialIds.includes(node.id) && <Chip size='small' color='success' variant='outlined' label='Pareto' />}
            {node.status === 'rejected' && <Chip size='small' color='error' variant='outlined' label='rejected' />}
        </Stack>
        {node.children.map((child) => (
            <SearchTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedTrialId={selectedTrialId}
                paretoTrialIds={paretoTrialIds}
            />
        ))}
    </Box>
)

SearchTreeNode.propTypes = {
    node: PropTypes.object.isRequired,
    depth: PropTypes.number.isRequired,
    selectedTrialId: PropTypes.string,
    paretoTrialIds: PropTypes.array.isRequired
}

const ScenarioResults = ({ results }) => {
    if (!results.length) return <Typography variant='caption'>No case was executed.</Typography>
    return (
        <Stack spacing={0.75}>
            {results.map((result) => {
                const failedAssertions = (result.evaluation?.assertionResults || []).filter((item) => !item.passed)
                return (
                    <Box key={result.scenarioId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                            <Chip
                                size='small'
                                color={result.error ? 'error' : result.evaluation?.passed ? 'success' : 'warning'}
                                label={result.error ? 'execution failed' : result.evaluation?.passed ? 'passed' : 'failed'}
                            />
                            <Typography variant='body2'>{result.title}</Typography>
                            <Chip size='small' variant='outlined' label={result.split} />
                            {!result.error && (
                                <>
                                    <Chip
                                        size='small'
                                        variant='outlined'
                                        label={`score ${Number(result.evaluation?.score || 0).toFixed(0)}`}
                                    />
                                    <Chip
                                        size='small'
                                        variant='outlined'
                                        label={`assertions ${result.evaluation?.assertionSummary?.passed || 0}/${
                                            result.evaluation?.assertionSummary?.total || 0
                                        }`}
                                    />
                                    <Chip size='small' variant='outlined' label={`${(result.toolCalls || []).length} tool calls`} />
                                </>
                            )}
                        </Stack>
                        {result.error && (
                            <Typography variant='caption' color='error'>
                                {result.error}
                            </Typography>
                        )}
                        {failedAssertions.map((item) => (
                            <Typography key={item.id} variant='caption' display='block' color='text.secondary'>
                                • [{item.severity}] {item.description} — {item.detail}
                            </Typography>
                        ))}
                        {(result.toolCalls || []).length > 0 && (
                            <Typography variant='caption' display='block' color='text.secondary'>
                                Tools: {result.toolCalls.map((call) => call.tool).join(', ')}
                            </Typography>
                        )}
                    </Box>
                )
            })}
        </Stack>
    )
}

ScenarioResults.propTypes = { results: PropTypes.array.isRequired }

/**
 * Comparison of every crew the search produced.
 *
 * Dev metrics are what the search optimized; the held-out column is the number
 * worth quoting, because nothing in the loop was allowed to see it.
 */
const RECOMMENDATION_STATUS_COLOR = { accepted: 'success', rejected: 'default', applied: 'info', pending: 'warning' }

const TrialsPanel = ({
    trials,
    paretoTrialIds,
    selectedTrialId,
    diagnosis,
    recommendations,
    onRecommendationStatus,
    onApplyRecommendations,
    onDeploy,
    busy
}) => {
    const baseline = trials[0]
    const tree = buildSearchTree(trials)

    if (!trials.length) return <Alert severity='info'>Compile the baseline crew and run the acceptance suite to see results here.</Alert>

    return (
        <Stack spacing={2}>
            <Box>
                <Typography variant='subtitle2' sx={{ mb: 0.5 }}>
                    Search tree
                </Typography>
                <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                    {tree.map((node) => (
                        <SearchTreeNode
                            key={node.id}
                            node={node}
                            depth={0}
                            selectedTrialId={selectedTrialId}
                            paretoTrialIds={paretoTrialIds || []}
                        />
                    ))}
                </Box>
            </Box>

            <TableContainer>
                <Table size='small'>
                    <TableHead>
                        <TableRow>
                            <TableCell>Crew</TableCell>
                            <TableCell>Operator</TableCell>
                            <TableCell align='right'>Dev pass</TableCell>
                            <TableCell align='right'>Dev quality</TableCell>
                            <TableCell align='right'>Assertions</TableCell>
                            <TableCell align='right'>Held-out pass</TableCell>
                            <TableCell align='right'>Calls</TableCell>
                            <TableCell align='right'>Cost</TableCell>
                            <TableCell align='right'>Latency</TableCell>
                            <TableCell />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {trials.map((trial) => (
                            <TableRow key={trial.id} selected={trial.id === selectedTrialId}>
                                <TableCell>
                                    <Stack direction='row' spacing={0.5} alignItems='center' flexWrap='wrap' useFlexGap>
                                        <Typography variant='body2'>{trial.name}</Typography>
                                        {(paretoTrialIds || []).includes(trial.id) && (
                                            <Chip size='small' color='success' variant='outlined' label='Pareto' />
                                        )}
                                        {trial.id === selectedTrialId && <Chip size='small' color='primary' label='recommended' />}
                                    </Stack>
                                </TableCell>
                                <TableCell>
                                    <Typography variant='caption'>{trial.operatorDescription}</Typography>
                                </TableCell>
                                <TableCell align='right'>
                                    {trial.summary ? formatPercent(trial.summary.passRate) : '—'}
                                    {trial.summary && baseline?.summary && trial.id !== baseline.id
                                        ? delta(trial.summary.passRate, baseline.summary.passRate, (value) => formatPercent(value))
                                        : ''}
                                </TableCell>
                                <TableCell align='right'>{trial.summary ? formatPercent(trial.summary.quality) : '—'}</TableCell>
                                <TableCell align='right'>{trial.summary ? formatPercent(trial.summary.assertionRate) : '—'}</TableCell>
                                <TableCell align='right'>
                                    {trial.testSummary ? (
                                        <strong>{formatPercent(trial.testSummary.passRate)}</strong>
                                    ) : (
                                        <Typography variant='caption' color='text.secondary'>
                                            not run
                                        </Typography>
                                    )}
                                </TableCell>
                                <TableCell align='right'>{trial.summary ? trial.summary.averageModelCalls.toFixed(1) : '—'}</TableCell>
                                <TableCell align='right'>{trial.summary ? formatCost(trial.summary.averageCost) : '—'}</TableCell>
                                <TableCell align='right'>{trial.summary ? formatLatency(trial.summary.averageDurationMs) : '—'}</TableCell>
                                <TableCell align='right' sx={{ whiteSpace: 'nowrap' }}>
                                    {onDeploy && trial.summary && trial.crew && trial.status !== 'rejected' && (
                                        <Button
                                            size='small'
                                            variant={trial.id === selectedTrialId ? 'contained' : 'outlined'}
                                            startIcon={<IconRocket size={14} />}
                                            disabled={busy}
                                            onClick={() => onDeploy(trial)}
                                            sx={{ mr: 0.5 }}
                                        >
                                            Deploy
                                        </Button>
                                    )}
                                    {trial.flowId && (
                                        <Button
                                            size='small'
                                            component={Link}
                                            to={`/v2/agentcanvas/${trial.flowId}`}
                                            target='_blank'
                                            endIcon={<IconExternalLink size={14} />}
                                        >
                                            Open
                                        </Button>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            {diagnosis && (
                <Alert severity='info'>
                    <Typography variant='subtitle2'>Diagnosis</Typography>
                    <Typography variant='body2'>{diagnosis}</Typography>
                </Alert>
            )}

            {(recommendations || []).length > 0 && (
                <Box>
                    <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 0.5 }} flexWrap='wrap' useFlexGap>
                        <Typography variant='subtitle2'>Recommendations</Typography>
                        <Box sx={{ flexGrow: 1 }} />
                        <Button
                            size='small'
                            variant='contained'
                            disabled={busy || !recommendations.some((item) => item.status === 'accepted')}
                            onClick={onApplyRecommendations}
                        >
                            Apply accepted
                        </Button>
                    </Stack>
                    <Typography variant='caption' color='text.secondary'>
                        Accepting a coverage or contract finding edits the suite. Accepting a workflow finding becomes guidance for the next
                        crew redesign. Applying clears the current results, because a changed suite invalidates every earlier score — the
                        run stays on this step as a read-only snapshot to compare against.
                    </Typography>
                    <Stack spacing={0.75} sx={{ mt: 1 }}>
                        {recommendations.map((recommendation) => (
                            <Box key={recommendation.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                                <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                                    <Chip size='small' variant='outlined' label={recommendation.type} />
                                    <Chip
                                        size='small'
                                        color={['critical', 'high'].includes(recommendation.severity) ? 'error' : 'default'}
                                        variant='outlined'
                                        label={recommendation.severity}
                                    />
                                    <Typography variant='body2'>{recommendation.title}</Typography>
                                    <Box sx={{ flexGrow: 1 }} />
                                    <Chip
                                        size='small'
                                        color={RECOMMENDATION_STATUS_COLOR[recommendation.status] || 'default'}
                                        label={recommendation.status || 'pending'}
                                    />
                                    <Button
                                        size='small'
                                        startIcon={<IconCheck size={14} />}
                                        disabled={busy || recommendation.status === 'applied'}
                                        onClick={() => onRecommendationStatus(recommendation.id, 'accepted')}
                                    >
                                        Accept
                                    </Button>
                                    <Button
                                        size='small'
                                        color='inherit'
                                        startIcon={<IconX size={14} />}
                                        disabled={busy || recommendation.status === 'applied'}
                                        onClick={() => onRecommendationStatus(recommendation.id, 'rejected')}
                                    >
                                        Reject
                                    </Button>
                                </Stack>
                                <Typography variant='caption' display='block' color='text.secondary'>
                                    {recommendation.rationale}
                                </Typography>
                                <Typography variant='caption' display='block'>
                                    <strong>Proposed:</strong> {recommendation.proposedChange}
                                </Typography>
                                {(recommendation.suggestedScenarios || []).length > 0 && (
                                    <Typography variant='caption' display='block' color='text.secondary'>
                                        Adds {recommendation.suggestedScenarios.length} acceptance case(s).
                                    </Typography>
                                )}
                                {(recommendation.suggestedCriteria || []).length > 0 && (
                                    <Typography variant='caption' display='block' color='text.secondary'>
                                        Adds {recommendation.suggestedCriteria.length} success criterion/criteria.
                                    </Typography>
                                )}
                            </Box>
                        ))}
                    </Stack>
                </Box>
            )}

            {trials.map((trial) => (
                <Accordion key={`${trial.id}-detail`} disableGutters>
                    <AccordionSummary expandIcon={<IconChevronDown size={18} />}>
                        <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                            <Typography variant='subtitle2'>{trial.name}</Typography>
                            {trial.status === 'rejected' && <Chip size='small' color='error' variant='outlined' label='rejected' />}
                        </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                        <Stack spacing={1.5}>
                            {trial.rationale && (
                                <Typography variant='caption' color='text.secondary'>
                                    <strong>Why this operator:</strong> {trial.rationale}
                                </Typography>
                            )}
                            {trial.rejectionReason && <Alert severity='error'>{trial.rejectionReason}</Alert>}
                            {trial.flowData && <CrewGraph flowData={trial.flowData} baselineFlowData={baseline?.flowData} />}
                            <Typography variant='subtitle2'>Development cases</Typography>
                            <ScenarioResults results={trial.devResults || []} />
                            {(trial.testResults || []).length > 0 && (
                                <>
                                    <Typography variant='subtitle2'>Held-out cases</Typography>
                                    <ScenarioResults results={trial.testResults} />
                                </>
                            )}
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            ))}
        </Stack>
    )
}

TrialsPanel.propTypes = {
    trials: PropTypes.array.isRequired,
    paretoTrialIds: PropTypes.array,
    selectedTrialId: PropTypes.string,
    diagnosis: PropTypes.string,
    recommendations: PropTypes.array,
    onRecommendationStatus: PropTypes.func.isRequired,
    onApplyRecommendations: PropTypes.func.isRequired,
    onDeploy: PropTypes.func,
    busy: PropTypes.bool
}

export default TrialsPanel
