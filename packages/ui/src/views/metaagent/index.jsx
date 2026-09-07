import { useEffect, useMemo, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Divider,
    Grid,
    LinearProgress,
    MenuItem,
    Stack,
    Step,
    StepButton,
    Stepper,
    TextField,
    Typography
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { IconPlayerPlay, IconRefresh, IconSparkles, IconSquare, IconTrash, IconWand } from '@tabler/icons-react'

import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import useConfirm from '@/hooks/useConfirm'
import { FLOWISE_CREDENTIAL_ID } from '@/store/constant'
import { showHideInputParams } from '@/utils/genericHelper'

import StudioModelPicker from './StudioModelPicker'
import CrewPanel from './components/CrewPanel'
import CrewGraph from './components/CrewGraph'
import ScenarioPanel from './components/ScenarioPanel'
import ToolEnvironmentPanel from './components/ToolEnvironmentPanel'
import TrialsPanel from './components/TrialsPanel'
import useAutopilotRun from './useAutopilotRun'
import { SEARCH_STRATEGIES, splitScenarios } from './studioUtils'

const STAGES = [
    { label: 'Describe', caption: 'Set the objective' },
    { label: 'Contract', caption: 'Review the test world' },
    { label: 'Crew', caption: 'Shape and compile' },
    { label: 'Search', caption: 'Run the experiment' },
    { label: 'Results', caption: 'Compare and decide' }
]

const STAGE_COPY = [
    {
        eyebrow: 'Start with intent',
        title: 'What should this workflow accomplish?',
        description:
            'Describe the outcome and guardrails in plain language. Autopilot will turn them into a reviewable contract, test environment and initial crew.'
    },
    {
        eyebrow: 'Review before building',
        title: 'Confirm the contract and test world',
        description:
            'Make sure the success criteria, constraints, simulated tools and acceptance cases represent the workflow you actually want.'
    },
    {
        eyebrow: 'Design the team',
        title: 'Review and compile the crew',
        description: 'Adjust agents and tasks, then compile this definition into an executable baseline AgentFlow.'
    },
    {
        eyebrow: 'Run the experiment',
        title: 'Configure the search, then let it run',
        description: 'Measure the baseline, explore candidate crews and evaluate the best candidates against the held-out suite.'
    },
    {
        eyebrow: 'Evidence, not guesswork',
        title: 'Compare the crews and choose what ships',
        description: 'Inspect quality, cost, latency, failures and recommendations across the baseline and generated candidates.'
    }
]

const PHASE_LABELS = {
    design: 'Designing the contract, environment and crew',
    scenarios: 'Regenerating the environment and suite',
    crew: 'Redesigning the crew',
    compile: 'Compiling the baseline',
    run: 'Running the acceptance suite'
}

const EXAMPLE_GOAL = `Build a customer-support workflow for an online electronics shop. It should classify each request, answer product and delivery questions, look up order information only when the customer supplies an order ID, escalate refunds above EUR 100 or uncertain policy cases to a human, never invent an order status, and return a concise customer-facing reply plus an internal action summary.`

const missingCredentialFields = (model) => {
    if (!model || !Object.keys(model).length) return ['model']
    return showHideInputParams(model)
        .filter((inputParam) => {
            // `additionalParams` are the node's advanced settings — Flowise itself
            // renders them behind a separate dialog and never requires them to
            // run. Reasoning models expose several of these without marking them
            // optional, which blocked generation over fields nobody needs to set.
            if (inputParam.hidden || inputParam.optional || inputParam.additionalParams) return false
            if (inputParam.type === 'credential') return !model.credential && !model.inputs?.[FLOWISE_CREDENTIAL_ID]
            return !model.inputs?.[inputParam.name]
        })
        .map((inputParam) => inputParam.label || inputParam.name)
}

const WorkflowAutopilot = () => {
    const theme = useTheme()
    const { confirm } = useConfirm()
    const autopilot = useAutopilotRun()
    const {
        goal,
        setGoal,
        settings,
        patchSettings,
        session,
        persistSession,
        updateDesign,
        selectedChatModel,
        setSelectedChatModel,
        cheapChatModel,
        setCheapChatModel,
        busy,
        phase,
        status,
        progress,
        error,
        designWorkflow,
        regenerateScenarios,
        regenerateCrew,
        compileBaseline,
        runAutopilot,
        setRecommendationStatus,
        applyRecommendations,
        requestStop,
        clearSession
    } = autopilot

    const [stage, setStage] = useState(0)

    useEffect(() => {
        if (!goal) setGoal(EXAMPLE_GOAL)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const design = session.design
    const hasDesign = Boolean(design)
    const trials = session.trials || []
    const configuredCheapModel = cheapChatModel?.name ? cheapChatModel : undefined
    const scenarioSplit = useMemo(() => splitScenarios(design?.scenarios || []), [design])
    const modelProblems = useMemo(() => missingCredentialFields(selectedChatModel), [selectedChatModel])
    // Accepted workflow findings reach the crew only through a redesign:
    // compileBaseline never reads crewGuidance, so compiling straight after
    // applying would measure an unchanged crew against an edited suite.
    const unappliedGuidance = session.crewGuidanceApplied ? [] : session.crewGuidance || []
    const baselineReady = trials.length > 0 && session.contractStatus === 'confirmed'
    const resultsReady = Boolean(session.completedAt) || (!busy && trials.some((trial) => trial.summary))
    // Applying a recommendation clears the live results but keeps the run as a
    // snapshot, so the step stays reachable instead of locking behind a rerun.
    const archivedRun = session.archivedRun
    const showingArchive = !resultsReady && Boolean(archivedRun?.trials?.length)
    const canViewResults = resultsReady || showingArchive
    const maxUnlockedStage = canViewResults ? 4 : baselineReady ? 3 : hasDesign ? 2 : 0

    useEffect(() => {
        setStage((current) => {
            if (!hasDesign) return 0
            if (resultsReady) return current === 0 || current === 3 || current > 4 ? 4 : current
            if (baselineReady) return current === 0 || current === 2 || current > 3 ? 3 : current
            if (current === 0) return 1
            return Math.min(current, 2)
        })
    }, [hasDesign, baselineReady, resultsReady])

    const shownRun = showingArchive
        ? { ...archivedRun, recommendations: [] }
        : {
              trials,
              paretoTrialIds: session.paretoTrialIds,
              selectedTrialId: session.selectedTrialId,
              diagnosis: session.diagnosis,
              recommendations: session.recommendations
          }

    const progressValue = progress.total ? (progress.current / progress.total) * 100 : 0
    const currentStage = STAGE_COPY[stage]
    const completedStages = [hasDesign, hasDesign, baselineReady, resultsReady, false]

    const goToStage = (nextStage) => {
        if (nextStage <= maxUnlockedStage) setStage(nextStage)
    }

    // Discarding a run throws away the model calls that paid for it, and the
    // scores are not recoverable from the archive, so ask before doing it.
    const resetResults = async () => {
        const confirmed = await confirm({
            title: 'Reset results',
            description:
                `Discard the measured results for ${trials.length} crew${trials.length === 1 ? '' : 's'}? The compiled ` +
                'baseline is kept, but every development and held-out score, the diagnosis and its recommendations are ' +
                'deleted, and measuring them again costs model calls.',
            confirmButtonName: 'Discard results',
            cancelButtonName: 'Keep results'
        })
        if (!confirmed) return
        persistSession({
            ...session,
            trials: trials.slice(0, 1).map((trial) => ({
                ...trial,
                devResults: [],
                testResults: [],
                summary: null,
                testSummary: null
            })),
            paretoTrialIds: [],
            selectedTrialId: null,
            diagnosis: '',
            recommendations: [],
            completedAt: ''
        })
        setStage(3)
    }

    const compileBaselineWithGuidanceCheck = async () => {
        if (unappliedGuidance.length) {
            const confirmed = await confirm({
                title: 'Crew not redesigned yet',
                description:
                    `${unappliedGuidance.length} accepted ${unappliedGuidance.length === 1 ? 'diagnosis' : 'diagnoses'} ` +
                    'from the last run have not been applied to this crew. Only Redesign crew hands them to the designer, ' +
                    'so compiling now measures the unchanged crew against the edited acceptance suite.',
                confirmButtonName: 'Compile anyway',
                cancelButtonName: 'Redesign first'
            })
            if (!confirmed) return
        }
        compileBaseline(selectedChatModel, configuredCheapModel)
    }

    const startOver = async () => {
        const confirmed = await confirm({
            title: 'Start over',
            description:
                'Clear this Autopilot session — the goal, contract, crew, compiled baseline and every result? Compiled ' +
                'AgentFlows stay in the flow list, but the session itself cannot be recovered.',
            confirmButtonName: 'Start over',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        clearSession()
        setStage(0)
    }

    const panelSx = {
        border: `1px solid ${alpha(theme.palette.primary.main, 0.13)}`,
        borderRadius: 3,
        bgcolor: 'background.paper',
        boxShadow: `0 18px 50px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.22 : 0.06)}`,
        overflow: 'hidden'
    }

    const footerSx = {
        px: { xs: 2, md: 3 },
        py: 2,
        bgcolor: alpha(theme.palette.primary.main, 0.025),
        borderTop: `1px solid ${theme.palette.divider}`
    }

    return (
        <MainCard>
            <ViewHeader
                title='Workflow Autopilot'
                description='Design, compile and improve an agent workflow through a guided, measurable process.'
            >
                <Stack direction='row' spacing={1}>
                    {busy && (
                        <Button variant='outlined' color='error' startIcon={<IconSquare size={16} />} onClick={requestStop}>
                            Stop
                        </Button>
                    )}
                    {hasDesign && !busy && (
                        <Button variant='text' color='error' startIcon={<IconTrash size={16} />} onClick={startOver}>
                            Start over
                        </Button>
                    )}
                </Stack>
            </ViewHeader>

            <Box
                sx={{
                    mt: 2,
                    mb: 2.5,
                    p: { xs: 2, md: 2.5 },
                    borderRadius: 3,
                    color: theme.palette.mode === 'dark' ? 'primary.contrastText' : 'text.primary',
                    border: `1px solid ${alpha(theme.palette.primary.main, 0.16)}`,
                    background: `linear-gradient(120deg, ${alpha(
                        theme.palette.primary.main,
                        theme.palette.mode === 'dark' ? 0.3 : 0.09
                    )}, ${alpha(theme.palette.secondary.main, theme.palette.mode === 'dark' ? 0.16 : 0.05)} 58%, ${alpha(
                        theme.palette.background.paper,
                        0.92
                    )})`
                }}
            >
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
                    <Box sx={{ flexGrow: 1 }}>
                        <Typography variant='overline' sx={{ color: 'primary.main', fontWeight: 800, letterSpacing: '0.12em' }}>
                            Guided workflow optimization
                        </Typography>
                        <Typography variant='h3' sx={{ mt: 0.25, mb: 0.75, fontWeight: 700 }}>
                            One clear step at a time.
                        </Typography>
                        <Typography color='text.secondary' sx={{ maxWidth: 720 }}>
                            Complete the active step to advance automatically, or revisit any unlocked step from the progress bar.
                        </Typography>
                    </Box>
                    <Chip
                        icon={busy ? <CircularProgress size={14} /> : <IconSparkles size={15} />}
                        label={busy ? PHASE_LABELS[phase] || 'Working' : 'Auto-advance on'}
                        color={busy ? 'primary' : 'default'}
                        variant={busy ? 'filled' : 'outlined'}
                        sx={{ alignSelf: { xs: 'flex-start', md: 'center' }, bgcolor: busy ? undefined : 'background.paper' }}
                    />
                </Stack>
            </Box>

            <Box sx={{ px: { xs: 0, md: 2 }, mb: 2.5, overflowX: 'auto' }}>
                <Stepper nonLinear activeStep={stage} alternativeLabel sx={{ minWidth: 620 }}>
                    {STAGES.map((item, index) => (
                        <Step key={item.label} completed={completedStages[index]} disabled={index > maxUnlockedStage}>
                            <StepButton color='inherit' onClick={() => goToStage(index)} disabled={index > maxUnlockedStage || busy}>
                                <Typography variant='subtitle2' sx={{ fontWeight: index === stage ? 700 : 500 }}>
                                    {item.label}
                                </Typography>
                                <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                                    {item.caption}
                                </Typography>
                            </StepButton>
                        </Step>
                    ))}
                </Stepper>
            </Box>

            {error && (
                <Alert severity='error' sx={{ mb: 2, borderRadius: 2 }}>
                    {error}
                </Alert>
            )}
            {status && (
                <Alert
                    severity={busy ? 'info' : 'success'}
                    sx={{ mb: 2, borderRadius: 2 }}
                    icon={busy ? <CircularProgress size={16} /> : undefined}
                >
                    {status}
                </Alert>
            )}
            {busy && progress.total > 0 && (
                <Box sx={{ mb: 2.5, px: 0.5 }}>
                    <Stack direction='row' justifyContent='space-between' sx={{ mb: 0.75 }}>
                        <Typography variant='caption' color='text.secondary'>
                            Acceptance runs
                        </Typography>
                        <Typography variant='caption' color='text.secondary'>
                            {progress.current} / {progress.total}
                        </Typography>
                    </Stack>
                    <LinearProgress variant='determinate' value={progressValue} sx={{ height: 7, borderRadius: 20 }} />
                </Box>
            )}

            <Box sx={{ maxWidth: stage === 4 ? 1320 : 1120, mx: 'auto' }}>
                <Box sx={{ mb: 2.25 }}>
                    <Typography variant='overline' color='primary.main' sx={{ fontWeight: 800, letterSpacing: '0.1em' }}>
                        Step {stage + 1} of {STAGES.length} · {currentStage.eyebrow}
                    </Typography>
                    <Typography variant='h2' sx={{ mt: 0.25, mb: 0.75, fontSize: { xs: '1.55rem', md: '2rem' }, fontWeight: 700 }}>
                        {currentStage.title}
                    </Typography>
                    <Typography color='text.secondary' sx={{ maxWidth: 820, lineHeight: 1.65 }}>
                        {currentStage.description}
                    </Typography>
                </Box>

                {stage === 0 && (
                    <Box sx={panelSx}>
                        <Grid container>
                            <Grid item xs={12} md={7} sx={{ p: { xs: 2, md: 3 } }}>
                                <Typography variant='h5' sx={{ mb: 0.75 }}>
                                    Business objective
                                </Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                                    Include the desired output, decision rules, tools and the situations that require human review.
                                </Typography>
                                <TextField
                                    fullWidth
                                    multiline
                                    minRows={10}
                                    label='Describe the workflow'
                                    value={goal}
                                    disabled={busy}
                                    onChange={(event) => setGoal(event.target.value)}
                                />
                            </Grid>
                            <Grid
                                item
                                xs={12}
                                md={5}
                                sx={{
                                    p: { xs: 2, md: 3 },
                                    bgcolor: alpha(theme.palette.primary.main, 0.035),
                                    borderLeft: { md: `1px solid ${theme.palette.divider}` },
                                    borderTop: { xs: `1px solid ${theme.palette.divider}`, md: 0 }
                                }}
                            >
                                <Typography variant='h5' sx={{ mb: 0.75 }}>
                                    Models
                                </Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                                    The primary model designs and evaluates the workflow. A cheaper tier is optional during search.
                                </Typography>
                                <Stack spacing={2}>
                                    <StudioModelPicker value={selectedChatModel} onChange={setSelectedChatModel} disabled={busy} />
                                    <StudioModelPicker
                                        value={cheapChatModel}
                                        onChange={setCheapChatModel}
                                        disabled={busy}
                                        storageKey='workflowAutopilotCheapModel'
                                        label='Cheap tier model (optional)'
                                    />
                                    {modelProblems.length > 0 && (
                                        <Alert severity='warning'>Configure the model before generating: {modelProblems.join(', ')}.</Alert>
                                    )}
                                </Stack>
                            </Grid>
                        </Grid>
                        <Stack direction='row' justifyContent='flex-end' sx={footerSx}>
                            <Button
                                variant='contained'
                                size='large'
                                startIcon={<IconSparkles size={18} />}
                                disabled={busy || !goal.trim() || modelProblems.length > 0}
                                onClick={() => designWorkflow(selectedChatModel)}
                            >
                                {phase === 'design' ? 'Designing workflow…' : design ? 'Redesign workflow' : 'Design workflow'}
                            </Button>
                        </Stack>
                    </Box>
                )}

                {stage === 1 && design && (
                    <Box sx={panelSx}>
                        <Box sx={{ p: { xs: 2, md: 3 } }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 2.5 }}>
                                <Box sx={{ flexGrow: 1 }}>
                                    <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
                                        <Typography variant='h4'>{design.workflowName}</Typography>
                                        <Chip
                                            size='small'
                                            color={session.contractStatus === 'confirmed' ? 'success' : 'warning'}
                                            label={session.contractStatus === 'confirmed' ? 'Compiled' : 'Draft'}
                                        />
                                    </Stack>
                                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.75 }}>
                                        {design.summary}
                                    </Typography>
                                </Box>
                                <Button
                                    variant='outlined'
                                    startIcon={<IconRefresh size={16} />}
                                    disabled={busy}
                                    onClick={() => regenerateScenarios(selectedChatModel)}
                                >
                                    {phase === 'scenarios' ? 'Regenerating…' : 'Regenerate test world'}
                                </Button>
                            </Stack>

                            <Grid container spacing={2}>
                                <Grid item xs={12} md={6}>
                                    <TextField
                                        fullWidth
                                        multiline
                                        minRows={4}
                                        label='Success criteria · one per line'
                                        value={design.successCriteria.join('\n')}
                                        disabled={busy}
                                        onChange={(event) =>
                                            updateDesign((draft) => ({
                                                ...draft,
                                                successCriteria: event.target.value.split('\n').filter((line) => line.trim())
                                            }))
                                        }
                                    />
                                </Grid>
                                <Grid item xs={12} md={6}>
                                    <TextField
                                        fullWidth
                                        multiline
                                        minRows={4}
                                        label='Constraints · one per line'
                                        value={design.constraints.join('\n')}
                                        disabled={busy}
                                        onChange={(event) =>
                                            updateDesign((draft) => ({
                                                ...draft,
                                                constraints: event.target.value.split('\n').filter((line) => line.trim())
                                            }))
                                        }
                                    />
                                </Grid>
                            </Grid>

                            <Divider sx={{ my: 3 }} />
                            <Stack direction='row' justifyContent='space-between' alignItems='baseline' sx={{ mb: 1.25 }}>
                                <Typography variant='h4'>Simulated tool environment</Typography>
                                <Chip size='small' label={`${design.tools?.length || 0} tools`} variant='outlined' />
                            </Stack>
                            <ToolEnvironmentPanel
                                tools={design.tools}
                                disabled={busy}
                                onChange={(tools) => updateDesign((draft) => ({ ...draft, tools }))}
                            />

                            <Divider sx={{ my: 3 }} />
                            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent='space-between' spacing={1} sx={{ mb: 1.25 }}>
                                <Typography variant='h4'>Acceptance suite</Typography>
                                <Stack direction='row' spacing={1}>
                                    <Chip
                                        size='small'
                                        color='primary'
                                        variant='outlined'
                                        label={`${scenarioSplit.dev.length} development`}
                                    />
                                    <Chip size='small' variant='outlined' label={`${scenarioSplit.test.length} held out`} />
                                </Stack>
                            </Stack>
                            {design.coverageRationale && (
                                <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                                    {design.coverageRationale}
                                </Typography>
                            )}
                            <ScenarioPanel
                                scenarios={design.scenarios}
                                tools={design.tools}
                                disabled={busy}
                                onChange={(scenarios) => updateDesign((draft) => ({ ...draft, scenarios }))}
                            />
                        </Box>
                        <Stack direction='row' justifyContent='space-between' sx={footerSx}>
                            <Button disabled={busy} onClick={() => goToStage(0)}>
                                Back
                            </Button>
                            <Button variant='contained' disabled={busy} onClick={() => goToStage(2)}>
                                Confirm and review crew
                            </Button>
                        </Stack>
                    </Box>
                )}

                {stage === 2 && design && (
                    <Box sx={panelSx}>
                        <Box sx={{ p: { xs: 2, md: 3 } }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                                <Box sx={{ flexGrow: 1 }}>
                                    <Typography variant='h4'>Crew definition</Typography>
                                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                                        Inspect ownership, instructions and hand-offs before creating the executable baseline.
                                    </Typography>
                                </Box>
                                <Button
                                    variant={unappliedGuidance.length ? 'contained' : 'outlined'}
                                    startIcon={<IconRefresh size={16} />}
                                    disabled={busy}
                                    onClick={() => regenerateCrew(selectedChatModel)}
                                >
                                    {phase === 'crew' ? 'Redesigning…' : 'Redesign crew'}
                                </Button>
                            </Stack>
                            {unappliedGuidance.length > 0 && (
                                <Alert severity='warning' sx={{ mb: 2 }}>
                                    <Typography variant='subtitle2'>
                                        {unappliedGuidance.length} accepted{' '}
                                        {unappliedGuidance.length === 1 ? 'diagnosis is' : 'diagnoses are'} not in this crew yet
                                    </Typography>
                                    <Typography variant='body2' sx={{ mt: 0.5 }}>
                                        Redesign crew is what hands them to the designer. Compiling without it measures the unchanged crew
                                        against the edited acceptance suite.
                                    </Typography>
                                    <Box component='ul' sx={{ pl: 2.5, mt: 0.5, mb: 0 }}>
                                        {unappliedGuidance.map((item) => (
                                            <li key={item}>
                                                <Typography variant='caption'>{item}</Typography>
                                            </li>
                                        ))}
                                    </Box>
                                </Alert>
                            )}
                            {busy && phase !== 'compile' && (
                                <Alert severity='info' sx={{ mb: 2 }}>
                                    Editing is paused while Autopilot finishes the current action.
                                </Alert>
                            )}
                            <CrewPanel
                                crew={design.crew}
                                tools={design.tools}
                                validation={session.crewValidation}
                                disabled={busy}
                                onChange={(crew) => updateDesign((draft) => ({ ...draft, crew }))}
                            />
                            {trials[0]?.flowData && session.contractStatus === 'confirmed' && (
                                <Box sx={{ mt: 3 }}>
                                    <Divider sx={{ mb: 3 }} />
                                    <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
                                        <Typography variant='h4'>Compiled baseline graph</Typography>
                                        <Chip size='small' color='success' label='Ready' />
                                    </Stack>
                                    <CrewGraph flowData={trials[0].flowData} />
                                </Box>
                            )}
                        </Box>
                        <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} justifyContent='space-between' sx={footerSx}>
                            <Button disabled={busy} onClick={() => goToStage(1)}>
                                Back to contract
                            </Button>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                                {baselineReady && (
                                    <Button variant='outlined' disabled={busy} onClick={() => goToStage(3)}>
                                        Continue to search
                                    </Button>
                                )}
                                <Button
                                    variant='contained'
                                    size='large'
                                    startIcon={<IconWand size={18} />}
                                    disabled={busy || modelProblems.length > 0}
                                    onClick={compileBaselineWithGuidanceCheck}
                                >
                                    {phase === 'compile'
                                        ? 'Compiling baseline…'
                                        : baselineReady
                                        ? 'Recompile baseline'
                                        : 'Compile baseline'}
                                </Button>
                            </Stack>
                        </Stack>
                    </Box>
                )}

                {stage === 3 && design && baselineReady && (
                    <Box sx={panelSx}>
                        <Grid container>
                            <Grid item xs={12} md={7} sx={{ p: { xs: 2, md: 3 } }}>
                                <Typography variant='h4' sx={{ mb: 0.75 }}>
                                    Search strategy
                                </Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ mb: 2.5 }}>
                                    Control how broadly Autopilot explores the operator space. Higher rounds and candidate counts use more
                                    time and model calls.
                                </Typography>
                                <Stack spacing={2}>
                                    <TextField
                                        select
                                        label='Strategy'
                                        value={settings.strategy}
                                        disabled={busy}
                                        onChange={(event) => patchSettings({ strategy: event.target.value })}
                                        helperText={SEARCH_STRATEGIES.find((item) => item.id === settings.strategy)?.description}
                                    >
                                        {SEARCH_STRATEGIES.map((item) => (
                                            <MenuItem key={item.id} value={item.id}>
                                                {item.label}
                                            </MenuItem>
                                        ))}
                                    </TextField>
                                    <Grid container spacing={2}>
                                        <Grid item xs={12} sm={4}>
                                            <TextField
                                                fullWidth
                                                type='number'
                                                label='Rounds'
                                                value={settings.searchRounds}
                                                disabled={busy}
                                                onChange={(event) => patchSettings({ searchRounds: Number(event.target.value) })}
                                            />
                                        </Grid>
                                        <Grid item xs={12} sm={4}>
                                            <TextField
                                                fullWidth
                                                type='number'
                                                label='Candidates / round'
                                                value={settings.candidatesPerRound}
                                                disabled={busy}
                                                onChange={(event) => patchSettings({ candidatesPerRound: Number(event.target.value) })}
                                            />
                                        </Grid>
                                        <Grid item xs={12} sm={4}>
                                            <TextField
                                                fullWidth
                                                type='number'
                                                label='Seed'
                                                value={settings.seed}
                                                disabled={busy}
                                                onChange={(event) => patchSettings({ seed: Number(event.target.value) })}
                                            />
                                        </Grid>
                                    </Grid>
                                </Stack>
                            </Grid>
                            <Grid
                                item
                                xs={12}
                                md={5}
                                sx={{
                                    p: { xs: 2, md: 3 },
                                    bgcolor: alpha(theme.palette.primary.main, 0.035),
                                    borderLeft: { md: `1px solid ${theme.palette.divider}` },
                                    borderTop: { xs: `1px solid ${theme.palette.divider}`, md: 0 }
                                }}
                            >
                                <Typography variant='h4' sx={{ mb: 0.75 }}>
                                    Evaluation
                                </Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ mb: 2.5 }}>
                                    Define the acceptance gate and runtime pressure for each candidate.
                                </Typography>
                                <Stack spacing={2}>
                                    <TextField
                                        fullWidth
                                        type='number'
                                        label='Pass threshold'
                                        value={settings.acceptanceScoreThreshold}
                                        disabled={busy}
                                        onChange={(event) => patchSettings({ acceptanceScoreThreshold: Number(event.target.value) })}
                                    />
                                    <TextField
                                        fullWidth
                                        type='number'
                                        label='Concurrency'
                                        value={settings.concurrency}
                                        disabled={busy}
                                        onChange={(event) => patchSettings({ concurrency: Number(event.target.value) })}
                                    />
                                    <TextField
                                        select
                                        fullWidth
                                        label='Held-out evaluation'
                                        value={settings.runHeldOutSuite ? 'yes' : 'no'}
                                        disabled={busy}
                                        onChange={(event) => patchSettings({ runHeldOutSuite: event.target.value === 'yes' })}
                                        helperText='Measured once on the baseline and Pareto frontier.'
                                    >
                                        <MenuItem value='yes'>Run after search</MenuItem>
                                        <MenuItem value='no'>Skip</MenuItem>
                                    </TextField>
                                </Stack>
                            </Grid>
                        </Grid>
                        <Box sx={{ ...footerSx, textAlign: 'center' }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent='center' alignItems='center'>
                                <Button disabled={busy} onClick={() => goToStage(2)}>
                                    Back to crew
                                </Button>
                                <Button
                                    variant='contained'
                                    size='large'
                                    startIcon={<IconPlayerPlay size={18} />}
                                    disabled={busy || modelProblems.length > 0}
                                    onClick={() => runAutopilot(selectedChatModel, configuredCheapModel)}
                                >
                                    {phase === 'run'
                                        ? 'Running experiment…'
                                        : `Run baseline + ${settings.searchRounds} search round${
                                              Number(settings.searchRounds) === 1 ? '' : 's'
                                          }`}
                                </Button>
                            </Stack>
                            <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
                                Results open automatically when the run finishes. You can stop safely after the active calls complete.
                            </Typography>
                        </Box>
                    </Box>
                )}

                {stage === 4 && canViewResults && (
                    <Box sx={panelSx}>
                        <Box sx={{ p: { xs: 2, md: 3 } }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent='space-between' sx={{ mb: 2 }}>
                                <Box>
                                    <Typography variant='h4'>
                                        {showingArchive ? 'Previous experiment results' : 'Experiment results'}
                                    </Typography>
                                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                                        {shownRun.trials.length} crew{shownRun.trials.length === 1 ? '' : 's'} measured across development
                                        {settings.runHeldOutSuite ? ' and held-out' : ''} cases.
                                    </Typography>
                                </Box>
                                {!showingArchive && session.selectedTrialId && <Chip color='success' label='Recommendation ready' />}
                            </Stack>
                            {showingArchive && (
                                <Alert severity='warning' sx={{ mb: 2 }}>
                                    Measured against the acceptance suite as it stood before the recommendations were applied
                                    {archivedRun.scenarioCount ? ` (${archivedRun.scenarioCount} cases)` : ''}. The suite has changed since,
                                    so these scores are kept for comparison only — recompile the crew and run the suite again for current
                                    numbers.
                                </Alert>
                            )}
                            <TrialsPanel
                                trials={shownRun.trials}
                                paretoTrialIds={shownRun.paretoTrialIds}
                                selectedTrialId={shownRun.selectedTrialId}
                                diagnosis={shownRun.diagnosis}
                                recommendations={shownRun.recommendations}
                                onRecommendationStatus={setRecommendationStatus}
                                onApplyRecommendations={applyRecommendations}
                                busy={busy}
                            />
                        </Box>
                        <Stack
                            direction={{ xs: 'column-reverse', sm: 'row' }}
                            spacing={1}
                            justifyContent={showingArchive ? 'flex-start' : 'flex-end'}
                            sx={footerSx}
                        >
                            {showingArchive ? (
                                <Button onClick={() => goToStage(2)}>Back to crew</Button>
                            ) : (
                                // Every other step is reachable from the stepper above, so the
                                // only footer action left is the one the stepper cannot perform.
                                <Button variant='outlined' startIcon={<IconRefresh size={16} />} onClick={resetResults}>
                                    Reset results and keep baseline
                                </Button>
                            )}
                        </Stack>
                    </Box>
                )}
            </Box>
            <ConfirmDialog />
        </MainCard>
    )
}

export default WorkflowAutopilot
