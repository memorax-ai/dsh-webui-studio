import type { HistoryEntry, ToolCallView, ToolResultView } from './session-types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

export type StudioConversationEntry = HistoryEntry

export interface AgentStreamingContent {
  reasoning: string
  text: string
}

export interface AgentQueueItem {
  id: string
  placement: 'queued' | 'steering'
  text: string
  imageCount: number
}

export type AgentContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image' }

interface AgentConversationBase {
  id: string
  time: number
}

export type AgentConversationItem =
  | AgentConversationBase & {
      kind: 'user'
      blocks: AgentContentBlock[]
    }
  | AgentConversationBase & {
      kind: 'assistant'
      blocks: AgentContentBlock[]
      interrupted: boolean
    }
  | AgentConversationBase & {
      kind: 'context'
      label?: string
      summary?: string
      blocks: AgentContentBlock[]
    }
  | AgentConversationBase & {
      kind: 'tool'
      callId: string
      name: string
      arguments: string
      callView?: ToolCallView
      resultView?: ToolResultView
      result: AgentContentBlock[]
      status: 'running' | 'done' | 'error'
    }
  | AgentConversationBase & {
      kind: 'notice'
      tone: 'neutral' | 'error'
      text?: string
      reason?: 'max-output'
    }

interface ContentRecord {
  type?: unknown
  text?: unknown
}

function contentBlocks(value: unknown): AgentContentBlock[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<AgentContentBlock>(block => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as ContentRecord
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text !== '') {
      return [{ kind: 'text' as const, text: candidate.text }]
    }
    if (candidate.type === 'reasoning' && typeof candidate.text === 'string' && candidate.text !== '') {
      return [{ kind: 'reasoning' as const, text: candidate.text }]
    }
    if (candidate.type === 'image') return [{ kind: 'image' as const }]
    return []
  })
}

function contextLabel(source: unknown): { label?: string; summary?: string } {
  if (typeof source !== 'object' || source === null) return {}
  const value = source as { kind?: unknown; plugin?: unknown; summary?: unknown }
  return {
    label: typeof value.plugin === 'string' && value.plugin !== '' ? value.plugin : undefined,
    summary: typeof value.summary === 'string' && value.summary !== '' ? value.summary : undefined,
  }
}

function resultContent(entry: StudioConversationEntry): AgentContentBlock[] {
  if (entry.event.type !== 'tool/result') return []
  const block = entry.event.data.message.content[0]
  return block?.type === 'tool-result' ? contentBlocks(block.content) : []
}

function toolResultCallId(entry: StudioConversationEntry): string | undefined {
  if (entry.event.type !== 'tool/result') return undefined
  const source = entry.event.data.message.source
  if (source.kind === 'tool') return String(source.callId)
  const block = entry.event.data.message.content[0]
  return block?.type === 'tool-result' ? String(block.toolCallId) : undefined
}

function toolResultFailed(entry: StudioConversationEntry): boolean {
  if (entry.event.type !== 'tool/result') return false
  const block = entry.event.data.message.content[0]
  return entry.event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true)
}

export function buildAgentConversation(entries: readonly StudioConversationEntry[]): AgentConversationItem[] {
  const items: AgentConversationItem[] = []
  const tools = new Map<string, number>()

  for (const entry of entries) {
    const { event } = entry
    if (event.type === 'user/message') {
      if (!isAppendSurfaceEvent(event)) continue
      const blocks = contentBlocks(event.data.content)
      if (blocks.length === 0) continue
      if (event.data.source.kind === 'user') {
        items.push({ id: String(event.seq), kind: 'user', time: event.time, blocks })
      } else {
        const context = contextLabel(event.data.source)
        items.push({ id: String(event.seq), kind: 'context', time: event.time, blocks, ...context })
      }
      continue
    }

    if (event.type === 'assistant/message') {
      if (!isAppendSurfaceEvent(event)) continue
      const blocks = contentBlocks(event.data.message.content)
      if (blocks.length > 0) {
        items.push({
          id: String(event.seq),
          kind: 'assistant',
          time: event.time,
          blocks,
          interrupted: event.data.interrupted === true,
        })
      }
      continue
    }

    if (event.type === 'tool/call') {
      const callId = String(event.data.callId)
      tools.set(callId, items.length)
      items.push({
        id: String(event.seq),
        kind: 'tool',
        time: event.time,
        callId,
        name: event.data.name,
        arguments: event.data.arguments,
        callView: entry.view?.for === 'call' ? entry.view.view : undefined,
        result: [],
        status: 'running',
      })
      continue
    }

    if (event.type === 'tool/result') {
      if (!isAppendSurfaceEvent(event)) continue
      const callId = toolResultCallId(entry)
      if (callId === undefined) continue
      const index = tools.get(callId)
      const resultView = entry.view?.for === 'result' ? entry.view.view : undefined
      const status = toolResultFailed(entry) ? 'error' : 'done'
      if (index !== undefined) {
        const current = items[index]
        if (current?.kind === 'tool') items[index] = { ...current, result: resultContent(entry), resultView, status }
      } else {
        tools.set(callId, items.length)
        items.push({
          id: String(event.seq),
          kind: 'tool',
          time: event.time,
          callId,
          name: callId,
          arguments: '',
          result: resultContent(entry),
          resultView,
          status,
        })
      }
      continue
    }

    if (event.type === 'turn/end') {
      const reason = event.data.reason
      if (reason.kind === 'error') {
        items.push({ id: String(event.seq), kind: 'notice', time: event.time, tone: 'error', text: reason.error.message })
      } else if (reason.kind === 'max-tokens') {
        items.push({ id: String(event.seq), kind: 'notice', time: event.time, tone: 'neutral', reason: 'max-output' })
      }
    }
  }

  return items
}

export function agentQueueItems(value: unknown): AgentQueueItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<AgentQueueItem>(item => {
    if (typeof item !== 'object' || item === null) return []
    const candidate = item as { id?: unknown; placement?: unknown; message?: { content?: unknown } }
    if ((candidate.placement !== 'queued' && candidate.placement !== 'steering') || typeof candidate.id !== 'string') return []
    const content = promptContent(candidate.message?.content)
    return content.text === '' && content.imageCount === 0
      ? []
      : [{ id: candidate.id, placement: candidate.placement, ...content }]
  })
}

function promptContent(value: unknown): { text: string; imageCount: number } {
  const blocks = contentBlocks(value)
  return {
    text: blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n'),
    imageCount: blocks.filter(block => block.kind === 'image').length,
  }
}
