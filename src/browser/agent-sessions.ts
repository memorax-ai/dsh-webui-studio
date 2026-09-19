import type { SessionSummary } from './session-types'

const REFRESH_INTERVAL_MS = 3_000

export function availableAgentSessions(
  sessions: readonly SessionSummary[],
  attachedSessionIds: ReadonlySet<string>,
): SessionSummary[] {
  return sessions
    .filter(session => (
      session.origin !== 'subagent'
      && !session.blank
      && !attachedSessionIds.has(String(session.sessionId))
    ))
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
}

interface AgentSessionLoaderOptions {
  load(): Promise<SessionSummary[]>
  onData(sessions: SessionSummary[]): void
  onError(error: unknown): void
  onInitialLoading(loading: boolean): void
  intervalMs?: number
}

export interface AgentSessionLoader {
  refresh(): void
  dispose(): void
}

export function startAgentSessionLoader(options: AgentSessionLoaderOptions): AgentSessionLoader {
  let disposed = false
  let loading = false
  let refreshQueued = false
  let initial = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS

  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, intervalMs)
  }

  const load = async (): Promise<void> => {
    if (disposed) return
    if (loading) {
      refreshQueued = true
      return
    }
    loading = true
    try {
      const sessions = await options.load()
      if (!disposed) options.onData(sessions)
    } catch (error) {
      if (!disposed) options.onError(error)
    } finally {
      loading = false
      if (initial) {
        initial = false
        if (!disposed) options.onInitialLoading(false)
      }
      if (!disposed) {
        if (refreshQueued) {
          refreshQueued = false
          void load()
        } else {
          schedule()
        }
      }
    }
  }

  options.onInitialLoading(true)
  void load()

  return {
    refresh(): void {
      if (disposed) return
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      void load()
    },
    dispose(): void {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
