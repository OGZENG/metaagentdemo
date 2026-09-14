import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
    Alert,
    Badge,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Grid,
    Stack,
    Tab,
    Tabs,
    TextField,
    Typography
} from '@mui/material'
import { IconChartHistogram, IconExternalLink, IconMessagePlus } from '@tabler/icons-react'

import deploymentsApi from '@/api/autopilotDeployments'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import ChatMessage from '@/views/chatmessage/ChatMessage'
import { errorMessage } from '../studioRunner'
import { buildConversationTurns } from '../studioUtils'
import ImprovePanel from './ImprovePanel'
import MonitorPanel from './MonitorPanel'
import VersionsPanel from './VersionsPanel'
import { TOOL_MODE_LABELS } from './format'

const EMPTY_CHAT = { messages: [], chatId: '', loading: false }
const PANEL_HEIGHT = 'calc(100vh - 250px)'

const compactToolCalls = (toolCalls = []) =>
    toolCalls.map(({ tool, toolInput, toolOutput, error }) => ({
        tool,
        toolInput,
        toolOutput: typeof toolOutput === 'string' ? toolOutput.slice(0, 2000) : toolOutput,
        error
    }))

/**
 * Where a deployed crew is used: a normal Flowise chat on the left, and beside
 * it what the thesis adds — the crew's own telemetry against what it was
 * measured at, the cases collected from real replies, and the gated loop that
 * turns those cases into a new published version.
 */
const Playground = () => {
    const { id } = useParams()
    const navigate = useNavigate()
    const [deployment, setDeployment] = useState(null)
    const [loadError, setLoadError] = useState('')
    const [chat, setChat] = useState(EMPTY_CHAT)
    const [sessionKey, setSessionKey] = useState(0)
    const [previews, setPreviews] = useState([])
    const [tab, setTab] = useState('monitor')
    const [reviews, setReviews] = useState({})
    const [reviewing, setReviewing] = useState({})
    const [autoReview, setAutoReview] = useState(false)
    const [notice, setNotice] = useState(null)
    const [flagTurn, setFlagTurn] = useState(null)
    const [feedback, setFeedback] = useState('')

    useEffect(() => {
        let cancelled = false
        setDeployment(null)
        setLoadError('')
        deploymentsApi
            .getDeployment(id)
            .then(({ data }) => !cancelled && setDeployment(data))
            .catch((error) => !cancelled && setLoadError(errorMessage(error)))
        return () => {
            cancelled = true
        }
    }, [id])

    const turns = useMemo(() => buildConversationTurns(chat.messages, chat.loading), [chat])
    const handleMessagesChange = useCallback((next) => setChat(next), [])

    const newSession = useCallback(() => {
        // Remounting starts a new chat id; earlier sessions stay in Token Analytics.
        setSessionKey((key) => key + 1)
        setChat(EMPTY_CHAT)
        setReviews({})
        setPreviews([])
    }, [])

    const applyDeployment = useCallback(
        (next) => {
            if (deployment && next.currentVersion !== deployment.currentVersion) {
                newSession()
                setNotice({
                    severity: 'success',
                    text: `Version ${next.currentVersion} is live. A new chat session started so its metrics are not mixed with the previous version.`
                })
            }
            setDeployment(next)
        },
        [deployment, newSession]
    )

    const reviewTurn = useCallback(
        async (turn, source, feedbackText = '') => {
            if (!deployment) return
            setReviewing((current) => ({ ...current, [turn.key]: true }))
            try {
                const { data } = await deploymentsApi.assessTurn(deployment.id, {
                    question: turn.question,
                    answer: turn.answer,
                    toolCalls: compactToolCalls(turn.toolCalls),
                    feedback: feedbackText,
                    sessionId: chat.chatId,
                    source
                })
                setReviews((current) => ({ ...current, [turn.key]: { ...data.assessment, recorded: Boolean(data.recorded), source } }))
                if (data.recorded) {
                    const refreshed = await deploymentsApi.getDeployment(deployment.id)
                    setDeployment(refreshed.data)
                    setNotice({
                        severity: 'info',
                        text: `Filed a pending case — ${data.assessment.summary} Review it on the Improve tab.`
                    })
                }
            } catch (error) {
                setNotice({ severity: 'error', text: errorMessage(error) })
            } finally {
                setReviewing((current) => {
                    const next = { ...current }
                    delete next[turn.key]
                    return next
                })
            }
        },
        [deployment, chat.chatId]
    )

    useEffect(() => {
        if (!autoReview) return
        const last = [...turns].reverse().find((turn) => turn.complete)
        if (last && last.messageId && !reviews[last.key] && !reviewing[last.key]) reviewTurn(last, 'model_review')
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoReview, turns])

    const submitFlag = () => {
        const turn = flagTurn
        setFlagTurn(null)
        reviewTurn(turn, 'user_feedback', feedback.trim())
        setFeedback('')
    }

    if (loadError) {
        return (
            <MainCard>
                <Alert severity='error'>{loadError}</Alert>
            </MainCard>
        )
    }
    if (!deployment) {
        return (
            <MainCard>
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                    <CircularProgress />
                </Box>
            </MainCard>
        )
    }

    const toolMode = deployment.summary?.toolMode
    const pendingCases = deployment.onlineCases.filter((item) => item.status === 'pending').length

    return (
        <MainCard>
            <ViewHeader
                isBackButton
                onBack={() => navigate('/meta-agent/deployments')}
                title={deployment.name}
                description={deployment.design?.summary || deployment.goal}
            >
                <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                    <Chip color='primary' label={`v${deployment.currentVersion}`} />
                    {toolMode && (
                        <Chip
                            variant='outlined'
                            color={toolMode === 'simulated' || toolMode === 'none' ? 'default' : 'warning'}
                            label={TOOL_MODE_LABELS[toolMode]}
                        />
                    )}
                    <Button
                        size='small'
                        variant='outlined'
                        startIcon={<IconMessagePlus size={16} />}
                        onClick={newSession}
                        disabled={chat.loading}
                    >
                        New session
                    </Button>
                    <Button
                        size='small'
                        component={Link}
                        to={`/analytics/${deployment.flowId}`}
                        startIcon={<IconChartHistogram size={16} />}
                    >
                        Token analytics
                    </Button>
                    <Button
                        size='small'
                        component={Link}
                        to={`/v2/agentcanvas/${deployment.flowId}`}
                        target='_blank'
                        endIcon={<IconExternalLink size={14} />}
                    >
                        Canvas
                    </Button>
                </Stack>
            </ViewHeader>

            {toolMode === 'simulated' && (
                <Alert severity='info' sx={{ mt: 2 }}>
                    This crew runs against the simulated tool environment it was tested in. Requests about records outside its fixtures come
                    back as “not found”.
                </Alert>
            )}
            {notice && (
                <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mt: 2 }}>
                    {notice.text}
                </Alert>
            )}

            <Grid container spacing={2} sx={{ mt: 0.5 }}>
                <Grid item xs={12} md={7}>
                    <Box
                        sx={{
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 2,
                            overflow: 'hidden',
                            height: PANEL_HEIGHT,
                            minHeight: 520
                        }}
                    >
                        <Box
                            className='cloud-dialog-wrapper'
                            sx={{ height: '100% !important', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                        >
                            <ChatMessage
                                key={sessionKey}
                                open
                                isDialog
                                isAgentCanvas
                                loadHistory={false}
                                chatflowid={deployment.flowId}
                                previews={previews}
                                setPreviews={setPreviews}
                                onMessagesChange={handleMessagesChange}
                            />
                        </Box>
                    </Box>
                </Grid>
                <Grid item xs={12} md={5}>
                    <Box
                        sx={{
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 2,
                            height: PANEL_HEIGHT,
                            minHeight: 520,
                            display: 'flex',
                            flexDirection: 'column'
                        }}
                    >
                        <Tabs
                            value={tab}
                            onChange={(_event, value) => setTab(value)}
                            variant='fullWidth'
                            sx={{ borderBottom: 1, borderColor: 'divider' }}
                        >
                            <Tab value='monitor' label='Monitor' />
                            <Tab
                                value='improve'
                                label={
                                    <Badge color='warning' badgeContent={pendingCases} sx={{ pr: pendingCases ? 1.5 : 0 }}>
                                        Improve
                                    </Badge>
                                }
                            />
                            <Tab value='versions' label={`Versions (${deployment.versions.length})`} />
                        </Tabs>
                        <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
                            {tab === 'monitor' && (
                                <MonitorPanel
                                    deployment={deployment}
                                    turns={turns}
                                    chatId={chat.chatId}
                                    loading={chat.loading}
                                    reviews={reviews}
                                    reviewing={reviewing}
                                    autoReview={autoReview}
                                    onAutoReviewChange={setAutoReview}
                                    onReview={(turn) => reviewTurn(turn, 'model_review')}
                                    onFlag={(turn) => setFlagTurn(turn)}
                                />
                            )}
                            {tab === 'improve' && <ImprovePanel deployment={deployment} onChange={applyDeployment} />}
                            {tab === 'versions' && <VersionsPanel deployment={deployment} onChange={applyDeployment} />}
                        </Box>
                    </Box>
                </Grid>
            </Grid>

            <Dialog open={Boolean(flagTurn)} onClose={() => setFlagTurn(null)} fullWidth maxWidth='sm'>
                <DialogTitle sx={{ fontSize: '1.1rem' }}>Flag this reply</DialogTitle>
                <DialogContent dividers>
                    <Typography variant='caption' color='text.secondary'>
                        Request
                    </Typography>
                    <Typography variant='body2' sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>
                        {flagTurn?.question}
                    </Typography>
                    <TextField
                        multiline
                        minRows={3}
                        fullWidth
                        label='What was wrong, or what should the crew do instead?'
                        value={feedback}
                        onChange={(event) => setFeedback(event.target.value)}
                    />
                    <Typography variant='caption' color='text.secondary' display='block' sx={{ mt: 1 }}>
                        The reviewer model turns this into a pending case: the defects, a proposed rule and a regression scenario. The crew
                        does not change until you accept the case, run an improvement and publish a candidate that passes the gate.
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ px: 3, py: 1.5 }}>
                    <Button onClick={() => setFlagTurn(null)}>Cancel</Button>
                    <Button variant='contained' onClick={submitFlag}>
                        File case
                    </Button>
                </DialogActions>
            </Dialog>
            <ConfirmDialog />
        </MainCard>
    )
}

export default Playground
