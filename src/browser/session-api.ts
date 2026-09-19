import type { BrowserPeerClient, RemoteEventRequest } from 'the-binding-of-dsh/browser-peer'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelCatalog, SessionControlFrame, SessionFollowFrame, SessionPage, SessionPromptRequest, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { expandAssistantStream, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StudioServerRequest } from '../contracts'
import type { ClientResponse, HistoryEntry, ModelSelection, RpcResponse, SessionModels, SessionProjectionsBlock } from './session-types'

type Listener = (event: StudioServerRequest<Record<string, unknown>>) => void
type Snapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>
type Peer = Pick<BrowserPeerClient, 'connect' | 'close' | 'connected' | 'stream' | 'subscribe' | 'handleEvent' | 'onState' | 'remote'>
type Pending = { resolve(value: unknown): void; reject(error: unknown): void }

/** Studio's presentation adapter over Gateway RPC, control and per-Session journals. */
export class StudioSessionApi {
  private readonly listeners = new Set<Listener>()
  private readonly pending = new Map<string, Pending>()
  private readonly snapshots = new Map<string, Snapshot>()
  private watchedSession?: string
  private lifetime?: AbortController
  private following?: AbortController
  private generation?: AbortController
  private closing?: Promise<void>
  private readonly projectionVersions = new Map<string, number>()
  private readonly peer: Peer
  constructor(peer: Peer) { this.peer = peer }

  private emit(payload: Record<string, unknown>, rpcId = crypto.randomUUID() as string): void {
    for (const listener of this.listeners) listener({ type: 'server-request', rpcId, method: 'studio.event', payload })
  }
  private async invoke<T>(method: string, ...args: unknown[]): Promise<RpcResponse<T>> {
    await this.closing
    await this.peer.connect()
    const remote = this.peer.remote as unknown as { session: Record<string, (...args: unknown[]) => Promise<RpcResponse<T>['result']>> }
    const call = remote.session[method]
    if (call === undefined) throw new Error(`Session method unavailable: ${method}`)
    return { result: await call(...args) }
  }

  readonly sessions = {
    list: (request: object): Promise<RpcResponse<{ items: readonly SessionSummary[] }>> => this.invoke('list', request),
    rename: (request: { sessionId: SessionId; title: string }): Promise<RpcResponse<unknown>> => this.invoke('rename', request),
    cancel: (request: { sessionId: SessionId }): Promise<RpcResponse<unknown>> => this.invoke('cancel', request),
    selectModel: (request: ModelSelection & { sessionId: SessionId }): Promise<RpcResponse<{ selected: ModelSelection }>> => this.invoke('selectModel', request),
    prompt: (request: Omit<SessionPromptRequest, 'requestId'>): Promise<RpcResponse<unknown>> => this.invoke('prompt', { ...request, requestId: crypto.randomUUID() }),
    history: async (request: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean; projections?: SessionProjectionsBlock }>> => {
      const opening = this.snapshots.get(request.sessionId) ?? await this.readOpening(request.sessionId)
      if (request.beforeSeq === undefined) return { result: { ok: true, value: this.historyValue(opening) } }
      const response = await this.invoke<SessionPage>('page', {
        address: { kind: 'session', sessionId: request.sessionId }, throughSeq: opening.cursor,
        beforeSeq: request.beforeSeq, maxMessages: request.maxMessages ?? 50,
      })
      return { result: response.result.ok ? { ok: true, value: { events: this.entries(response.result.value.records), hasMore: response.result.value.hasMore } } : response.result }
    },
    models: async ({ sessionId }: { sessionId: SessionId }): Promise<RpcResponse<SessionModels>> => {
      const [response, opening] = await Promise.all([this.invoke<ModelCatalog>('modelCatalog'), this.readOpening(sessionId)])
      if (!response.result.ok) return { result: response.result }
      const catalog = response.result.value
      const selection = opening.projections.values.modelSelection
      const current = selection?.next ?? selection?.lastUsed ?? catalog.default
      return { result: { ok: true, value: { current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures } } }
    },
  }

  private entries(records: Snapshot['records']): HistoryEntry[] {
    return records.map(record => ({ event: record.event as unknown as HistoryEntry['event'] }))
  }
  private historyValue(opening: Snapshot) {
    return { events: this.entries(opening.records), hasMore: opening.hasMore, projections: opening.projections }
  }
  private async readOpening(sessionId: string): Promise<Snapshot> {
    const signal = AbortSignal.timeout(15_000)
    await this.closing
    await this.peer.connect(signal)
    for await (const raw of this.peer.stream('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } } }, signal)) {
      const frame = raw as SessionFollowFrame
      if (frame.type !== 'snapshot') throw new Error('Session follow omitted its opening snapshot')
      return frame
    }
    throw new Error('Session follow ended before its opening snapshot')
  }

  watchSession(sessionId: string): () => void {
    for (const pending of this.pending.values()) pending.resolve(undefined)
    this.pending.clear()
    this.watchedSession = sessionId
    this.following?.abort()
    if (this.generation !== undefined) this.startFollowing(this.generation.signal)
    return () => {
      if (this.watchedSession !== sessionId) return
      this.watchedSession = undefined
      this.following?.abort()
      for (const pending of this.pending.values()) pending.resolve(undefined)
      this.pending.clear()
    }
  }
  async respond(response: ClientResponse): Promise<{ accepted: boolean; reason?: string }> {
    const pending = this.pending.get(response.rpcId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (!response.result.ok) pending.reject(new Error(response.result.error.message))
    else {
      const value = response.result.value as { outcome?: string; answer?: unknown }
      pending.resolve(value.outcome ?? value.answer)
    }
    this.pending.delete(response.rpcId)
    return { accepted: true }
  }
  private async interaction(kind: 'approval' | 'question', event: RemoteEventRequest): Promise<unknown> {
    if (event.agentId !== this.watchedSession) return undefined
    const { eventId, agentId, request, signal } = event
    if (signal.aborted) return undefined
    const abort = (): void => this.pending.get(eventId)?.reject(signal.reason)
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(eventId, { resolve, reject })
        signal.addEventListener('abort', abort, { once: true })
        this.emit({ ...request, type: `${kind}/requested`, sessionId: agentId, ...(kind === 'approval' ? { approvalId: eventId } : {}) }, eventId)
      })
    } finally {
      signal.removeEventListener('abort', abort)
      this.pending.delete(eventId)
      this.emit({ type: `${kind}/resolved`, sessionId: agentId, approvalId: eventId, questionRpcId: eventId }, eventId)
    }
  }

  start(listener: Listener, onState?: (connected: boolean) => void): () => void {
    if (this.lifetime !== undefined) throw new Error('Studio event subscription already active')
    const lifetime = this.lifetime = new AbortController()
    this.listeners.add(listener)
    const stops = [
      this.peer.subscribe('api-session/added', summary => this.emit({ ...(summary as object), type: 'host/session-added' })),
      this.peer.subscribe('api-session/removed', sessionId => this.emit({ type: 'host/session-removed', sessionId })),
      this.peer.subscribe('api-session/status', (sessionId, running) => this.emit({ type: 'host/session-status', sessionId, running })),
      this.peer.subscribe('api-session/error', (sessionId, message) => this.emit({ type: 'host/agent-error', sessionId, message })),
      this.peer.handleEvent('approval/request', event => this.interaction('approval', event)),
      this.peer.handleEvent('user-questions/request', event => this.interaction('question', event)),
      this.peer.onState(connected => {
        this.generation?.abort()
        this.generation = undefined
        this.snapshots.clear()
        this.projectionVersions.clear()
        if (connected) {
          const generation = this.generation = new AbortController()
          const signal = AbortSignal.any([generation.signal, lifetime.signal])
          void this.control(signal).catch(error => this.streamFailed(error, signal))
          this.startFollowing(signal)
        }
        onState?.(connected)
      }),
    ]
    void (async () => {
      while (!lifetime.signal.aborted) {
        try { await this.closing; if (!lifetime.signal.aborted) await this.peer.connect(lifetime.signal) } catch { onState?.(false) }
        await new Promise<void>(resolve => {
          if (lifetime.signal.aborted) { resolve(); return }
          const finish = (): void => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, 1_000)
          lifetime.signal.addEventListener('abort', finish, { once: true })
        })
      }
    })()
    return () => {
      lifetime.abort()
      this.generation?.abort()
      this.following?.abort()
      this.lifetime = undefined
      stops.forEach(stop => stop())
      this.listeners.delete(listener)
      for (const pending of this.pending.values()) pending.resolve(undefined)
      this.pending.clear()
      void this.closePeer()
    }
  }
  private closePeer(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const closing = this.peer.close().finally(() => { if (this.closing === closing) this.closing = undefined })
    this.closing = closing
    return closing
  }
  private streamFailed(error: unknown, signal: AbortSignal): void {
    if (signal.aborted) return
    this.emit({ type: 'stream/error', error: { message: error instanceof Error ? error.message : String(error) } })
    void this.closePeer()
  }
  private projection(sessionId: string, key: string, value: unknown, seq: number): void {
    const identity = JSON.stringify([sessionId, key])
    if (seq < (this.projectionVersions.get(identity) ?? -1)) return
    this.projectionVersions.set(identity, seq)
    this.emit({ type: 'session/projection', sessionId, key, value, seq })
    if (key !== 'inbox' || typeof value !== 'object' || value === null) return
    const inbox = value as Record<string, unknown>
    const items = (['next-turn', 'next-step'] as const).flatMap(target => {
      const messages = inbox[target]
      return Array.isArray(messages) ? messages.map(message => ({ id: message.id, message, placement: target === 'next-turn' ? 'queued' : 'steering' })) : []
    })
    this.emit({ type: 'session/queue', sessionId, items })
  }
  private async control(signal: AbortSignal): Promise<void> {
    for await (const raw of this.peer.stream('session/control', { args: {} }, signal)) {
      const frame = raw as SessionControlFrame
      if (frame.type === 'baseline') {
        for (const [sessionId, block] of Object.entries(frame.value.projections)) {
          for (const [key, value] of Object.entries(block.values)) this.projection(sessionId, key, value, block.asOfSeq)
        }
      } else if (frame.type === 'projection') this.projection(frame.sessionId, frame.key, frame.value, frame.seq)
    }
    if (!signal.aborted) throw new Error('Session control stream ended')
  }
  private startFollowing(parent: AbortSignal): void {
    const sessionId = this.watchedSession
    if (sessionId === undefined) return
    this.following?.abort()
    const following = this.following = new AbortController()
    const signal = AbortSignal.any([parent, following.signal])
    void this.follow(sessionId, signal).catch(error => this.streamFailed(error, signal))
  }
  private async follow(sessionId: string, signal: AbortSignal): Promise<void> {
    let cursor = -1, index = 0
    let revision: number | undefined, attempt: string | undefined
    let text = '', reasoning = ''
    const chunk = (value: unknown): void => {
      const part = value as { type?: string; text?: string }
      if (typeof part.text === 'string') {
        if (part.type === 'text-delta') text += part.text
        if (part.type === 'reasoning-delta') reasoning += part.text
      }
      this.emit({ type: 'session/streaming', sessionId, text, reasoning })
    }
    const clear = (): void => { text = ''; reasoning = ''; this.emit({ type: 'session/streaming', sessionId, text, reasoning }) }
    for await (const raw of this.peer.stream('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true } } }, signal)) {
      const frame = raw as SessionFollowFrame
      if (frame.type === 'snapshot') {
        cursor = frame.cursor
        this.snapshots.set(sessionId, frame)
        this.emit({ type: 'session/snapshot', sessionId, ...this.historyValue(frame) })
        for (const [key, value] of Object.entries(frame.projections.values)) this.projection(sessionId, key, value, frame.projections.asOfSeq)
        clear()
        revision = frame.assistantStream?.revision
        const active = frame.assistantStream?.activeAttempt
        attempt = active?.attemptId
        index = active?.nextIndex ?? 0
        if (active !== undefined) for (const member of expandAssistantStream(active.stream as readonly AssistantStreamRecord[])) chunk(member.chunk)
      } else if (frame.type === 'event') {
        if (frame.event.seq !== cursor + 1) throw new Error('Session journal sequence gap')
        cursor = frame.event.seq
        this.emit({ type: 'session/event', sessionId, event: frame.event })
        if (frame.event.type === 'assistant/message' || frame.event.type === 'assistant/attempt') clear()
      } else if (frame.type === 'assistant-stream') {
        const update = frame.frame
        if (revision === undefined || update.revision !== revision + 1) throw new Error('Assistant stream revision gap')
        revision = update.revision
        if (update.type === 'start') { attempt = update.attemptId; index = 0; clear() }
        else {
          if (update.attemptId !== attempt || update.index !== index) throw new Error('Assistant stream attempt/index mismatch')
          if (update.type === 'chunk') { index++; chunk(update.chunk) }
          else { attempt = undefined; if (update.outcome.kind === 'abandoned' || update.outcome.seq <= cursor) clear() }
        }
      }
    }
    if (!signal.aborted) throw new Error('Session journal ended')
  }
}
