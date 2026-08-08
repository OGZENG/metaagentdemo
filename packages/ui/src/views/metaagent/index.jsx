import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Box, Button, Chip, Divider, Grid, Stack, Step, StepLabel, Stepper, TextField, Typography } from '@mui/material'
import { IconActivity, IconArrowRight, IconSparkles } from '@tabler/icons-react'

import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import chatflowsApi from '@/api/chatflows'

const STORAGE_KEY = 'metaAgentCompilerDraft'

const initialDraft = {
    task: '',
    inputs: '',
    outputs: '',
    constraints: '',
    tools: '',
    humanCheckpoints: '',
    successCriteria: ''
}

const splitItems = (value) =>
    value
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean)

const buildCompilerPrompt = (draft) => {
    const lines = [
        'Build a production-oriented multi-agent Agentflow V2 for the following task.',
        '',
        `Primary task: ${draft.task.trim()}`,
        `Expected inputs: ${draft.inputs.trim() || 'Natural-language user request'}`,
        `Required outputs: ${draft.outputs.trim() || 'A validated final answer'}`,
        `Constraints: ${draft.constraints.trim() || 'Prefer deterministic, observable execution'}`,
        `Available or preferred tools: ${draft.tools.trim() || 'Choose only tools required by the task'}`,
        `Human checkpoints: ${draft.humanCheckpoints.trim() || 'Ask for approval before risky or irreversible actions'}`,
        `Success criteria: ${draft.successCriteria.trim() || 'The requested output is complete and schema-valid'}`,
        '',
        'Architecture requirements:',
        '- Use a supervisor/orchestrator when more than one specialist is required.',
        '- Give every specialist a narrow role and explicit responsibility.',
        '- Add validation before the final response.',
        '- Add Human Input nodes at the requested checkpoints.',
        '- Prefer parallel branches when tasks have no data dependency.',
        '- Keep shared state explicit and pass only the data each node needs.',
        '- Produce a minimal graph that is easy to debug in the sandbox.'
    ]
    return lines.join('\n')
}

const MetaAgentStudio = () => {
    const navigate = useNavigate()
    const [draft, setDraft] = useState(() => {
        try {
            return { ...initialDraft, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
        } catch {
            return initialDraft
        }
    })
    const [compiled, setCompiled] = useState(false)
    const [blueprint, setBlueprint] = useState(null)
    const [compiling, setCompiling] = useState(false)
    const [compileError, setCompileError] = useState('')

    const prompt = useMemo(() => buildCompilerPrompt(draft), [draft])
    const specialists = useMemo(() => {
        const toolRoles = splitItems(draft.tools).map((tool) => `${tool} specialist`)
        return ['Orchestrator', ...toolRoles, 'Output validator']
    }, [draft.tools])

    const update = (field) => (event) => {
        const next = { ...draft, [field]: event.target.value }
        setDraft(next)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        setCompiled(false)
    }

    const compileBlueprint = async () => {
        if (!draft.task.trim()) return
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
        setCompiling(true)
        setCompileError('')
        try {
            const response = await chatflowsApi.analyzeMetaAgentIntent(draft)
            setBlueprint(response.data)
            setCompiled(true)
        } catch (error) {
            setCompileError(error.response?.data?.message || 'Could not compile the intent contract.')
        } finally {
            setCompiling(false)
        }
    }

    const openGenerator = () => {
        localStorage.setItem('metaAgentCompilerPrompt', blueprint?.prompt || prompt)
        localStorage.setItem('metaAgentAutoOpenGenerator', 'true')
        navigate('/v2/agentcanvas')
    }

    return (
        <Box>
            <ViewHeader
                title='Meta-Agent Studio'
                description='Align intent, compile an AgentFlow, test it with HITL, then improve it from telemetry.'
            />
            <Stack spacing={3} sx={{ p: 3 }}>
                <MainCard>
                    <Stepper activeStep={compiled ? 1 : 0} alternativeLabel>
                        {['Intent alignment', 'Meta-agent compilation', 'Sandbox & HITL', 'Telemetry evolution'].map((label) => (
                            <Step key={label}>
                                <StepLabel>{label}</StepLabel>
                            </Step>
                        ))}
                    </Stepper>
                </MainCard>

                <Grid container spacing={3}>
                    <Grid item xs={12} lg={7}>
                        <MainCard title='1. Intent alignment'>
                            <Stack spacing={2}>
                                <TextField
                                    required
                                    label='What should the agent team accomplish?'
                                    value={draft.task}
                                    onChange={update('task')}
                                    multiline
                                    minRows={3}
                                    placeholder='Example: Plan a trip using live flight and hotel data and return clickable booking links.'
                                />
                                <Grid container spacing={2}>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            fullWidth
                                            label='Inputs'
                                            value={draft.inputs}
                                            onChange={update('inputs')}
                                            multiline
                                            minRows={2}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            fullWidth
                                            label='Required outputs'
                                            value={draft.outputs}
                                            onChange={update('outputs')}
                                            multiline
                                            minRows={2}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            fullWidth
                                            label='Constraints'
                                            value={draft.constraints}
                                            onChange={update('constraints')}
                                            multiline
                                            minRows={2}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            fullWidth
                                            label='Tools or APIs (comma separated)'
                                            value={draft.tools}
                                            onChange={update('tools')}
                                            multiline
                                            minRows={2}
                                        />
                                    </Grid>
                                </Grid>
                                <TextField
                                    label='Where must a human approve, edit, or reject?'
                                    value={draft.humanCheckpoints}
                                    onChange={update('humanCheckpoints')}
                                    multiline
                                    minRows={2}
                                />
                                <TextField
                                    label='How do we know the run succeeded?'
                                    value={draft.successCriteria}
                                    onChange={update('successCriteria')}
                                    multiline
                                    minRows={2}
                                />
                                <Box>
                                    <Button
                                        variant='contained'
                                        startIcon={<IconSparkles size={18} />}
                                        onClick={compileBlueprint}
                                        disabled={!draft.task.trim() || compiling}
                                    >
                                        {compiling ? 'Compiling…' : 'Compile blueprint'}
                                    </Button>
                                    {compileError && (
                                        <Alert severity='error' sx={{ mt: 2 }}>
                                            {compileError}
                                        </Alert>
                                    )}
                                </Box>
                            </Stack>
                        </MainCard>
                    </Grid>

                    <Grid item xs={12} lg={5}>
                        <MainCard title='2. Compilation blueprint'>
                            {!compiled ? (
                                <Alert severity='info'>Complete the task definition and compile it to review the proposed team.</Alert>
                            ) : (
                                <Stack spacing={2}>
                                    <Alert severity='success'>The intent has been converted into a deterministic compiler prompt.</Alert>
                                    <Box>
                                        <Typography variant='subtitle2' gutterBottom>
                                            Proposed roles
                                        </Typography>
                                        <Stack direction='row' gap={1} flexWrap='wrap'>
                                            {(blueprint?.roles || specialists).map((role) => (
                                                <Chip key={role} label={role} size='small' />
                                            ))}
                                        </Stack>
                                    </Box>
                                    <Divider />
                                    <TextField
                                        label='Auditable compiler prompt'
                                        value={blueprint?.prompt || prompt}
                                        multiline
                                        minRows={14}
                                        InputProps={{ readOnly: true }}
                                    />
                                    <Button variant='contained' endIcon={<IconArrowRight size={18} />} onClick={openGenerator}>
                                        Generate AgentFlow on canvas
                                    </Button>
                                </Stack>
                            )}
                        </MainCard>
                    </Grid>
                </Grid>

                <MainCard title='3–4. Sandbox and evolution loop'>
                    <Grid container spacing={2} alignItems='center'>
                        <Grid item xs={12} md={8}>
                            <Typography color='text.secondary'>
                                After generation, add Human Input nodes where approval is required. Run the flow in chat to pause, approve
                                or reject, and resume from its checkpoint. Execution history already records node state and timing for
                                bottleneck analysis.
                            </Typography>
                        </Grid>
                        <Grid item xs={12} md={4}>
                            <Button
                                fullWidth
                                variant='outlined'
                                startIcon={<IconActivity size={18} />}
                                onClick={() => navigate('/analytics')}
                            >
                                Open token analytics
                            </Button>
                        </Grid>
                    </Grid>
                </MainCard>
            </Stack>
        </Box>
    )
}

export default MetaAgentStudio
