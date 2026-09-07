import PropTypes from 'prop-types'
import ReactFlow, { Background, Controls } from 'reactflow'
import 'reactflow/dist/style.css'
import { Alert, Box, Chip, Stack, Typography } from '@mui/material'

import { readFlowData } from '../studioUtils'

const NODE_STYLE = {
    startAgentflow: { border: '#7e8fa6', background: '#f2f5f9' },
    conditionAgentAgentflow: { border: '#ff8fab', background: '#fff2f5' },
    agentAgentflow: { border: '#26a69a', background: '#e6f6f4' },
    llmAgentflow: { border: '#42a5f5', background: '#f0f7ff' },
    directReplyAgentflow: { border: '#7e8fa6', background: '#f2f5f9' }
}

const nodeLabel = (node) => node?.data?.label || node?.data?.name || node?.id || 'Node'

const toolCount = (node) => (node?.data?.inputs?.agentTools || []).length

/**
 * Read-only view of a compiled crew. When a baseline graph is supplied, nodes
 * that only exist in this graph are highlighted so an operator's effect on the
 * topology is visible at a glance.
 */
const CrewGraph = ({ flowData, baselineFlowData, height = 320 }) => {
    const graph = readFlowData(flowData)
    const baseline = readFlowData(baselineFlowData)
    const baselineIds = new Set((baseline.nodes || []).map((node) => node.id))
    const currentIds = new Set((graph.nodes || []).map((node) => node.id))
    const removed = (baseline.nodes || []).filter((node) => !currentIds.has(node.id)).map(nodeLabel)

    const nodes = (graph.nodes || []).map((node) => {
        const added = baselineIds.size > 0 && !baselineIds.has(node.id)
        const palette = NODE_STYLE[node?.data?.name] || NODE_STYLE.llmAgentflow
        const tools = toolCount(node)
        return {
            id: node.id,
            type: 'default',
            position: node.position || { x: 0, y: 0 },
            data: { label: `${nodeLabel(node)}${tools ? ` · ${tools} tool${tools > 1 ? 's' : ''}` : ''}` },
            style: {
                width: 210,
                border: `2px solid ${added ? '#00c853' : palette.border}`,
                background: added ? '#e8f5e9' : palette.background,
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 12
            }
        }
    })

    const edges = (graph.edges || []).map((edge, index) => ({
        ...edge,
        id: edge.id || `crew-edge-${index}`,
        label: edge.data?.edgeLabel ? `route ${edge.data.edgeLabel}` : undefined,
        animated: false,
        style: { stroke: '#8fb8dd', strokeWidth: 2 }
    }))

    if (!nodes.length) return <Alert severity='warning'>No compiled graph is available for this trial.</Alert>

    return (
        <Box>
            <Box sx={{ height, border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden', bgcolor: '#fafcff' }}>
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    fitView
                    fitViewOptions={{ padding: 0.25 }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    panOnDrag
                    zoomOnScroll
                    preventScrolling={false}
                    proOptions={{ hideAttribution: true }}
                >
                    <Background gap={18} size={1} color='#dbe5ef' />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </Box>
            {baselineIds.size > 0 && (
                <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap sx={{ mt: 1 }}>
                    <Chip size='small' label='Green = added by this operator' color='success' variant='outlined' />
                    {removed.map((label) => (
                        <Chip key={label} size='small' label={`Removed: ${label}`} color='error' variant='outlined' />
                    ))}
                    {!removed.length && (
                        <Typography variant='caption' color='text.secondary'>
                            No node was removed.
                        </Typography>
                    )}
                </Stack>
            )}
        </Box>
    )
}

CrewGraph.propTypes = {
    flowData: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    baselineFlowData: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    height: PropTypes.number
}

export default CrewGraph
