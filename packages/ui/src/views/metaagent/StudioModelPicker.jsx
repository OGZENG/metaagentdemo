import { cloneDeep } from 'lodash'
import PropTypes from 'prop-types'
import { useEffect, useMemo, useState } from 'react'
import { Box, ButtonBase, Chip, Collapse, Divider, Stack, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconChevronDown, IconChevronUp, IconSettings } from '@tabler/icons-react'

import assistantsApi from '@/api/assistants'
import useApi from '@/hooks/useApi'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import { baseURL, FLOWISE_CREDENTIAL_ID } from '@/store/constant'
import { initNode, showHideInputParams } from '@/utils/genericHelper'
import DocStoreInputHandler from '@/views/docstore/DocStoreInputHandler'

const StudioModelPicker = ({
    value,
    onChange,
    disabled,
    storageKey = 'workflowAutopilotModel',
    label = 'Design, runtime and evaluator model'
}) => {
    const theme = useTheme()
    const getChatModelsApi = useApi(assistantsApi.getChatModels)
    const [components, setComponents] = useState([])
    const [expanded, setExpanded] = useState(false)

    useEffect(() => {
        getChatModelsApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!getChatModelsApi.data) return
        setComponents(getChatModelsApi.data)
        if (value && Object.keys(value).length) return
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || 'null')
            if (stored?.name && getChatModelsApi.data.some((component) => component.name === stored.name)) onChange(stored)
        } catch (_) {
            localStorage.removeItem(storageKey)
        }
    }, [getChatModelsApi.data, onChange, storageKey, value])

    const options = useMemo(
        () =>
            components.map((component) => ({
                label: component.label,
                name: component.name,
                imageSrc: `${baseURL}/api/v1/node-icon/${component.name}`
            })),
        [components]
    )

    const visibleInputParams = useMemo(
        () =>
            value && Object.keys(value).length
                ? showHideInputParams(value).filter((inputParam) => !inputParam.hidden && inputParam.display !== false)
                : [],
        [value]
    )

    const missingRequiredInputs = useMemo(
        () =>
            visibleInputParams.filter((inputParam) => {
                if (inputParam.optional) return false
                if (inputParam.type === 'credential') return !value?.credential && !value?.inputs?.[FLOWISE_CREDENTIAL_ID]
                return value?.inputs?.[inputParam.name] === undefined || value?.inputs?.[inputParam.name] === ''
            }),
        [value, visibleInputParams]
    )

    useEffect(() => {
        if (value?.name && missingRequiredInputs.length) setExpanded(true)
    }, [missingRequiredInputs.length, value?.name])

    const persist = (next) => {
        onChange(next)
        if (next && Object.keys(next).length) localStorage.setItem(storageKey, JSON.stringify(next))
        else localStorage.removeItem(storageKey)
    }

    const handleModelChange = (newValue) => {
        if (!newValue) {
            persist({})
            setExpanded(false)
            return
        }
        const component = components.find((candidate) => candidate.name === newValue)
        if (!component) return
        persist(initNode(cloneDeep(component), `${component.name}_${storageKey}`))
        setExpanded(true)
    }

    const handleInputChange = ({ inputParam, newValue }) => {
        const next = cloneDeep(value)
        next.inputs = next.inputs || {}
        if (inputParam.type === 'credential') {
            next.credential = newValue
            next.inputs[FLOWISE_CREDENTIAL_ID] = newValue
        } else next.inputs[inputParam.name] = newValue
        next.inputParams = showHideInputParams(next)
        persist(next)
    }

    return (
        <Box>
            <Typography variant='subtitle2' sx={{ mb: 0.75 }}>
                {label}
            </Typography>
            {/* Without `loading` the list renders "No options" while the fetch is
                still in flight, which reads as "there are no models". */}
            <Dropdown
                name={storageKey}
                options={options}
                onSelect={handleModelChange}
                value={value?.name || ''}
                disabled={disabled}
                loading={getChatModelsApi.loading}
            />
            {value && Object.keys(value).length > 0 && (
                <Box sx={{ mt: 1, border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2, overflow: 'hidden' }}>
                    <ButtonBase
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} settings`}
                        onClick={() => setExpanded((current) => !current)}
                        sx={{ width: '100%', px: 2, py: 1.25, justifyContent: 'flex-start', textAlign: 'left' }}
                    >
                        <Stack direction='row' spacing={1.25} alignItems='center' sx={{ width: '100%' }}>
                            <IconSettings size={18} color={theme.palette.text.secondary} />
                            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                                <Typography variant='subtitle2'>Model settings</Typography>
                                <Typography variant='caption' color='text.secondary' noWrap sx={{ display: 'block' }}>
                                    {value.inputs?.modelName || value.label || value.name}
                                </Typography>
                            </Box>
                            <Chip
                                size='small'
                                color={missingRequiredInputs.length ? 'warning' : 'success'}
                                variant='outlined'
                                label={missingRequiredInputs.length ? `${missingRequiredInputs.length} required` : 'Configured'}
                            />
                            {expanded ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
                        </Stack>
                    </ButtonBase>
                    <Collapse in={expanded} timeout='auto' unmountOnExit>
                        <Divider />
                        <Box>
                            {visibleInputParams.map((inputParam) => (
                                <DocStoreInputHandler
                                    key={inputParam.name}
                                    inputParam={inputParam}
                                    data={value}
                                    disabled={disabled}
                                    onNodeDataChange={handleInputChange}
                                />
                            ))}
                        </Box>
                    </Collapse>
                </Box>
            )}
        </Box>
    )
}

StudioModelPicker.propTypes = {
    value: PropTypes.object,
    onChange: PropTypes.func.isRequired,
    disabled: PropTypes.bool,
    storageKey: PropTypes.string,
    label: PropTypes.string
}

export default StudioModelPicker
