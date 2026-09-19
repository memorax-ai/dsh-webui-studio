import { describe, expect, it } from 'vitest'
import type { BrowserPeerClient, RemoteEventRequest } from 'the-binding-of-dsh/browser-peer'
import { StudioSessionApi } from './session-api'

class Feed {
  values: unknown[] = []
  wake?: () => void
  push(value: unknown) { this.values.push(value); this.wake?.() }
  async *read(signal: AbortSignal) {
    while (!signal.aborted) {
      if (this.values.length) { yield this.values.shift(); continue }
      await new Promise<void>(resolve => {
        const done = () => { signal.removeEventListener('abort', done); this.wake = undefined; resolve() }
        this.wake = done
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
  }
}
class Peer {
  connected = false
  states = new Set<(connected: boolean) => void>()
  handlers = new Map<string, (event: RemoteEventRequest) => unknown>()
  feeds: { endpoint: string; signal: AbortSignal; feed: Feed; payload: unknown }[] = []
  remote = {}
  async connect() { if (!this.connected) { this.connected = true; this.states.forEach(fn => fn(true)) } }
  async close() { if (this.connected) { this.connected = false; this.states.forEach(fn => fn(false)) } }
  subscribe() { return () => {} }
  onState(fn: (connected: boolean) => void) { this.states.add(fn); fn(this.connected); return () => { this.states.delete(fn) } }
  handleEvent(name: string, handler: (event: RemoteEventRequest) => unknown) {
    this.handlers.set(name, handler); return () => { this.handlers.delete(name) }
  }
  stream(endpoint: string, payload: unknown, signal: AbortSignal) {
    const feed = new Feed(); this.feeds.push({ endpoint, payload, signal, feed }); return feed.read(signal)
  }
  follow() { return this.feeds.filter(item => item.endpoint === 'session/follow').at(-1)! }
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const opening = (cursor = 0) => ({ type: 'snapshot', cursor, records: [], hasMore: false,
  projections: { asOfSeq: cursor, values: {} }, assistantStream: { revision: 0 } })
function setup() {
  const peer = new Peer()
  const api = new StudioSessionApi(peer as unknown as BrowserPeerClient)
  const events: Record<string, unknown>[] = []
  const stop = api.start(event => events.push(event.payload))
  const unwatch = api.watchSession('one')
  return { peer, api, events, stop: () => { unwatch(); stop() } }
}

describe('native Session streams', () => {
  it('waits for an earlier subscription to close before reconnecting', async () => {
    const peer = new Peer()
    const api = new StudioSessionApi(peer as unknown as BrowserPeerClient)
    const stop = api.start(() => {})
    await settle()
    let finish!: () => void
    const close = peer.close.bind(peer)
    peer.close = async () => { await new Promise<void>(resolve => { finish = resolve }); await close() }
    stop()
    const restarted = api.start(() => {})
    finish()
    await settle()
    expect(peer.connected).toBe(true)
    peer.close = close
    restarted()
  })

  it('does not replace a newer inbox with an older follow baseline', async () => {
    const { peer, events, stop } = setup()
    try {
      await settle()
      peer.feeds.find(item => item.endpoint === 'session/control')!.feed.push({ type: 'projection', sessionId: 'one', key: 'inbox', seq: 9,
        value: { 'next-turn': [{ id: 'pending', content: [{ type: 'text', text: 'later' }] }], 'next-step': [] } })
      await settle()
      peer.follow().feed.push({ ...opening(8), projections: { asOfSeq: 8, values: { inbox: { 'next-turn': [], 'next-step': [] } } } })
      await settle()
      expect(events.filter(event => event.type === 'session/queue')).toHaveLength(1)
      expect(events.find(event => event.type === 'session/queue')?.items).toMatchObject([{ id: 'pending' }])
    } finally { stop() }
  })

  it('restores the active prefix and keeps committed text until its durable event arrives', async () => {
    const { peer, events, stop } = setup()
    try {
      await settle()
      peer.follow().feed.push({ ...opening(), assistantStream: { revision: 2, activeAttempt: {
        attemptId: 'attempt', nextIndex: 1, stream: [{ type: 'text-chunks', index: 0, time0: 10, dt: [], texts: ['Hello'] }],
      } } })
      await settle()
      expect(events.at(-1)).toMatchObject({ type: 'session/streaming', text: 'Hello' })
      peer.follow().feed.push({ type: 'assistant-stream', frame: { type: 'end', revision: 3,
        attemptId: 'attempt', index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } })
      await settle()
      expect(events.at(-1)).toMatchObject({ text: 'Hello' })
      peer.follow().feed.push({ type: 'event', event: { type: 'assistant/message', seq: 1, data: {} } })
      await settle()
      expect(events.at(-1)).toMatchObject({ type: 'session/streaming', text: '' })
    } finally { stop() }
  })

  it('cancels old session feeds and repairs sequence gaps by reconnecting', async () => {
    const { peer, api, events, stop } = setup()
    try {
      await settle()
      const old = peer.follow()
      api.watchSession('two')
      expect(old.signal.aborted).toBe(true)
      const current = peer.follow()
      current.feed.push(opening(4))
      current.feed.push({ type: 'event', event: { type: 'user/message', seq: 6, data: {} } })
      await settle()
      expect(peer.connected).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: 'stream/error' })
      await peer.connect()
      expect(peer.follow()).not.toBe(current)
      peer.follow().feed.push(opening(6))
      await settle()
      expect(events.some(event => event.type === 'session/snapshot' && event.sessionId === 'two')).toBe(true)
    } finally { stop() }
  })

  it('claims only the watched session and returns native approval values', async () => {
    const { peer, api, events, stop } = setup()
    try {
      const handler = peer.handlers.get('approval/request')!
      const signal = new AbortController().signal
      expect(await handler({ eventId: 'other', agentId: 'other', request: {}, signal } as RemoteEventRequest)).toBeUndefined()
      const pending = handler({ eventId: 'approve', agentId: 'one', request: { toolName: 'bash' }, signal } as RemoteEventRequest)
      expect(events.at(-1)).toMatchObject({ type: 'approval/requested', approvalId: 'approve' })
      expect(await api.respond({ type: 'client-response', rpcId: 'approve', result: { ok: true, value: { outcome: 'allowed-once' } } })).toEqual({ accepted: true })
      expect(await pending).toBe('allowed-once')
      expect(events.at(-1)).toMatchObject({ type: 'approval/resolved' })
    } finally { stop() }
  })

  it('aborts questions without accepting a late answer', async () => {
    const { peer, api, stop } = setup()
    try {
      const abort = new AbortController()
      const pending = Promise.resolve(peer.handlers.get('user-questions/request')!({ eventId: 'question', agentId: 'one', request: { questions: [] }, signal: abort.signal } as RemoteEventRequest))
      const rejected = expect(pending).rejects.toThrow('cancelled')
      abort.abort(new Error('cancelled'))
      await rejected
      expect(await api.respond({ type: 'client-response', rpcId: 'question', result: { ok: true, value: { answer: { answers: [] } } } })).toEqual({ accepted: false, reason: 'not-pending' })
    } finally { stop() }
  })
})
