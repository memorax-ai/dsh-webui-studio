import { describe, expect, it } from 'vitest'
import { agentQueueItems, buildAgentConversation, type StudioConversationEntry } from './agent-conversation'

function entry(event: Record<string, unknown>, view?: StudioConversationEntry['view']): StudioConversationEntry {
  return { event, ...(view === undefined ? {} : { view }) } as unknown as StudioConversationEntry
}

describe('buildAgentConversation', () => {
  it('separates direct prompts, injected context, reasoning, and assistant text', () => {
    const items = buildAgentConversation([
      entry({ type: 'user/message', seq: 1, time: 10, surfaceOp: 'append', data: {
        content: [{ type: 'text', text: 'Change the title' }], source: { kind: 'user' },
      } }),
      entry({ type: 'user/message', seq: 2, time: 11, surfaceOp: 'append', data: {
        content: [{ type: 'text', text: 'Draft context' }], source: { kind: 'plugin', plugin: 'dsh-webui-studio', form: 'snapshot', sections: [] },
      } }),
      entry({ type: 'assistant/message', seq: 3, time: 12, surfaceOp: 'append', data: {
        message: { content: [{ type: 'reasoning', text: 'Inspect first' }, { type: 'text', text: 'I found it.' }] },
      } }),
    ])

    expect(items).toMatchObject([
      { kind: 'user', blocks: [{ kind: 'text', text: 'Change the title' }] },
      { kind: 'context', label: 'dsh-webui-studio' },
      { kind: 'assistant', blocks: [{ kind: 'reasoning', text: 'Inspect first' }, { kind: 'text', text: 'I found it.' }] },
    ])
  })

  it('pairs tool calls with their result and keeps host presentation views', () => {
    const items = buildAgentConversation([
      entry({ type: 'tool/call', seq: 4, time: 20, data: {
        turn: 1, step: 1, callId: 'call-1', name: 'studio_build_and_reload', arguments: '{"draftId":"draft-1"}',
      } }, { for: 'call', view: { card: 'generic', title: 'Build and reload Draft', kind: 'execute' } }),
      entry({ type: 'tool/result', seq: 5, time: 21, surfaceOp: 'append', data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'Build passed' }] }],
        },
      } }, { for: 'result', view: { card: 'generic', title: 'Draft reloaded', content: [{ type: 'text', text: 'Build passed' }] } }),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'tool',
      callId: 'call-1',
      status: 'done',
      callView: { title: 'Build and reload Draft' },
      resultView: { title: 'Draft reloaded' },
      result: [{ kind: 'text', text: 'Build passed' }],
    })
  })

  it('surfaces failed turns without duplicating completed boundaries', () => {
    const items = buildAgentConversation([
      entry({ type: 'turn/end', seq: 6, time: 30, data: { turn: 1, reason: { kind: 'completed' } } }),
      entry({ type: 'turn/end', seq: 7, time: 31, data: {
        turn: 2, reason: { kind: 'error', error: { code: 'MODEL_ERROR', message: 'Provider unavailable' } },
      } }),
    ])

    expect(items).toEqual([{ id: '7', kind: 'notice', time: 31, tone: 'error', text: 'Provider unavailable' }])
  })

  it('keeps Studio-authored fallbacks semantic so the renderer can localize them', () => {
    const items = buildAgentConversation([
      entry({ type: 'user/message', seq: 8, time: 32, surfaceOp: 'append', data: {
        content: [{ type: 'text', text: 'Injected context' }], source: { kind: 'plugin', form: 'snapshot', sections: [] },
      } }),
      entry({ type: 'turn/end', seq: 9, time: 33, data: { turn: 3, reason: { kind: 'max-tokens' } } }),
    ])

    expect(items).toEqual([
      { id: '8', kind: 'context', time: 32, blocks: [{ kind: 'text', text: 'Injected context' }] },
      { id: '9', kind: 'notice', time: 33, tone: 'neutral', reason: 'max-output' },
    ])
  })

  it('does not render model-only replacement copies on the human transcript', () => {
    const items = buildAgentConversation([
      entry({ type: 'user/message', seq: 11, time: 50, surfaceOp: 'append', data: {
        content: [{ type: 'text', text: 'Original prompt' }], source: { kind: 'user' },
      } }),
      entry({ type: 'user/message', seq: 12, time: 51, surfaceOp: { op: 'replace', start: 11, end: 11 }, data: {
        content: [{ type: 'text', text: 'Model-only compacted copy' }], source: { kind: 'user' },
      } }),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'user', blocks: [{ text: 'Original prompt' }] })
  })

  it('keeps queue placement while hiding unclaimed context', () => {
    expect(agentQueueItems([
      { id: 'q1', placement: 'queued', message: { content: [{ type: 'text', text: 'After this turn' }] } },
      { id: 'q2', placement: 'steering', message: { content: [{ type: 'text', text: 'Use the selected element' }] } },
      { id: 'q3', placement: 'context', message: { content: [{ type: 'text', text: 'Internal context' }] } },
      { id: 'q4', placement: 'queued', message: { content: [{ type: 'image', data: 'ignored by the renderer' }] } },
      { id: 'q5', placement: 'steering', message: { content: [{ type: 'text', text: 'Compare this' }, { type: 'image', data: 'ignored by the renderer' }] } },
    ])).toEqual([
      { id: 'q1', placement: 'queued', text: 'After this turn', imageCount: 0 },
      { id: 'q2', placement: 'steering', text: 'Use the selected element', imageCount: 0 },
      { id: 'q4', placement: 'queued', text: '', imageCount: 1 },
      { id: 'q5', placement: 'steering', text: 'Compare this', imageCount: 1 },
    ])
  })
})
