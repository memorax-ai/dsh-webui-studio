import type { SessionSummary } from './session-types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableAgentSessions, startAgentSessionLoader } from './agent-sessions.js'

function session(
  sessionId: string,
  updatedAt: number,
  options: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: sessionId as SessionId,
    updatedAt,
    running: false,
    blank: false,
    ...options,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('existing Agent session loading', () => {
  it('excludes unavailable sessions and sorts the remainder by recent activity', () => {
    const sessions = [
      session('older', 10),
      session('subagent', 50, { origin: 'subagent' }),
      session('blank', 40, { blank: true }),
      session('attached', 30),
      session('newer', 20),
    ]

    expect(availableAgentSessions(sessions, new Set(['attached'])).map(item => String(item.sessionId)))
      .toEqual(['newer', 'older'])
  })

  it('waits for each request to settle before scheduling the next poll', async () => {
    vi.useFakeTimers()
    const first = deferred<SessionSummary[]>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([])
    const onInitialLoading = vi.fn()
    const loader = startAgentSessionLoader({
      load,
      onData: vi.fn(),
      onError: vi.fn(),
      onInitialLoading,
      intervalMs: 3_000,
    })

    expect(load).toHaveBeenCalledTimes(1)
    expect(onInitialLoading).toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(load).toHaveBeenCalledTimes(1)

    first.resolve([])
    await Promise.resolve()
    expect(onInitialLoading).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)
    loader.dispose()
  })

  it('coalesces refresh triggers received while a request is running', async () => {
    vi.useFakeTimers()
    const first = deferred<SessionSummary[]>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([])
    const loader = startAgentSessionLoader({
      load,
      onData: vi.fn(),
      onError: vi.fn(),
      onInitialLoading: vi.fn(),
    })

    loader.refresh()
    loader.refresh()
    first.resolve([])
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    loader.dispose()
  })

  it('keeps polling after a failed refresh', async () => {
    vi.useFakeTimers()
    const onData = vi.fn()
    const onError = vi.fn()
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([session('recovered', 1)])
    const loader = startAgentSessionLoader({
      load,
      onData,
      onError,
      onInitialLoading: vi.fn(),
      intervalMs: 3_000,
    })

    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onData).toHaveBeenCalledWith([expect.objectContaining({ sessionId: 'recovered' })])
    loader.dispose()
  })

  it('does not publish a request that settles after disposal', async () => {
    const pending = deferred<SessionSummary[]>()
    const onData = vi.fn()
    const loader = startAgentSessionLoader({
      load: () => pending.promise,
      onData,
      onError: vi.fn(),
      onInitialLoading: vi.fn(),
    })

    loader.dispose()
    pending.resolve([session('late', 1)])
    await Promise.resolve()
    expect(onData).not.toHaveBeenCalled()
  })
})
