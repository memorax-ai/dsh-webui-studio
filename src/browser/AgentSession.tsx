import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ModelSelection,
  SessionModels,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  buildAgentConversation,
  type AgentContentBlock,
  type AgentConversationItem,
  type AgentQueueItem,
  type AgentStreamingContent,
  type StudioConversationEntry,
} from './agent-conversation'
import type { StudioTranslate } from './i18n'
import {
  agentContextOccupancy,
  agentModelSelection,
  agentModelValue,
  selectedAgentCatalogModel,
  type AgentContextBreakdown,
  type AgentContextPressure,
} from './agent-session-controls'

interface AgentSessionProps {
  entries: readonly StudioConversationEntry[]
  streaming: AgentStreamingContent
  queue: readonly AgentQueueItem[]
  prompt: string
  placeholder?: string
  sessionActive: boolean
  sending: boolean
  models?: SessionModels
  modelsLoading: boolean
  modelSelecting: boolean
  contextPressure?: AgentContextPressure
  contextBreakdown?: AgentContextBreakdown
  loadingOlder: boolean
  hasOlder: boolean
  empty?: ReactNode
  interaction?: ReactNode
  t: StudioTranslate
  onPromptChange(value: string): void
  onSelectModel(selection: ModelSelection): void
  onSubmit(): void
  onLoadOlder(): void
}

function ChevronIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>
}

function AgentMark(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20">
    <path d="M6.5 5.5h7M5 9.5h10M7 13.5h6" />
    <path d="M3.5 3.5h13v13h-13z" />
  </svg>
}

function SendIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 15V5M6 9l4-4 4 4" /></svg>
}

function ToolIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20">
    <path d="M12.5 4.5a4 4 0 0 0-5 5L3.8 13.2a1.6 1.6 0 0 0 2.2 2.2l3.7-3.7a4 4 0 0 0 5-5l-2.4 2.4-1.8-1.8z" />
  </svg>
}

function prettyJson(value: string): string {
  if (value.trim() === '') return ''
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function blocksText(blocks: readonly AgentContentBlock[]): string {
  return blocks.flatMap(block => block.kind === 'text' || block.kind === 'reasoning' ? [block.text] : []).join('\n')
}

function nativeBlocksText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return (candidate.type === 'text' || candidate.type === 'reasoning') && typeof candidate.text === 'string'
      ? [candidate.text]
      : []
  }).join('\n')
}

function viewTitle(callView: ToolCallView | undefined, resultView: ToolResultView | undefined, fallback: string): string {
  if (resultView !== undefined && 'title' in resultView && typeof resultView.title === 'string' && resultView.title !== '') return resultView.title
  if (callView !== undefined && typeof callView.title === 'string' && callView.title !== '') return callView.title
  return fallback
}

function structuredResult(view: ToolResultView | undefined, t: StudioTranslate): string {
  if (view === undefined) return ''
  if (view.card === 'terminal') return view.output ?? ''
  if (view.card === 'diff') return view.diffs.map(diff => `${diff.path}\n${diff.newText}`).join('\n\n')
  if (view.card === 'read') return view.lines.map(line => `${String(line.number).padStart(4, ' ')}  ${line.text}`).join('\n')
  if (view.card === 'search') {
    if (view.shape === 'paths') return view.paths.join('\n')
    return view.files.flatMap(file => [file.path, ...file.matches.map(match => `  ${match.lineNumber}: ${match.line}`)]).join('\n')
  }
  if (view.card === 'web') {
    if (view.kind === 'fetch') return `${view.statusCode} · ${view.url}${view.truncated ? ` · ${t('agentTruncated')}` : ''}`
    return [view.answer, ...view.sources.map(source => `${source.title ?? source.url}\n${source.url}`), view.truncated ? t('agentTruncated') : '']
      .filter(value => value !== undefined && value !== '').join('\n\n')
  }
  return 'content' in view ? nativeBlocksText(view.content ?? []) : ''
}

function ContentBlocks({ blocks, t }: { blocks: readonly AgentContentBlock[]; t: StudioTranslate }): JSX.Element {
  return <>
    {blocks.map((block, index) => block.kind === 'reasoning'
      ? <details className="agent-reasoning" key={`reasoning:${index}`}>
          <summary>{t('agentThinking')}</summary>
          <p>{block.text}</p>
        </details>
      : block.kind === 'image'
        ? <div className="agent-image-placeholder" key={`image:${index}`}>{t('agentImage')}</div>
        : <p key={`text:${index}`}>{block.text}</p>)}
  </>
}

function QueueContent({ item, t }: { item: AgentQueueItem; t: StudioTranslate }): JSX.Element {
  return <p>
    {item.text !== '' && <span>{item.text}</span>}
    {item.imageCount > 0 && <small>{t('agentImageCount', { count: item.imageCount })}</small>}
  </p>
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

function AgentModelControls({
  models,
  loading,
  selecting,
  disabled,
  t,
  onSelect,
}: {
  models?: SessionModels
  loading: boolean
  selecting: boolean
  disabled: boolean
  t: StudioTranslate
  onSelect(selection: ModelSelection): void
}): JSX.Element {
  const selectedModel = selectedAgentCatalogModel(models)
  const selectedValue = selectedModel === undefined || models === undefined ? '' : agentModelValue(models.current)
  const efforts = selectedModel?.reasoning?.efforts ?? []

  return <div className="agent-model-controls">
    <label className="agent-model-select">
      <select value={selectedValue} aria-label={t('agentModel')} disabled={disabled || loading || selecting}
        onChange={event => {
          const selection = agentModelSelection(models, event.target.value)
          if (selection !== undefined) onSelect(selection)
        }}>
        <option value="">{loading ? t('agentModelsLoading') : selecting ? t('agentModelChanging') : t('agentSelectModel')}</option>
        {models?.groups.map(group => <optgroup key={group.id} label={group.name}>
          {group.models.map(model => <option key={`${group.id}:${model.id}`}
            value={agentModelValue({ provider: group.id, model: model.id })}>{model.name}</option>)}
        </optgroup>)}
      </select>
      <ChevronIcon />
    </label>
    {models !== undefined && selectedModel !== undefined && efforts.length > 0 && <label className="agent-effort-select">
      <select value={models.current.reasoningEffort ?? ''} aria-label={t('agentReasoningEffort')}
        disabled={disabled || selecting} onChange={event => onSelect({
          provider: models.current.provider,
          model: models.current.model,
          ...(event.target.value === '' ? {} : { reasoningEffort: event.target.value }),
        })}>
        <option value="">{t('agentDefaultEffort')}</option>
        {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
      </select>
      <ChevronIcon />
    </label>}
  </div>
}

function AgentContextMeter({
  pressure,
  breakdown,
  t,
}: {
  pressure?: AgentContextPressure
  breakdown?: AgentContextBreakdown
  t: StudioTranslate
}): JSX.Element | null {
  const context = agentContextOccupancy(pressure)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (context === undefined && open) setOpen(false)
  }, [context, open])

  useEffect(() => {
    if (!open || context === undefined) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [context, open])

  if (context === undefined) return null
  const circumference = 2 * Math.PI * 5.5
  const breakdownRows = breakdown === undefined ? [] : [
    { key: 'system', label: t('agentContextSystem'), value: breakdown.systemTokens },
    { key: 'tools', label: t('agentContextTools'), value: breakdown.toolsTokens },
    { key: 'messages', label: t('agentContextMessages'), value: breakdown.messageTokens },
  ]
  const breakdownTotal = breakdownRows.reduce((total, row) => total + row.value, 0)
  const label = t('agentContextUsed', { percent: context.percent })

  return <span className="agent-context-meter" ref={rootRef}>
    <button type="button" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(current => !current)}>
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle className="agent-context-track" cx="7" cy="7" r="5.5" />
        <circle className="agent-context-fill" cx="7" cy="7" r="5.5"
          strokeDasharray={`${circumference * context.percent / 100} ${circumference}`}
          transform="rotate(-90 7 7)" />
      </svg>
    </button>
    {open && <div className="agent-context-popover" role="dialog" aria-label={t('agentContextDetails')}>
      <header>
        <span>{label}</span>
        <strong>~{formatTokens(context.usedTokens)} / {formatTokens(context.contextWindow)}</strong>
      </header>
      <div className="agent-context-bar" aria-hidden="true">
        {breakdownRows.length === 0 || breakdownTotal === 0
          ? <i data-kind="total" style={{ width: `${context.percent}%` }} />
          : breakdownRows.map(row => <i key={row.key} data-kind={row.key}
              style={{ width: `${context.percent * row.value / breakdownTotal}%` }} />)}
      </div>
      {breakdownRows.length > 0 && <dl>{breakdownRows.map(row => <div key={row.key}>
        <dt><i data-kind={row.key} />{row.label}</dt><dd>~{formatTokens(row.value)}</dd>
      </div>)}</dl>}
    </div>}
  </span>
}

function AgentToolCard({ item, t }: {
  item: Extract<AgentConversationItem, { kind: 'tool' }>
  t: StudioTranslate
}): JSX.Element {
  const [open, setOpen] = useState(item.status === 'error')
  useEffect(() => {
    if (item.status === 'error') setOpen(true)
  }, [item.status])
  const rawOutput = blocksText(item.result)
  const presentedOutput = structuredResult(item.resultView, t)
  const output = item.resultView?.card === 'web'
    ? [presentedOutput, rawOutput].filter(Boolean).join('\n\n')
    : presentedOutput || rawOutput

  return <details className="agent-tool-card" data-status={item.status} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="agent-tool-icon"><ToolIcon /></span>
      <strong>{viewTitle(item.callView, item.resultView, item.name)}</strong>
      <span className="agent-tool-status">{item.status === 'running' ? t('agentToolRunning')
        : item.status === 'error' ? t('agentToolFailed') : t('agentToolDone')}</span>
    </summary>
    <div className="agent-tool-body">
      {item.arguments !== '' && <section><span>{t('agentToolInput')}</span><pre>{prettyJson(item.arguments)}</pre></section>}
      {output !== '' && <section><span>{t('agentToolOutput')}</span><pre>{output}</pre></section>}
    </div>
  </details>
}

export function AgentSession({
  entries,
  streaming,
  queue,
  prompt,
  placeholder,
  sessionActive,
  sending,
  models,
  modelsLoading,
  modelSelecting,
  contextPressure,
  contextBreakdown,
  loadingOlder,
  hasOlder,
  empty,
  interaction,
  t,
  onPromptChange,
  onSelectModel,
  onSubmit,
  onLoadOlder,
}: AgentSessionProps): JSX.Element {
  const items = useMemo(() => buildAgentConversation(entries), [entries])
  const transcriptRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const hasStreaming = streaming.text !== '' || streaming.reasoning !== ''

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript !== null && pinnedRef.current) transcript.scrollTop = transcript.scrollHeight
  }, [items.length, streaming.reasoning, streaming.text, queue.length])

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (prompt.trim() !== '' && !sending) onSubmit()
  }
  const steering = queue.filter(item => item.placement === 'steering')
  const queued = queue.filter(item => item.placement === 'queued')

  const composerEnabled = sessionActive && models?.routable !== false

  return <>
    <div className="agent-transcript" ref={transcriptRef} aria-live="polite" onScroll={event => {
      const node = event.currentTarget
      pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 56
    }}>
      {hasOlder && <button className="agent-load-older" type="button" disabled={loadingOlder} onClick={onLoadOlder}>
        {loadingOlder ? t('agentLoadingOlder') : t('agentLoadOlder')}
      </button>}
      {items.length === 0 && !hasStreaming && empty}
      {items.map(item => {
        if (item.kind === 'user') return <article className="agent-turn agent-user-turn" key={item.id}>
          <div className="agent-user-bubble"><ContentBlocks blocks={item.blocks} t={t} /></div>
        </article>
        if (item.kind === 'assistant') return <article className="agent-turn agent-assistant-turn" key={item.id}>
          <div className="agent-avatar"><AgentMark /></div>
          <div className="agent-assistant-content">
            <ContentBlocks blocks={item.blocks} t={t} />
            {item.interrupted && <span className="agent-interrupted">{t('agentInterrupted')}</span>}
          </div>
        </article>
        if (item.kind === 'context') return <details className="agent-context-row" key={item.id}>
          <summary><span>{t('agentContext')}</span><strong>{item.summary ?? item.label ?? t('agentContext')}</strong></summary>
          <div><ContentBlocks blocks={item.blocks} t={t} /></div>
        </details>
        if (item.kind === 'notice') return <div className="agent-event-notice" data-tone={item.tone} key={item.id}>
          {item.reason === 'max-output' ? t('agentMaximumOutput') : item.text}
        </div>

        return <AgentToolCard item={item} t={t} key={item.id} />
      })}
      {hasStreaming && <article className="agent-turn agent-assistant-turn agent-streaming-turn">
        <div className="agent-avatar"><AgentMark /></div>
        <div className="agent-assistant-content">
          {streaming.reasoning !== '' && <details className="agent-reasoning" open>
            <summary>{t('agentThinking')}</summary><p>{streaming.reasoning}</p>
          </details>}
          {streaming.text !== '' && <p className="agent-streaming-text">{streaming.text}</p>}
        </div>
      </article>}
      {steering.map(item => <section className="agent-steering" key={item.id}>
        <span>{t('agentSteering')}</span><QueueContent item={item} t={t} />
      </section>)}
      {queued.length > 0 && <section className="agent-queue" aria-label={t('agentQueue')}>
        <header><span>{t('agentQueue')}</span><strong>{queued.length}</strong></header>
        {queued.map(item => <QueueContent item={item} t={t} key={item.id} />)}
      </section>}
    </div>
    {interaction ?? <form className="agent-composer" onSubmit={event => { event.preventDefault(); onSubmit() }}>
      <textarea aria-label={t('agentMessage')} value={prompt} onChange={event => onPromptChange(event.target.value)}
        onKeyDown={onComposerKeyDown} placeholder={composerEnabled ? placeholder ?? t('agentPlaceholder') : sessionActive
          ? t('agentModelUnavailable') : t('agentPlaceholderStart')}
        disabled={!composerEnabled || sending} rows={3} />
      <footer>
        <AgentModelControls models={models} loading={modelsLoading} selecting={modelSelecting}
          disabled={!sessionActive} t={t} onSelect={onSelectModel} />
        <div className="agent-composer-trailing">
          <AgentContextMeter pressure={contextPressure} breakdown={contextBreakdown} t={t} />
          <button className="agent-send" type="submit" aria-label={t('send')}
            disabled={!composerEnabled || sending || prompt.trim() === ''}>
          <SendIcon />
          </button>
        </div>
      </footer>
      {sessionActive && <span className="agent-composer-hint">{composerEnabled
        ? t('agentSendHint') : t('agentModelUnavailable')}</span>}
    </form>}
  </>
}
