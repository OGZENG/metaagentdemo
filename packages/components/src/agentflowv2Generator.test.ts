import { extractAgentflowGeneratorJSON } from './agentflowv2Generator'

describe('extractAgentflowGeneratorJSON', () => {
    it('accepts a top-level tool array', () => {
        expect(extractAgentflowGeneratorJSON('["sequentialThinkingMCP", "jiraTool"]')).toEqual(['sequentialThinkingMCP', 'jiraTool'])
    })

    it('accepts fenced JSON with CRLF line endings', () => {
        expect(extractAgentflowGeneratorJSON('```json\r\n["agentAsTool"]\r\n```')).toEqual(['agentAsTool'])
    })

    it('extracts a complete nested object from surrounding prose', () => {
        expect(extractAgentflowGeneratorJSON('Result: {"nodes":[{"data":{"name":"llmAgentflow"}}],"edges":[]} done')).toEqual({
            nodes: [{ data: { name: 'llmAgentflow' } }],
            edges: []
        })
    })
})
