import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  ClientResponse,
  HistoryEntry,
  ModelSelection,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  StudioVariableDefinition,
  StudioVariableGroupDefinition,
  StudioVariableNode,
  StudioVariableValue,
} from 'dsh-harmony-react/studio'
import {
  type StudioAgentBinding,
  type StudioCreateDraftInput,
  type StudioCurrentInstanceView,
  type StudioBuildOutput,
  type StudioBuildResult,
  type StudioDraftView,
  type StudioDomSelection,
  type StudioElementSnapshot,
  type StudioElementStyleRule,
  type StudioElementStyleSource,
  type StudioElementStyleTarget,
  type StudioProjectFile,
  type StudioProjectState,
  type StudioPreviewStatus,
  type StudioRegistrySnapshot,
  type StudioReadinessLevel,
  type StudioReadinessReport,
  type StudioServerRequest,
  type StudioSourceCandidate,
  type StudioWorkspaceState,
  STUDIO_PATH,
} from '../contracts'
import { apiValue, studioApi, subscribeStudioEvents } from './events'
import { availableAgentSessions, startAgentSessionLoader } from './agent-sessions'
import { nextBrowserId } from './id'
import { callStudio } from './rpc'
import { studioErrorCodeMessage, studioErrorMessage } from './error-message'
import { CodeEditor } from './CodeEditor'
import { useStudioLocale, type StudioTranslate } from './i18n'
import { flattenVariableTree } from '../variable-tree'
import { parseVariableInput } from './variable-input'
import { suggestCssProperties } from './css-property-suggestions'
import { compileElementStyleSelector } from '../bridge/element-style-selector'
import {
  clamp,
  constrainRect,
  fitRect,
  moveRect,
  resizeRect,
  type LayoutRect,
  type ResizeDirection,
} from './layout'
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Notice,
  Panel,
  PanelBody,
  SegmentedControl,
  Select,
  Status,
  Tabs,
} from './ui'
import { CreateDraftDialog } from './CreateDraftDialog'
import { PluginManagement } from './PluginManagement'
import { SettingsDialog, SettingsIcon } from './SettingsDialog'
import { AutomaticPatchDialog, automaticPatchScope } from './AutomaticPatchDialog'
import { AgentSession } from './AgentSession'
import { AgentInteractionComposer } from './AgentInteractionComposer'
import {
  updateAgentInteractions,
  type AgentInteractionStore,
} from './agent-interactions'
import {
  agentStreamingContent,
  agentQueueItems,
  type AgentQueueItem,
  type StudioConversationEntry,
} from './agent-conversation'
import {
  mergeAgentProjectionBaseline,
  mergeAgentProjectionFrame,
  readAgentContextBreakdown,
  readAgentContextPressure,
  type AgentProjectionStore,
} from './agent-session-controls'
import {
  boundedBridgeText,
  isBridgeEnvelope,
  isBridgeOffer,
  isFinitePreviewPan,
  isFinitePreviewZoom,
  isStudioDomSelection,
  isStudioRegistrySnapshot,
} from './preview-messages'

const panels = ['elements', 'selection', 'source', 'build', 'agent'] as const
type Panel = typeof panels[number]
const leftPanels = ['instance', 'plugins', 'patches'] as const
type LeftPanel = typeof leftPanels[number]
type InstanceOperation = 'start' | 'stop' | 'restart'
type PreviewConnection = {
  port: MessagePort
  sessionId: string
  nonce: string
}
type StudioVariableUpdate =
  | { scope: 'element'; owner: string; elementId: string; variableId: string; value: StudioVariableValue }
  | { scope: 'global'; owner: string; variableId: string; value: StudioVariableValue }
type DraftTabDrag = {
  draftId: string
  sourceIndex: number
  targetIndex?: number
  indicator: boolean
  span: number
  width: number
}
type PreviewZoomFocus = {
  x: number
  y: number
  phase: 'active' | 'fading'
}

const previewAspectRatios = ['16:9', '16:10', '4:3', '1:1', '9:16'] as const
type PreviewAspectRatio = typeof previewAspectRatios[number] | 'custom'

const LEFT_SIDEBAR_MIN = 220
const LEFT_SIDEBAR_MAX = 480
const RIGHT_SIDEBAR_MIN = 320
const RIGHT_SIDEBAR_MAX = 560
const PREVIEW_GUTTER = 32
const PREVIEW_MIN_SIZE = { width: 1, height: 1 }
const PREVIEW_ZOOM_FOCUS_FADE_MS = 10_000
const PREVIEW_ZOOM_FOCUS_REDUCED_FADE_MS = 240
const TERMINAL_MIN_SIZE = { width: 280, height: 220 }
const resizeDirections: readonly ResizeDirection[] = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']

const EMPTY_REGISTRY: StudioRegistrySnapshot = { elements: [], variables: [] }
const CURRENT_INSTANCE_KEY = 'current-instance'

function PlusIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12" /></svg>
}

function RefreshIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M15.5 7A6 6 0 1 0 16 12" /><path d="M15.5 3v4h-4" /></svg>
}

function FullscreenIcon({ active }: { active: boolean }): JSX.Element {
  return active
    ? <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8 4v4H4M12 4v4h4M8 16v-4H4M12 16v-4h4" /></svg>
    : <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8 4H4v4M12 4h4v4M8 16H4v-4M12 16h4v-4" /></svg>
}

function AspectRatioLockIcon({ locked }: { locked: boolean }): JSX.Element {
  return locked
    ? <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="M7.5 7.5l-2 2a3 3 0 0 0 4.2 4.2l2-2M12.5 12.5l2-2a3 3 0 0 0-4.2-4.2l-2 2M7.5 12.5l5-5" />
      </svg>
    : <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="M7 8l-1.5 1.5a3 3 0 0 0 4.2 4.2l1.5-1.5M13 12l1.5-1.5a3 3 0 0 0-4.2-4.2L8.8 7.8M5 4l10 12" />
      </svg>
}

function TerminalLayoutIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return expanded
    ? <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 8h6M7 12h6" /></svg>
    : <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M8 12l4-4M8 8h4v4" /></svg>
}

function DisclosureIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16">
    <path d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
  </svg>
}

function StartIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M7 5l8 5-8 5z" /></svg>
}

function StopIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="1" /></svg>
}

function CloseIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8" /></svg>
}

function ResizeHandles({
  kind,
  onPointerDown,
}: {
  kind: 'preview' | 'terminal'
  onPointerDown(event: ReactPointerEvent<HTMLSpanElement>, direction: ResizeDirection): void
}): JSX.Element {
  return <>{resizeDirections.map(direction => <span key={direction} aria-hidden="true"
    className={`resize-handle resize-handle-${direction}`} data-kind={kind}
    onPointerDown={event => onPointerDown(event, direction)} />)}</>
}

function aspectRatioValue(value: Exclude<PreviewAspectRatio, 'custom'>): number {
  const [width, height] = value.split(':').map(Number)
  return width! / height!
}

function aspectRatioLabel(width: number, height: number): PreviewAspectRatio {
  const ratio = width / height
  return previewAspectRatios.find(value => Math.abs(aspectRatioValue(value) - ratio) < 0.01) ?? 'custom'
}

function previewBounds(width: number, height: number): LayoutRect {
  return {
    x: PREVIEW_GUTTER,
    y: PREVIEW_GUTTER,
    width: Math.max(0, width - PREVIEW_GUTTER * 2),
    height: Math.max(0, height - PREVIEW_GUTTER * 2),
  }
}

function runtimeLabel(state: StudioDraftView['runtime']['state'], t: StudioTranslate): string {
  return state === 'running' ? t('runtimeRunning') : state === 'starting' ? t('runtimeStarting')
    : state === 'failed' ? t('runtimeFailed') : t('runtimeStopped')
}

function deviceViewport(): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(window.screen.width)),
    height: Math.max(1, Math.round(window.screen.height)),
  }
}

function SidebarToggleIcon({ side, collapsed }: { side: 'left' | 'right'; collapsed: boolean }): JSX.Element {
  const arrow = side === 'left'
    ? collapsed ? 'M8 7l3 3-3 3' : 'M11 7l-3 3 3 3'
    : collapsed ? 'M12 7l-3 3 3 3' : 'M9 7l3 3-3 3'
  return <svg aria-hidden="true" viewBox="0 0 20 20">
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <path d={side === 'left' ? 'M7 3v14' : 'M13 3v14'} />
    <path d={arrow} />
  </svg>
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function elementForSelection(
  selection: StudioDomSelection | undefined,
  registry: StudioRegistrySnapshot,
  owner: string | undefined,
): StudioElementSnapshot | undefined {
  if (selection === undefined || owner === undefined) return undefined
  for (const boundary of selection.boundaries) {
    const match = registry.elements.find(item => item.owner === owner
      && item.element.boundary.surfaceId === boundary.surfaceId
      && samePath(item.element.boundary.path, boundary.path))
    if (match !== undefined) return match
  }
  return undefined
}

function VariableControl({
  definition,
  value,
  onChange,
  depth = 0,
}: {
  definition: StudioVariableDefinition
  value: StudioVariableValue
  onChange(value: StudioVariableValue): void
  depth?: number
}): JSX.Element {
  const id = useId()
  const validatedInput = definition.control === 'length' || definition.control === 'number' || definition.control === 'string'
  const [draftValue, setDraftValue] = useState(String(value))
  const [focused, setFocused] = useState(false)
  const composing = useRef(false)
  const parsedValue = validatedInput ? parseVariableInput(definition, draftValue) : undefined

  useEffect(() => {
    if (!focused) setDraftValue(String(value))
  }, [focused, value])

  const finishEditing = (): void => {
    setFocused(false)
    if (parsedValue === undefined) setDraftValue(String(value))
  }

  const changeDraftValue = (next: string): void => {
    setDraftValue(next)
    if (composing.current) return
    const parsed = parseVariableInput(definition, next)
    if (parsed !== undefined && !Object.is(parsed, value)) onChange(parsed)
  }

  let control: JSX.Element
  if (definition.control === 'boolean') {
    control = <Input id={id} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />
  } else if (definition.control === 'enum') {
    control = <Select id={id} value={String(value)} onChange={event => {
      const option = definition.options?.find(candidate => String(candidate) === event.target.value)
      if (option !== undefined) onChange(option)
    }}>{definition.options?.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</Select>
  } else if (definition.control === 'number') {
    control = <Input id={id} type="number" value={draftValue} min={definition.constraints?.min}
      max={definition.constraints?.max} step={definition.constraints?.step ?? 'any'}
      aria-invalid={draftValue.trim() !== '' && parsedValue === undefined}
      onFocus={() => setFocused(true)} onBlur={finishEditing}
      onChange={event => changeDraftValue(event.target.value)} />
  } else {
    const textEntry = definition.control === 'length' || definition.control === 'string'
    control = <Input id={id} type={definition.control === 'color' ? 'color' : 'text'}
      value={textEntry ? draftValue : String(value)}
      aria-invalid={definition.control === 'length' && draftValue.trim() !== '' && parsedValue === undefined}
      onFocus={textEntry ? () => setFocused(true) : undefined}
      onBlur={textEntry ? finishEditing : undefined}
      onCompositionStart={textEntry ? () => { composing.current = true } : undefined}
      onCompositionEnd={textEntry ? event => {
        composing.current = false
        changeDraftValue(event.currentTarget.value)
      } : undefined}
      onChange={event => textEntry ? changeDraftValue(event.target.value) : onChange(event.target.value)} />
  }
  return <label className="element-variable" htmlFor={id}
    style={{ '--variable-tree-depth': Math.min(depth, 4) } as CSSProperties}>
    <span><strong>{definition.label}</strong><code>{definition.id}</code></span>
    {control}
  </label>
}

function VariableGroup({
  group,
  values,
  onChange,
  depth,
}: {
  group: StudioVariableGroupDefinition
  values: Readonly<Record<string, StudioVariableValue>>
  onChange(definition: StudioVariableDefinition, value: StudioVariableValue): void
  depth: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return <details className="variable-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="variable-group-summary"
      style={{ '--variable-tree-depth': Math.min(depth, 4) } as CSSProperties}>
      <span><strong>{group.label}</strong><code>{group.id}</code></span>
      <small>{flattenVariableTree(group.children).length}</small>
    </summary>
    <VariableTree nodes={group.children} values={values} onChange={onChange} depth={depth + 1} nested />
  </details>
}

function VariableTree({
  nodes,
  values,
  onChange,
  depth = 0,
  nested = false,
}: {
  nodes: readonly StudioVariableNode[]
  values: Readonly<Record<string, StudioVariableValue>>
  onChange(definition: StudioVariableDefinition, value: StudioVariableValue): void
  depth?: number
  nested?: boolean
}): JSX.Element {
  return <div className={nested ? 'variable-tree-children' : 'variable-tree'}>
    {nodes.map(node => node.kind === 'group'
      ? <VariableGroup key={node.id} group={node} values={values} onChange={onChange} depth={depth} />
      : <VariableControl key={node.id} definition={node} value={values[node.id]!}
          depth={depth} onChange={value => onChange(node, value)} />)}
  </div>
}

const cssPropertySuggestions = [
  'align-items', 'align-self', 'background', 'background-color', 'border', 'border-color', 'border-radius',
  'bottom', 'box-shadow', 'color', 'display', 'flex', 'flex-direction', 'font-family', 'font-size', 'font-weight',
  'gap', 'grid-template-columns', 'height', 'justify-content', 'left', 'letter-spacing', 'line-height', 'margin',
  'margin-block', 'margin-inline', 'max-height', 'max-width', 'min-height', 'min-width', 'opacity', 'overflow',
  'padding', 'padding-block', 'padding-inline', 'position', 'right', 'text-align', 'text-decoration', 'top',
  'transform', 'transition', 'visibility', 'white-space', 'width', 'z-index',
] as const

const cssSelectorSuggestions = [
  '&', '&.', '&[', '&:hover', '&:focus', '&:focus-visible', '&:active', '&:disabled', '&:checked',
  '& > .', '& > *', '& .', '& *',
] as const

function TrashIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 6.5h10M8 6.5V4h4v2.5M7 8.5v6.5M10 8.5v6.5M13 8.5v6.5M5.5 6.5l.7 10h7.6l.7-10" /></svg>
}

function StyleDeclarationEditor({ properties, onSubmit, onCancel, t }: {
  properties: readonly string[]
  onSubmit(property: string, value: string): void
  onCancel(): void
  t: StudioTranslate
}): JSX.Element {
  const [property, setProperty] = useState('')
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [focused, setFocused] = useState(false)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const suggestionListId = useId()
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const suggestions = focused ? suggestCssProperties([...cssPropertySuggestions, ...properties], property) : []
  const selectSuggestion = (next: string): void => { setProperty(next); setSuggestionIndex(0) }
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSuggestionIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
    } else if (event.key === 'Tab' || event.key === 'ArrowRight') {
      event.preventDefault()
      selectSuggestion(suggestions[suggestionIndex]!.value)
    }
  }
  useEffect(() => {
    suggestionsRef.current?.querySelector(`[data-suggestion-index="${suggestionIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [suggestionIndex, suggestions])
  return <form className="element-style-editor" onSubmit={event => {
    event.preventDefault()
    if (property.trim() === '' || value.trim() === '') return setInvalid(true)
    onSubmit(property.trim(), value.trim())
  }}>
    <div className="element-style-property-field">
      <Input autoFocus value={property} placeholder={t('stylePropertyPlaceholder')} aria-label={t('styleProperty')}
        aria-autocomplete="list" aria-controls={suggestions.length > 0 ? suggestionListId : undefined}
        aria-activedescendant={suggestions.length > 0 ? `${suggestionListId}-${suggestionIndex}` : undefined}
        aria-expanded={suggestions.length > 0} aria-invalid={invalid && property.trim() === ''}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={keyDown}
        onChange={event => { setProperty(event.target.value); setSuggestionIndex(0) }} />
      {suggestions.length > 0 && <div ref={suggestionsRef} id={suggestionListId}
        className="element-style-suggestions" role="listbox" aria-label={t('styleProperty')}>
        {suggestions.map((candidate, index) => <button key={candidate.label} type="button" role="option"
          id={`${suggestionListId}-${index}`} data-suggestion-index={index} aria-selected={index === suggestionIndex}
          data-focused={index === suggestionIndex || undefined} onMouseEnter={() => setSuggestionIndex(index)}
          onMouseDown={event => event.preventDefault()} onClick={() => selectSuggestion(candidate.value)}>{candidate.label}</button>)}
      </div>}
    </div>
    <Input value={value} placeholder={t('styleValuePlaceholder')} aria-label={t('styleValue')}
      aria-invalid={invalid && value.trim() === ''} onChange={event => setValue(event.target.value)} />
    <Button size="small" variant="primary" type="submit">{t('addStyleConfirm')}</Button>
    <Button size="small" variant="ghost" type="button" onClick={onCancel}>{t('addStyleCancel')}</Button>
    {invalid && <small className="element-style-error">{t('stylePropertyRequired')}</small>}
  </form>
}

function ElementStyles({ rules, selectorCandidates, onRequestSelectors, onAddRule, onRemoveRule, onAdd, onRemove, canEdit, t }: {
  rules: readonly StudioElementStyleRule[]
  selectorCandidates: readonly string[]
  onRequestSelectors(): void
  onAddRule(selector: string): void
  onRemoveRule(selector: string): void
  onAdd(selector: string, property: string, value: string): void
  onRemove(selector: string, property: string): void
  canEdit: boolean
  t: StudioTranslate
}): JSX.Element {
  const [editingRule, setEditingRule] = useState<string>()
  const [addingSelector, setAddingSelector] = useState(false)
  const [selector, setSelector] = useState('&')
  const [selectorInvalid, setSelectorInvalid] = useState(false)
  const [selectorFocused, setSelectorFocused] = useState(false)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const suggestionListId = useId()
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const visibleRules = rules.some(rule => rule.selector === '&')
    ? rules : [{ selector: '&', declarations: [] }, ...rules]
  const selectorSuggestions = selectorFocused
    ? [...new Set([...cssSelectorSuggestions, ...selectorCandidates])]
      .filter(candidate => candidate.startsWith(selector) && candidate !== selector) : []
  const selectorKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (selectorSuggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSuggestionIndex(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + selectorSuggestions.length) % selectorSuggestions.length)
    } else if (event.key === 'Tab' || event.key === 'ArrowRight') {
      event.preventDefault()
      setSelector(selectorSuggestions[suggestionIndex]!)
      setSuggestionIndex(0)
    }
  }
  useEffect(() => {
    suggestionsRef.current?.querySelector(`[data-suggestion-index="${suggestionIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [suggestionIndex, selectorSuggestions])
  const properties = rules.flatMap(rule => rule.declarations.map(declaration => declaration.property))
  return <section className="element-styles" aria-label={t('elementStyles')}>
    <div className="element-styles-heading">
      <strong>{t('elementStyles')}</strong>
      <Button className="element-style-add" variant="ghost" size="small" disabled={!canEdit} onClick={() => {
        onRequestSelectors()
        setAddingSelector(true)
      }}>
        <PlusIcon />{t('addStyleSelector')}
      </Button>
    </div>
    {visibleRules.map(rule => <details className="element-style-rule" key={rule.selector} open>
      <summary><code>{rule.selector}</code><span>{rule.selector === '&' ? t('currentElementSelector') : t('relativeElementSelector')}</span></summary>
      <div className="element-style-rule-actions">
        <Button variant="ghost" size="small" disabled={!canEdit} onClick={() => setEditingRule(rule.selector)}>
          <PlusIcon />{t('addStyleDeclaration')}
        </Button>
        {rules.some(candidate => candidate.selector === rule.selector) && <IconButton size="small" variant="ghost"
          label={t('removeStyleSelector', { selector: rule.selector })} disabled={!canEdit}
          onClick={() => onRemoveRule(rule.selector)}><TrashIcon /></IconButton>}
      </div>
      {rule.declarations.map(declaration => <div className="element-style-row" key={declaration.property}>
        <code>{declaration.property}</code><span>{declaration.value}</span>
        <IconButton className="element-style-remove" size="small" variant="ghost"
          label={t('removeElementStyle', { property: declaration.property })} disabled={!canEdit}
          onClick={() => onRemove(rule.selector, declaration.property)}><TrashIcon /></IconButton>
      </div>)}
      {editingRule === rule.selector && <StyleDeclarationEditor properties={properties} t={t}
        onCancel={() => setEditingRule(undefined)}
        onSubmit={(property, value) => { onAdd(rule.selector, property, value); setEditingRule(undefined) }} />}
    </details>)}
    {addingSelector && <form className="element-selector-editor" onSubmit={event => {
      event.preventDefault()
      const next = selector.trim()
      try {
        compileElementStyleSelector(next, '[data-scope]')
      } catch {
        return setSelectorInvalid(true)
      }
      if (rules.some(rule => rule.selector === next)) return setSelectorInvalid(true)
      onAddRule(next)
      setAddingSelector(false)
      setSelector('&')
      setSelectorInvalid(false)
    }}>
      <div className="element-style-property-field">
        <Input autoFocus value={selector} aria-label={t('styleSelector')} placeholder="& .title"
          aria-autocomplete="list" aria-expanded={selectorSuggestions.length > 0}
          aria-controls={selectorSuggestions.length > 0 ? suggestionListId : undefined}
          aria-activedescendant={selectorSuggestions.length > 0 ? `${suggestionListId}-${suggestionIndex}` : undefined}
          aria-invalid={selectorInvalid} onFocus={() => setSelectorFocused(true)} onBlur={() => setSelectorFocused(false)}
          onKeyDown={selectorKeyDown} onChange={event => { setSelector(event.target.value); setSuggestionIndex(0) }} />
        {selectorSuggestions.length > 0 && <div ref={suggestionsRef} id={suggestionListId}
          className="element-style-suggestions" role="listbox" aria-label={t('styleSelector')}>
          {selectorSuggestions.map((candidate, index) => <button key={candidate} type="button" role="option"
            id={`${suggestionListId}-${index}`} data-suggestion-index={index} aria-selected={index === suggestionIndex}
            data-focused={index === suggestionIndex || undefined} onMouseEnter={() => setSuggestionIndex(index)}
            onMouseDown={event => event.preventDefault()} onClick={() => setSelector(candidate)}>{candidate}</button>)}
        </div>}
      </div>
      <Button size="small" variant="primary" type="submit">{t('addStyleConfirm')}</Button>
      <Button size="small" variant="ghost" type="button" onClick={() => setAddingSelector(false)}>{t('addStyleCancel')}</Button>
      {selectorInvalid && <small className="element-style-error">{t('styleSelectorRequired')}</small>}
    </form>}
  </section>
}

function ElementTreeNode({
  element,
  matched,
  sourceAvailable,
  initialOpen,
  onOpenSource,
  onChange,
  styles,
  selectorCandidates,
  onRequestSelectors,
  onAddStyleRule,
  onRemoveStyleRule,
  onAddStyle,
  onRemoveStyle,
  canEditStyles,
  t,
}: {
  element: StudioElementSnapshot
  matched: boolean
  sourceAvailable: boolean
  initialOpen: boolean
  onOpenSource(): void
  onChange(definition: StudioVariableDefinition, value: StudioVariableValue): void
  styles: readonly StudioElementStyleRule[]
  selectorCandidates: readonly string[]
  onRequestSelectors(): void
  onAddStyleRule(selector: string): void
  onRemoveStyleRule(selector: string): void
  onAddStyle(selector: string, property: string, value: string): void
  onRemoveStyle(selector: string, property: string): void
  canEditStyles: boolean
  t: StudioTranslate
}): JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  const variables = flattenVariableTree(element.element.variables ?? [])
  useEffect(() => {
    if (matched) setOpen(true)
  }, [matched])

  return <details className="element-tree-node" data-matched={matched || undefined}
    open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="element-tree-summary">
      <span><strong>{element.element.label}</strong><code>{element.element.id}</code></span>
      <small>{matched ? t('previewSelection') : variables.length}</small>
    </summary>
    <div className="element-tree-content">
      <div className="element-tree-source-row">
        <code>{element.element.source.file}</code>
        <Button className="source-link" variant="ghost" size="small" disabled={!sourceAvailable}
          onClick={onOpenSource}>{t('openElementSource')}</Button>
      </div>
      <ElementStyles rules={styles} selectorCandidates={selectorCandidates} onRequestSelectors={onRequestSelectors}
        onAddRule={onAddStyleRule} onRemoveRule={onRemoveStyleRule}
        onAdd={onAddStyle} onRemove={onRemoveStyle} canEdit={canEditStyles} t={t} />
      {variables.length === 0
        ? <p className="inspection-empty">{t('elementNoVariables')}</p>
        : <VariableTree nodes={element.element.variables ?? []} values={element.values} depth={1} onChange={onChange} />}
      {variables.some(variable => variable.defaultSource === undefined)
        && <p className="variable-note">{t('elementSourceSaveNote')}</p>}
    </div>
  </details>
}

function eventSessionId(envelope: StudioServerRequest<Record<string, unknown>>): string | undefined {
  return typeof envelope.payload.sessionId === 'string' ? envelope.payload.sessionId : undefined
}

function agentToolArguments(entries: readonly StudioConversationEntry[], callId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event
    if (event?.type === 'tool/call' && event.data.callId === callId) return event.data.arguments
  }
  return undefined
}

function sessionTitle(session: SessionSummary): string {
  const values = session.projections?.values as Record<string, unknown> | undefined
  const title = values?.title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  const directory = session.cwd?.split('/').filter(Boolean).at(-1)
  return directory === undefined ? String(session.sessionId).slice(0, 8) : directory
}

export function App(): JSX.Element {
  const { t } = useStudioLocale()
  const localizeError = (cause: unknown): string => studioErrorMessage(cause, t)
  const initialViewport = useMemo(deviceViewport, [])
  const [drafts, setDrafts] = useState<StudioDraftView[]>([])
  const [currentInstance, setCurrentInstance] = useState<StudioCurrentInstanceView>()
  const [openDraftIds, setOpenDraftIds] = useState<string[]>([])
  const [draftTabDrag, setDraftTabDrag] = useState<DraftTabDrag>()
  const [loadingDrafts, setLoadingDrafts] = useState(true)
  const [selectedDraftId, setSelectedDraftId] = useState<string>()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [automaticPatchOpen, setAutomaticPatchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [project, setProject] = useState<StudioProjectState>()
  const [sessionId, setSessionId] = useState<string>()
  const [events, setEvents] = useState<StudioConversationEntry[]>([])
  const [prompt, setPrompt] = useState('')
  const [agentQueues, setAgentQueues] = useState<Record<string, AgentQueueItem[]>>({})
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [running, setRunning] = useState(false)
  const [connected, setConnected] = useState(false)
  const [creatingAgentDraftId, setCreatingAgentDraftId] = useState<string>()
  const [attachingAgentDraftId, setAttachingAgentDraftId] = useState<string>()
  const [leavingAgentDraftId, setLeavingAgentDraftId] = useState<string>()
  const [agentSessions, setAgentSessions] = useState<SessionSummary[]>([])
  const [selectedAgentSessionId, setSelectedAgentSessionId] = useState('')
  const [loadingAgentSessions, setLoadingAgentSessions] = useState(false)
  const [exportingDraftId, setExportingDraftId] = useState<string>()
  const [instanceOperations, setInstanceOperations] = useState<Record<string, InstanceOperation>>({})
  const [buildOperations, setBuildOperations] = useState<Record<string, true>>({})
  const [buildOutputs, setBuildOutputs] = useState<Record<string, StudioBuildOutput>>({})
  const [sending, setSending] = useState(false)
  const [agentModels, setAgentModels] = useState<SessionModels>()
  const [loadingAgentModels, setLoadingAgentModels] = useState(false)
  const [selectingAgentModel, setSelectingAgentModel] = useState(false)
  const [agentProjections, setAgentProjections] = useState<AgentProjectionStore>({})
  const [error, setError] = useState<string>()
  const [agentInteractions, setAgentInteractions] = useState<AgentInteractionStore>({})
  const [previewVersions, setPreviewVersions] = useState<Record<string, number>>({})
  const [previewMode, setPreviewMode] = useState<'browse' | 'inspect'>('browse')
  const [previewAspectRatio, setPreviewAspectRatio] = useState<PreviewAspectRatio>(
    () => aspectRatioLabel(initialViewport.width, initialViewport.height),
  )
  const [previewAspectLocked, setPreviewAspectLocked] = useState(false)
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false)
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false)
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('instance')
  const [draftLabelInput, setDraftLabelInput] = useState('')
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(260)
  const [rightSidebarWidth, setRightSidebarWidth] = useState(400)
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 })
  const [previewViewport, setPreviewViewport] = useState(initialViewport)
  const [previewScale, setPreviewScale] = useState(1)
  const [previewZoomFocus, setPreviewZoomFocus] = useState<PreviewZoomFocus>()
  const [previewOrigin, setPreviewOrigin] = useState({ x: PREVIEW_GUTTER, y: PREVIEW_GUTTER })
  const [selection, setSelection] = useState<StudioDomSelection>()
  const [registry, setRegistry] = useState<StudioRegistrySnapshot>(EMPTY_REGISTRY)
  const [panel, setPanel] = useState<Panel>('elements')
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [terminalExpanded, setTerminalExpanded] = useState(false)
  const [terminalMinimized, setTerminalMinimized] = useState(false)
  const [terminalRect, setTerminalRect] = useState<LayoutRect>()
  const [files, setFiles] = useState<StudioProjectFile[]>([])
  const [filePath, setFilePath] = useState('')
  const [source, setSource] = useState('')
  const [savedSource, setSavedSource] = useState('')
  const [fileBusy, setFileBusy] = useState(false)
  const [elementSourceBusy, setElementSourceBusy] = useState(false)
  const [elementSourceMessage, setElementSourceMessage] = useState<string>()
  const [modifiedElementDefaults, setModifiedElementDefaults] = useState<ReadonlySet<string>>(() => new Set())
  const [elementStyles, setElementStyles] = useState<Record<string, StudioElementStyleRule[]>>({})
  const [elementSelectorCandidates, setElementSelectorCandidates] = useState<Record<string, string[]>>({})
  const [readiness, setReadiness] = useState<StudioReadinessReport>({ findings: [] })
  const [packingDraftId, setPackingDraftId] = useState<string>()
  const sessionRef = useRef<string>()
  const runningVersion = useRef(0)
  const refreshAgentSessionsRef = useRef<() => void>()
  const agentSessionLoadErrorRef = useRef<string>()
  const draftIdRef = useRef<string>()
  const draftsRef = useRef<StudioDraftView[]>([])
  const currentInstanceRef = useRef<StudioCurrentInstanceView>()
  const projectRef = useRef<StudioProjectState>()
  const previewFrames = useRef(new Map<string, HTMLIFrameElement>())
  const previewFrameRefs = useRef(new Map<string, (node: HTMLIFrameElement | null) => void>())
  const previewConnections = useRef(new Map<string, PreviewConnection>())
  const confirmingDrafts = useRef(new Set<string>())
  const previewSectionRef = useRef<HTMLElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLPreElement>(null)
  const terminalToggleRef = useRef<HTMLButtonElement>(null)
  const terminalPinnedRef = useRef(true)
  const previewBridgeHandlerRef = useRef<(event: MessageEvent) => void>(() => {})
  const previewModeRef = useRef(previewMode)
  const previewTransformRef = useRef({ scale: previewScale, origin: previewOrigin })
  const previewLockedAspectRatioRef = useRef(initialViewport.width / initialViewport.height)
  const previewUpdateQueue = useRef<Promise<void>>(Promise.resolve())
  const variableUpdateTail = useRef<Promise<void>>(Promise.resolve())
  const pendingVariableResults = useRef(new Map<string, { resolve(): void; reject(error: Error): void }>())
  const sourceVariableBaselines = useRef(new Map<string, StudioVariableValue>())
  const elementStyleBaselines = useRef(new Map<string, string>())
  const workspaceUpdateQueue = useRef<Promise<void>>(Promise.resolve())
  const suppressDraftTabClickRef = useRef<string>()
  const selectionResolve = useRef(0)
  const fileRequest = useRef(0)
  const draftViewRequest = useRef(0)
  const packRequest = useRef(0)
  const agentModelRequest = useRef(0)
  const activeDragCleanupRef = useRef<() => void>()
  const openDrafts = openDraftIds.flatMap(id => {
    const draft = drafts.find(candidate => candidate.id === id)
    return draft === undefined ? [] : [draft]
  })
  const selectedDraft = drafts.find(draft => draft.id === selectedDraftId)
  const availablePanels = selectedDraftId === undefined
    ? panels.filter(item => item === 'selection' || item === 'agent')
    : panels
  const attachedAgentSessionIds = [
    ...(currentInstance?.agent === undefined ? [] : [currentInstance.agent.sessionId]),
    ...drafts.flatMap(draft => draft.agent === undefined ? [] : [draft.agent.sessionId]),
  ].sort().join('\0')
  const selectedAgentSession = agentSessions.find(session => String(session.sessionId) === selectedAgentSessionId)
  const queuedPrompts = sessionId === undefined ? [] : agentQueues[sessionId] ?? []
  const pendingAgentInteractions = sessionId === undefined ? [] : agentInteractions[sessionId] ?? []
  const activeAgentInteraction = pendingAgentInteractions[0]
  const activeAgentApprovalArguments = activeAgentInteraction?.kind === 'approval'
    && activeAgentInteraction.request.callId !== undefined
    ? agentToolArguments(events, activeAgentInteraction.request.callId)
    : undefined
  const hasUnsavedSource = filePath !== '' && source !== savedSource
  const selectedInstanceOperation = selectedDraftId === undefined ? undefined : instanceOperations[selectedDraftId]
  const selectedInstanceStarting = selectedInstanceOperation === 'start' || selectedInstanceOperation === 'restart'
  const selectedBuildRunning = selectedDraftId !== undefined && buildOperations[selectedDraftId] === true
  const selectedBuildOutput = selectedDraftId === undefined ? undefined : buildOutputs[selectedDraftId]
  const terminalOutput = selectedDraft?.runtime.log ?? ''
  const terminalLatestLine = terminalOutput.trimEnd().split(/\r?\n/).at(-1) ?? t('terminalNotStarted')
  const terminalRuntimeState = selectedInstanceStarting ? 'starting' : selectedDraft?.runtime.state
  const terminalRuntimeLabel = selectedInstanceOperation === 'restart' ? t('operationRestarting')
    : selectedInstanceOperation === 'stop' ? t('operationStopping') : terminalRuntimeState === 'starting' ? t('operationRunning')
    : terminalRuntimeState === 'running' ? t('operationActive')
      : terminalRuntimeState === 'failed' ? t('operationFailed') : undefined
  const localDshStatusLabel = connected ? t('localDshActive') : t('localDshStopped')
  const hasLiveDraft = drafts.some(draft => draft.runtime.state === 'starting' || draft.runtime.state === 'running')
  const activePreviewKey = selectedDraftId ?? CURRENT_INSTANCE_KEY
  const previewSession = selectedDraftId === undefined ? currentInstance?.bridgeCapability : selectedDraft?.runtime.bridgeCapability
  const previewUrl = selectedDraftId === undefined ? currentInstance?.previewUrl : selectedDraft?.runtime.previewUrl
  const agentTargetReady = selectedDraftId === undefined ? currentInstance !== undefined : project?.state === 'active'
  const streaming = useMemo(() => agentStreamingContent(events), [events])
  const agentContextPressure = useMemo(() => readAgentContextPressure(agentProjections), [agentProjections])
  const agentContextBreakdown = useMemo(() => readAgentContextBreakdown(agentProjections), [agentProjections])
  const draftElements = useMemo(() => registry.elements.filter(item => item.owner === selectedDraft?.name), [registry, selectedDraft?.name])
  const draftVariables = useMemo(() => registry.variables.filter(item => item.owner === selectedDraft?.name), [registry, selectedDraft?.name])
  const matchedElement = useMemo(
    () => elementForSelection(selection, registry, selectedDraft?.name),
    [registry, selectedDraft?.name, selection],
  )
  const modifiedElementPrefix = selectedDraftId === undefined ? undefined : `${selectedDraftId}\0`
  const hasModifiedElementDefaults = modifiedElementPrefix !== undefined
    && [...modifiedElementDefaults].some(key => key.startsWith(modifiedElementPrefix))
  const hasModifiedElementStyles = selectedDraftId !== undefined && draftElements.some(element => {
    const key = `${selectedDraftId}\0${element.owner}\0${element.element.id}`
    return JSON.stringify(elementStyles[key] ?? []) !== (elementStyleBaselines.current.get(key) ?? '[]')
  })
  const hasModifiedElementSource = hasModifiedElementDefaults || hasModifiedElementStyles
  const previewInsets = previewFullscreen
    ? { left: 0, right: 0 }
    : {
        left: leftSidebarCollapsed ? 48 : leftSidebarWidth,
        right: rightSidebarCollapsed ? 56 : rightSidebarWidth,
      }
  const previewRect: LayoutRect = {
    x: previewOrigin.x,
    y: previewOrigin.y,
    width: previewViewport.width * previewScale,
    height: previewViewport.height * previewScale,
  }

  const fitPreviewToStage = (viewport = previewViewport): void => {
    const stage = previewStageRef.current
    if (stage === null) return
    const bounds = previewBounds(
      stage.clientWidth - previewInsets.left - previewInsets.right,
      stage.clientHeight,
    )
    bounds.x += previewInsets.left
    if (bounds.width < PREVIEW_MIN_SIZE.width || bounds.height < PREVIEW_MIN_SIZE.height) return
    const fitted = fitRect(bounds, viewport.width / viewport.height)
    setPreviewScale(fitted.width / viewport.width)
    setPreviewOrigin({ x: fitted.x, y: fitted.y })
  }

  const zoomPreviewByWheel = (deltaY: number, deltaMode: number): void => {
    const stage = previewStageRef.current
    if (stage === null) return
    const center = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }
    const current = previewTransformRef.current
    const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * stage.clientHeight : deltaY
    const scale = Math.max(0.01, current.scale * Math.exp(clamp(-delta * 0.0015, -0.35, 0.35)))
    const ratio = scale / current.scale
    const origin = {
      x: center.x - (center.x - current.origin.x) * ratio,
      y: center.y - (center.y - current.origin.y) * ratio,
    }
    previewTransformRef.current = { scale, origin }
    setPreviewScale(scale)
    setPreviewOrigin(origin)
  }

  const activateDraft = (draftId: string | undefined, sourceDrafts = draftsRef.current): void => {
    const nextSessionId = draftId === undefined
      ? currentInstanceRef.current?.agent?.sessionId
      : sourceDrafts.find(draft => draft.id === draftId)?.agent?.sessionId
    draftIdRef.current = draftId
    sessionRef.current = nextSessionId
    fileRequest.current += 1
    draftViewRequest.current += 1
    packRequest.current += 1
    setFileBusy(false)
    setFiles([])
    setFilePath('')
    setSource('')
    setSavedSource('')
    setReadiness({ findings: [] })
    if (draftId === undefined) {
      setPanel(current => current === 'selection' || current === 'agent' ? current : 'agent')
      setLeftPanel('instance')
    }
    setSelectedDraftId(draftId)
    setSessionId(nextSessionId)
    setEvents([])
    setAgentModels(undefined)
    setAgentProjections({})
    setHasOlderMessages(false)
    setLoadingOlderMessages(false)
    runningVersion.current += 1
    setRunning(false)
  }

  useEffect(() => {
    sessionRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    const request = ++agentModelRequest.current
    setAgentModels(undefined)
    setAgentProjections({})
    setLoadingAgentModels(sessionId !== undefined)
    setSelectingAgentModel(false)
    if (sessionId === undefined) return
    void studioApi.sessions.models({ sessionId: sessionId as SessionId }).then(response => {
      if (agentModelRequest.current !== request || sessionRef.current !== sessionId) return
      setAgentModels(apiValue(response))
    }).catch(cause => {
      if (agentModelRequest.current === request && sessionRef.current === sessionId) setError(localizeError(cause))
    }).finally(() => {
      if (agentModelRequest.current === request && sessionRef.current === sessionId) setLoadingAgentModels(false)
    })
  }, [sessionId])

  useEffect(() => {
    setProject(selectedDraft?.project)
    setDraftLabelInput(selectedDraft?.label ?? '')
    terminalPinnedRef.current = true
  }, [selectedDraftId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal !== null && terminalPinnedRef.current) terminal.scrollTop = terminal.scrollHeight
  }, [terminalOutput])

  useEffect(() => {
    const stage = previewStageRef.current
    if (stage === null) return
    const update = (): void => {
      setPreviewStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    }
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    update()
    fitPreviewToStage()
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => activeDragCleanupRef.current?.(), [])

  useEffect(() => {
    const receiveBridge = (event: MessageEvent): void => previewBridgeHandlerRef.current(event)
    window.addEventListener('message', receiveBridge)
    return () => window.removeEventListener('message', receiveBridge)
  }, [])

  useEffect(() => {
    if (previewZoomFocus?.phase !== 'fading') return
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? PREVIEW_ZOOM_FOCUS_REDUCED_FADE_MS
      : PREVIEW_ZOOM_FOCUS_FADE_MS
    const timeout = window.setTimeout(() => {
      setPreviewZoomFocus(current => current?.phase === 'fading' ? undefined : current)
    }, duration)
    return () => window.clearTimeout(timeout)
  }, [previewZoomFocus?.phase])

  useEffect(() => {
    const fadePreviewZoomFocus = (): void => {
      setPreviewZoomFocus(current => current?.phase === 'active'
        ? { ...current, phase: 'fading' }
        : current)
    }
    window.addEventListener('blur', fadePreviewZoomFocus)
    return () => window.removeEventListener('blur', fadePreviewZoomFocus)
  }, [])

  useEffect(() => {
    if (sessionId === undefined) return
    let current = true
    const initialRunningVersion = runningVersion.current
    void Promise.all([
      studioApi.sessions.history({ sessionId: sessionId as SessionId, maxMessages: 50 }),
      studioApi.sessions.list({}),
    ]).then(([historyResponse, listResponse]) => {
      if (!current) return
      const history = apiValue(historyResponse)
      const sessions = apiValue(listResponse)
      const restored = history.events as HistoryEntry[]
      setEvents(live => [...restored, ...live.filter(entry => !restored.some(item => item.event.seq === entry.event.seq))]
        .sort((a, b) => a.event.seq - b.event.seq))
      setAgentProjections(current => mergeAgentProjectionBaseline(current, history.projections))
      setHasOlderMessages(history.hasMore)
      if (runningVersion.current === initialRunningVersion) {
        setRunning(sessions.items.some(item => item.sessionId === sessionId && item.running))
      }
    })
      .catch(cause => {
        if (current) setError(localizeError(cause))
      })
    return () => { current = false }
  }, [sessionId])

  useEffect(() => {
    if (panel !== 'agent' || !agentTargetReady || sessionId !== undefined) return
    const attached = new Set(attachedAgentSessionIds.split('\0').filter(Boolean))
    setAgentSessions([])
    setSelectedAgentSessionId('')
    const loader = startAgentSessionLoader({
      async load() {
        const response = await studioApi.sessions.list({})
        return availableAgentSessions(apiValue(response).items, attached)
      },
      onData(sessions) {
        const previousError = agentSessionLoadErrorRef.current
        agentSessionLoadErrorRef.current = undefined
        if (previousError !== undefined) {
          setError(current => current === previousError ? undefined : current)
        }
        setAgentSessions(sessions)
        setSelectedAgentSessionId(selected => sessions.some(session => String(session.sessionId) === selected) ? selected : '')
      },
      onError(cause) {
        const message = localizeError(cause)
        agentSessionLoadErrorRef.current = message
        setError(message)
      },
      onInitialLoading: setLoadingAgentSessions,
    })
    refreshAgentSessionsRef.current = loader.refresh
    window.addEventListener('focus', loader.refresh)
    return () => {
      if (refreshAgentSessionsRef.current === loader.refresh) refreshAgentSessionsRef.current = undefined
      window.removeEventListener('focus', loader.refresh)
      loader.dispose()
    }
  }, [panel, agentTargetReady, sessionId, attachedAgentSessionIds])

  useEffect(() => {
    projectRef.current = project
  }, [project])

  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  useEffect(() => {
    currentInstanceRef.current = currentInstance
  }, [currentInstance])

  useEffect(() => {
    if (selectedDraftId === undefined || project === undefined) return
    setDrafts(current => current.map(draft => draft.id === selectedDraftId ? { ...draft, project } : draft))
  }, [project, selectedDraftId])

  const queuePreviewUpdate = (target: string, update: Record<string, unknown>): void => {
    previewUpdateQueue.current = previewUpdateQueue.current.then(async () => {
      await callStudio(target === CURRENT_INSTANCE_KEY ? 'studio.current.preview.update' : 'studio.preview.update',
        target === CURRENT_INSTANCE_KEY ? update : { draftId: target, ...update })
    }).catch(() => undefined)
  }

  const reloadPreview = (draftId: string): void => {
    setPreviewVersions(current => ({ ...current, [draftId]: (current[draftId] ?? 0) + 1 }))
  }

  const clearElementModifications = (draftId: string): void => {
    const prefix = `${draftId}\0`
    for (const key of sourceVariableBaselines.current.keys()) {
      if (key.startsWith(prefix)) sourceVariableBaselines.current.delete(key)
    }
    for (const key of elementStyleBaselines.current.keys()) {
      if (key.startsWith(prefix)) elementStyleBaselines.current.delete(key)
    }
    setModifiedElementDefaults(current => {
      if (![...current].some(key => key.startsWith(prefix))) return current
      return new Set([...current].filter(key => !key.startsWith(prefix)))
    })
    setElementStyles(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
    setElementSelectorCandidates(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))))
  }

  const queueWorkspaceUpdate = (open: string[], selected: string | undefined): void => {
    const next: StudioWorkspaceState = {
      openDraftIds: open,
      ...(selected === undefined ? {} : { selectedDraftId: selected }),
    }
    workspaceUpdateQueue.current = workspaceUpdateQueue.current.then(async () => {
      await callStudio<StudioWorkspaceState>('studio.workspace.update', next)
    }).catch(cause => {
      setError(localizeError(cause))
    })
  }

  useEffect(() => {
    previewModeRef.current = previewMode
  }, [previewMode])

  useEffect(() => {
    previewTransformRef.current = { scale: previewScale, origin: previewOrigin }
  }, [previewOrigin, previewScale])

  useEffect(() => {
    if (!previewFullscreen) return
    const exit = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewFullscreen(false)
    }
    window.addEventListener('keydown', exit)
    return () => window.removeEventListener('keydown', exit)
  }, [previewFullscreen])

  useEffect(() => {
    const connection = previewConnections.current.get(activePreviewKey)
    const frame = requestAnimationFrame(() => connection?.port.postMessage({
      type: 'refresh-overlay',
      sessionId: connection.sessionId,
      nonce: connection.nonce,
    }))
    return () => cancelAnimationFrame(frame)
  }, [previewScale, previewSession, previewViewport.height, previewViewport.width, activePreviewKey])

  useEffect(() => {
    setElementSourceMessage(undefined)
  }, [selectedDraftId])

  const draftElementIdentity = draftElements.map(item => `${item.owner}\0${item.element.id}\0${item.element.source.file}`).join('\n')
  useEffect(() => {
    if (selectedDraftId === undefined || draftElements.length === 0) return
    const draftId = selectedDraftId
    void previewUpdateQueue.current
      .then(() => callStudio<StudioElementStyleSource[]>('studio.elements.styles', { draftId }))
      .then(sources => {
        if (draftIdRef.current !== draftId) return
        setElementStyles(current => {
          const next = { ...current }
          for (const element of draftElements) {
            const key = `${draftId}\0${element.owner}\0${element.element.id}`
            if (elementStyleBaselines.current.has(key)) continue
            const rules = sources.find(item => item.elementId === element.element.id)?.rules ?? []
            next[key] = rules
            elementStyleBaselines.current.set(key, JSON.stringify(rules))
          }
          return next
        })
      }).catch(cause => {
        if (draftIdRef.current === draftId) setError(localizeError(cause))
      })
  }, [draftElementIdentity, selectedDraftId])

  useEffect(() => {
    for (const pending of pendingVariableResults.current.values()) pending.reject(new Error('Preview bridge changed'))
    pendingVariableResults.current.clear()
    selectionResolve.current += 1
    setRegistry(EMPTY_REGISTRY)
    setSelection(undefined)
    const target = selectedDraftId ?? CURRENT_INSTANCE_KEY
    void callStudio<StudioPreviewStatus>(target === CURRENT_INSTANCE_KEY ? 'studio.current.preview.status' : 'studio.preview.status',
      target === CURRENT_INSTANCE_KEY ? {} : { draftId: target }).then(status => {
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) !== target) return
      previewModeRef.current = status.mode
      setPreviewMode(status.mode)
      setRegistry(status.registry ?? EMPTY_REGISTRY)
      setSelection(status.selection)
    }).catch(() => undefined)
  }, [previewSession, selectedDraftId])

  useEffect(() => () => {
    for (const connection of previewConnections.current.values()) connection.port.close()
    previewConnections.current.clear()
  }, [])

  useEffect(() => {
    void Promise.all([
      callStudio<StudioCurrentInstanceView>('studio.current.get', {}),
      callStudio<StudioDraftView[]>('studio.drafts.list', {}),
      callStudio<StudioWorkspaceState>('studio.workspace.get', {}),
    ]).then(([current, next, workspace]) => {
      currentInstanceRef.current = current
      setCurrentInstance(current)
      setDrafts(next)
      setOpenDraftIds(workspace.openDraftIds)
      activateDraft(workspace.selectedDraftId, next)
    }).catch(cause => setError(localizeError(cause)))
      .finally(() => setLoadingDrafts(false))
  }, [])

  useEffect(() => {
    if (!hasLiveDraft) return
    let active = true
    let timer: number | undefined
    const sync = async (): Promise<void> => {
      try {
        const next = await callStudio<StudioDraftView[]>('studio.drafts.list', {})
        if (active) setDrafts(next)
      } catch {
        // The regular connection state reports transport failures.
      } finally {
        if (active) timer = window.setTimeout(() => void sync(), 250)
      }
    }
    timer = window.setTimeout(() => void sync(), 250)
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [hasLiveDraft])

  useEffect(() => subscribeStudioEvents(envelope => {
    const frame = envelope.payload
    setAgentInteractions(current => updateAgentInteractions(current, envelope))
    if (frame.type === 'host/session-added'
      || frame.type === 'host/session-removed'
      || frame.type === 'host/session-status') {
      refreshAgentSessionsRef.current?.()
    }
    const frameSessionId = eventSessionId(envelope)
    if (frame.type === 'host/session-removed' && frameSessionId !== undefined) {
      setAgentQueues(current => {
        const next = { ...current }
        delete next[frameSessionId]
        return next
      })
    }
    if (frame.type === 'session/queue' && frameSessionId !== undefined && Array.isArray(frame.items)) {
      const items = agentQueueItems(frame.items)
      setAgentQueues(current => ({ ...current, [frameSessionId]: items }))
    }
    const current = sessionRef.current
    if (current === undefined || frameSessionId !== current) return
    if (frame.type === 'host/session-status') {
      runningVersion.current += 1
      setRunning(frame.running === true)
    }
    if (frame.type === 'session/projection' && typeof frame.key === 'string'
      && typeof frame.seq === 'number' && Number.isFinite(frame.seq)) {
      const projectionKey = frame.key
      const projectionSeq = frame.seq
      setAgentProjections(previous => mergeAgentProjectionFrame(previous, projectionKey, frame.value, projectionSeq))
      return
    }
    if (frame.type !== 'session/event' || typeof frame.event !== 'object' || frame.event === null) return
    const event = frame.event as HistoryEntry['event']
    const entry: StudioConversationEntry = {
      event,
      view: frame.view as HistoryEntry['view'],
    }
    setEvents(previous => previous.some(item => item.event.seq === event.seq)
      ? previous
      : [...previous, entry].sort((a, b) => a.event.seq - b.event.seq))
    if (event.type === 'tool/result') {
      const currentDraft = draftIdRef.current
      if (currentDraft === undefined) return
      const request = ++draftViewRequest.current
      void Promise.all([
        callStudio<StudioProjectState>('studio.project.state', { draftId: currentDraft }),
        callStudio<StudioProjectFile[]>('studio.project.files', { draftId: currentDraft }),
        callStudio<StudioReadinessReport>('studio.readiness.inspect', { draftId: currentDraft }),
      ]).then(([next, nextFiles, nextReadiness]) => {
        if (draftViewRequest.current !== request || draftIdRef.current !== currentDraft) return
        const previous = projectRef.current
        projectRef.current = next
        setProject(next)
        setFiles(nextFiles)
        setReadiness(nextReadiness)
        if (next.state === 'preview-pending'
          && (previous?.state !== 'preview-pending' || previous.graphRev !== next.graphRev)) {
          reloadPreview(currentDraft)
        }
      }).catch(() => undefined)
    }
  }, setConnected), [])

  useEffect(() => {
    if (project?.root === undefined || selectedDraftId === undefined) {
      draftViewRequest.current += 1
      setFiles([])
      setFilePath('')
      setSource('')
      setSavedSource('')
      setReadiness({ findings: [] })
      return
    }
    const draftId = selectedDraftId
    const request = ++draftViewRequest.current
    void Promise.all([
      callStudio<StudioProjectFile[]>('studio.project.files', { draftId }),
      callStudio<StudioReadinessReport>('studio.readiness.inspect', { draftId }),
    ]).then(([nextFiles, nextReadiness]) => {
      if (draftViewRequest.current !== request || draftIdRef.current !== draftId) return
      setFiles(nextFiles)
      setReadiness(nextReadiness)
    }).catch(cause => {
      if (draftViewRequest.current === request && draftIdRef.current === draftId) {
        setError(localizeError(cause))
      }
    })
  }, [project?.root, selectedDraftId, t])

  const updateDraft = (next: StudioDraftView): void => {
    setDrafts(current => current.some(draft => draft.id === next.id)
      ? current.map(draft => draft.id === next.id ? next : draft)
      : [...current, next])
    if (draftIdRef.current === next.id) setProject(next.project)
  }

  const updateDraftProject = (draftId: string, next: StudioProjectState): void => {
    setDrafts(current => current.map(draft => draft.id === draftId ? { ...draft, project: next } : draft))
    if (draftIdRef.current !== draftId) return
    projectRef.current = next
    setProject(next)
  }

  const createDraft = async (input: StudioCreateDraftInput): Promise<void> => {
    if (hasUnsavedSource) {
      setPanel('source')
      throw new Error(t('errorUnsavedCreate'))
    }
    setError(undefined)
    const next = await callStudio<StudioDraftView>('studio.drafts.create', input)
    updateDraft(next)
    const nextOpenDraftIds = openDraftIds.includes(next.id) ? openDraftIds : [...openDraftIds, next.id]
    setOpenDraftIds(nextOpenDraftIds)
    activateDraft(next.id)
    queueWorkspaceUpdate(nextOpenDraftIds, next.id)
    setProject(next.project)
    setCreateDialogOpen(false)
  }

  const exportDraft = async (): Promise<void> => {
    if (selectedDraftId === undefined || selectedDraft?.destinationDirectory === undefined) return
    if (hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedExport'))
      return
    }
    const draftId = selectedDraftId
    setExportingDraftId(draftId)
    setError(undefined)
    try {
      updateDraft(await callStudio<StudioDraftView>('studio.drafts.export', { draftId }))
    } catch (cause) {
      if (draftIdRef.current === draftId) setError(localizeError(cause))
    } finally {
      setExportingDraftId(current => current === draftId ? undefined : current)
    }
  }

  const renameDraft = async (): Promise<void> => {
    if (selectedDraft === undefined) return
    const draftId = selectedDraft.id
    const previousLabel = selectedDraft.label
    const label = draftLabelInput.trim()
    if (label === selectedDraft.label) return
    if (label === '') {
      setDraftLabelInput(selectedDraft.label)
      setError(t('errorEmptyDraftName'))
      return
    }
    setError(undefined)
    try {
      updateDraft(await callStudio<StudioDraftView>('studio.drafts.rename', { draftId, label }))
      if (draftIdRef.current === draftId) setDraftLabelInput(label)
    } catch (cause) {
      if (draftIdRef.current === draftId) {
        setDraftLabelInput(previousLabel)
        setError(localizeError(cause))
      }
    }
  }

  const clearSelectedRuntime = (draftId: string): void => {
    if (draftIdRef.current !== draftId) return
    sessionRef.current = undefined
    setSessionId(undefined)
    setEvents([])
    setHasOlderMessages(false)
    setRunning(false)
    setSelection(undefined)
    setReadiness({ findings: [] })
  }

  const runDraftStart = async (restart: boolean): Promise<void> => {
    if (selectedDraftId === undefined) return
    const id = selectedDraftId
    setInstanceOperations(current => ({ ...current, [id]: restart ? 'restart' : 'start' }))
    setError(undefined)
    let polling = true
    const syncProgress = async (): Promise<void> => {
      while (polling) {
        try {
          const next = await callStudio<StudioDraftView[]>('studio.drafts.list', {})
          if (!polling) return
          const draft = next.find(candidate => candidate.id === id)
          if (draft !== undefined) updateDraft(draft)
        } catch {
          return
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    const progress = syncProgress()
    try {
      if (restart) {
        updateDraft(await callStudio<StudioDraftView>('studio.drafts.stop', { draftId: id }))
        clearSelectedRuntime(id)
      }
      const next = await callStudio<StudioDraftView>('studio.drafts.start', { draftId: id })
      polling = false
      updateDraft(next)
      reloadPreview(id)
    } catch (cause) {
      polling = false
      try {
        const next = await callStudio<StudioDraftView[]>('studio.drafts.list', {})
        const draft = next.find(candidate => candidate.id === id)
        if (draft !== undefined) updateDraft(draft)
      } catch {}
      if (draftIdRef.current === id) setError(localizeError(cause))
    } finally {
      polling = false
      await progress
      setInstanceOperations(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }

  const startDraft = (): Promise<void> => runDraftStart(false)
  const restartDraft = (): Promise<void> => runDraftStart(true)

  const stopDraft = async (): Promise<void> => {
    if (selectedDraftId === undefined) return
    const id = selectedDraftId
    setInstanceOperations(current => ({ ...current, [id]: 'stop' }))
    setError(undefined)
    try {
      updateDraft(await callStudio<StudioDraftView>('studio.drafts.stop', { draftId: id }))
      clearSelectedRuntime(id)
    } catch (cause) {
      if (draftIdRef.current === id) setError(localizeError(cause))
    } finally {
      setInstanceOperations(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }

  const applyDraftBuild = async (draftId: string, preserveElementState = false): Promise<StudioBuildResult> => {
    const result = await callStudio<StudioBuildResult>('studio.project.build', { draftId })
    setBuildOutputs(current => ({ ...current, [draftId]: result.build }))
    updateDraftProject(draftId, result.project)
    if (!preserveElementState) clearElementModifications(draftId)
    reloadPreview(draftId)
    return result
  }

  const hotReloadDraft = async (): Promise<void> => {
    if (selectedDraftId === undefined) return
    if (hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedReload'))
      return
    }
    const id = selectedDraftId
    setBuildOperations(current => ({ ...current, [id]: true }))
    setError(undefined)
    try {
      await applyDraftBuild(id)
    } catch (cause) {
      if (draftIdRef.current === id) setError(localizeError(cause))
    } finally {
      setBuildOperations(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }

  const confirmPreview = async (draftId: string, graphRev: string): Promise<void> => {
    const draft = draftsRef.current.find(candidate => candidate.id === draftId)
    if (draft?.project?.state !== 'preview-pending' || confirmingDrafts.current.has(draftId)) return
    confirmingDrafts.current.add(draftId)
    if (draftIdRef.current === draftId) setError(undefined)
    try {
      const active = await callStudio<StudioProjectState>('studio.project.activate', { draftId, graphRev })
      updateDraftProject(draftId, active)
    } catch (cause) {
      if (draftIdRef.current === draftId) setError(localizeError(cause))
    } finally {
      confirmingDrafts.current.delete(draftId)
    }
  }

  const connectPreview = (event: MessageEvent): void => {
    const draft = draftsRef.current.find(candidate => previewFrames.current.get(candidate.id)?.contentWindow === event.source)
    const current = currentInstanceRef.current
    const currentTarget = previewFrames.current.get(CURRENT_INSTANCE_KEY)?.contentWindow === event.source ? current : undefined
    const targetKey = draft?.id ?? (currentTarget === undefined ? undefined : CURRENT_INSTANCE_KEY)
    const previewUrl = draft?.runtime.previewUrl ?? currentTarget?.previewUrl
    const sessionId = draft?.runtime.bridgeCapability ?? currentTarget?.bridgeCapability
    if (targetKey === undefined || previewUrl === undefined || sessionId === undefined) return
    if (event.origin !== new URL(previewUrl).origin || event.ports.length !== 1 || !isBridgeOffer(event.data, sessionId)) return
    previewConnections.current.get(targetKey)?.port.close()
    const nextPort = event.ports[0]
    const nonce = nextBrowserId()
    const connection = { port: nextPort, sessionId, nonce }
    previewConnections.current.set(targetKey, connection)
    nextPort.onmessage = portEvent => {
      if (!isBridgeEnvelope(portEvent.data, sessionId, nonce)
        || previewConnections.current.get(targetKey)?.port !== nextPort) return
      const message = portEvent.data
      const active = (draftIdRef.current ?? CURRENT_INSTANCE_KEY) === targetKey
      if (message.type === 'preview-ready' && boundedBridgeText(message.graphRev) && message.graphRev !== ''
        && (message.mode === 'browse' || message.mode === 'inspect')) {
        const mode = active ? previewModeRef.current : message.mode
        nextPort.postMessage({ type: 'set-mode', sessionId, nonce, mode })
        queuePreviewUpdate(targetKey, {
          connected: true,
          graphRev: message.graphRev,
          mode,
        })
        if (draft !== undefined) void confirmPreview(draft.id, message.graphRev)
      }
      if (message.type === 'selection' && isStudioDomSelection(message.selection)) {
        const raw = message.selection
        const request = ++selectionResolve.current
        const commit = (next: StudioDomSelection): void => {
          if (request !== selectionResolve.current || previewConnections.current.get(targetKey)?.port !== nextPort) return
          if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === targetKey) {
            setSelection(next)
            if (previewModeRef.current === 'inspect') setPanel('selection')
          }
          queuePreviewUpdate(targetKey, { connected: true, mode: 'inspect', selection: next })
        }
        if (raw.react?.source === undefined) commit(raw)
        else void callStudio<StudioSourceCandidate>(draft === undefined
          ? 'studio.current.resolveSource' : 'studio.preview.resolveSource', draft === undefined
          ? { source: raw.react.source }
          : { draftId: draft.id, source: raw.react.source }).then(resolved => commit({
          ...raw,
          react: { ...raw.react!, source: { ...raw.react!.source!, resolved } },
        })).catch(cause => {
          if (request === selectionResolve.current && (draftIdRef.current ?? CURRENT_INSTANCE_KEY) === targetKey) {
            setError(localizeError(cause))
          }
        })
      }
      if (active && message.type === 'preview-pan' && isFinitePreviewPan(message)) {
        setPreviewOrigin(current => ({
          x: current.x + message.dx,
          y: current.y + message.dy,
        }))
      }
      if (active && message.type === 'preview-zoom' && isFinitePreviewZoom(message)) {
        zoomPreviewByWheel(message.deltaY, message.deltaMode)
      }
      if (message.type === 'registry' && isStudioRegistrySnapshot(message.registry)) {
        const nextRegistry = message.registry
        if (active) setRegistry(nextRegistry)
        queuePreviewUpdate(targetKey, {
          connected: true,
          mode: active ? previewModeRef.current : 'browse',
          registry: nextRegistry,
        })
      }
      if (active && message.type === 'registry-error' && boundedBridgeText(message.error)) {
        setError(studioErrorCodeMessage(boundedBridgeText(message.code) ? message.code : 'preview-registry', message.error, t))
      }
      if (active && message.type === 'selection-error' && boundedBridgeText(message.error)) {
        setError(studioErrorCodeMessage(boundedBridgeText(message.code) ? message.code : 'preview-selection', message.error, t))
      }
      if (message.type === 'variable-result' && boundedBridgeText(message.requestId)) {
        const pending = pendingVariableResults.current.get(message.requestId)
        if (pending !== undefined) {
          pendingVariableResults.current.delete(message.requestId)
          if (message.ok === true) pending.resolve()
          else pending.reject(new Error(boundedBridgeText(message.error) ? message.error : 'Preview variable update failed'))
        }
        if (active && message.ok === false && boundedBridgeText(message.error)) {
          setError(studioErrorCodeMessage(boundedBridgeText(message.code) ? message.code : 'preview-variable', message.error, t))
        }
      }
      if (active && message.type === 'element-style-result' && message.ok === false && boundedBridgeText(message.error)) {
        setError(studioErrorCodeMessage(boundedBridgeText(message.code) ? message.code : 'preview-style', message.error, t))
      }
      if (message.type === 'element-style-selectors' && boundedBridgeText(message.owner)
        && boundedBridgeText(message.elementId) && Array.isArray(message.candidates)
        && message.candidates.length <= 500 && message.candidates.every(candidate => boundedBridgeText(candidate))) {
        const key = `${targetKey}\0${message.owner}\0${message.elementId}`
        setElementSelectorCandidates(current => ({ ...current, [key]: message.candidates as string[] }))
      }
      if (active && message.type === 'mode' && (message.mode === 'browse' || message.mode === 'inspect')) {
        previewModeRef.current = message.mode
        setPreviewMode(message.mode)
      }
    }
    nextPort.start()
    nextPort.postMessage({ type: 'connect', sessionId, nonce })
  }
  previewBridgeHandlerRef.current = connectPreview

  const previewFrameRef = (draftId: string): ((node: HTMLIFrameElement | null) => void) => {
    const existing = previewFrameRefs.current.get(draftId)
    if (existing !== undefined) return existing
    const ref = (node: HTMLIFrameElement | null): void => {
      if (node !== null) {
        previewFrames.current.set(draftId, node)
        return
      }
      previewFrames.current.delete(draftId)
      const connection = previewConnections.current.get(draftId)
      if (connection === undefined) return
      connection.port.close()
      previewConnections.current.delete(draftId)
      clearElementModifications(draftId)
      queuePreviewUpdate(draftId, {
        connected: false,
        mode: 'browse',
        selection: null,
        registry: null,
      })
    }
    previewFrameRefs.current.set(draftId, ref)
    return ref
  }

  const openFile = async (path: string): Promise<void> => {
    if (path === '' || selectedDraftId === undefined) return
    if (path === filePath) return
    if (hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedOpenFile'))
      return
    }
    const draftId = selectedDraftId
    const request = ++fileRequest.current
    setFileBusy(true)
    setError(undefined)
    try {
      const file = await callStudio<{ path: string; content: string }>('studio.project.readFile', { draftId, path })
      if (fileRequest.current !== request || draftIdRef.current !== draftId) return
      setFilePath(file.path)
      setSource(file.content)
      setSavedSource(file.content)
    } catch (cause) {
      if (fileRequest.current === request && draftIdRef.current === draftId) {
        setError(localizeError(cause))
      }
    } finally {
      if (fileRequest.current === request && draftIdRef.current === draftId) setFileBusy(false)
    }
  }

  const saveFile = async (): Promise<void> => {
    if (filePath === '' || selectedDraftId === undefined) return
    const draftId = selectedDraftId
    const path = filePath
    const content = source
    const request = ++fileRequest.current
    setFileBusy(true)
    setError(undefined)
    try {
      await callStudio('studio.project.writeFile', { draftId, path, content })
      if (fileRequest.current !== request || draftIdRef.current !== draftId) return
      setSavedSource(content)
      void callStudio<StudioReadinessReport>('studio.readiness.inspect', { draftId }).then(next => {
        if (fileRequest.current === request && draftIdRef.current === draftId) setReadiness(next)
      }).catch(() => undefined)
    } catch (cause) {
      if (fileRequest.current === request && draftIdRef.current === draftId) {
        setError(localizeError(cause))
      }
    } finally {
      if (fileRequest.current === request && draftIdRef.current === draftId) setFileBusy(false)
    }
  }

  const saveElementDefaults = async (): Promise<void> => {
    if (selectedDraftId === undefined || !hasModifiedElementSource) return
    if (hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedElementSave'))
      return
    }
    const draftId = selectedDraftId
    setElementSourceBusy(true)
    setBuildOperations(current => ({ ...current, [draftId]: true }))
    setElementSourceMessage(undefined)
    setError(undefined)
    try {
      await variableUpdateTail.current
      await previewUpdateQueue.current
      const styles: StudioElementStyleSource[] = draftElements.flatMap(element => {
        const key = elementStyleKey(draftId, element)
        if (!elementStyleBaselines.current.has(key) && !Object.hasOwn(elementStyles, key)) return []
        return [{ elementId: element.element.id, rules: elementStyles[key] ?? [] }]
      })
      const result = await callStudio<{ files: string[] }>('studio.elements.saveSource', { draftId, styles })
      if (filePath !== '' && result.files.includes(filePath)) {
        const file = await callStudio<{ path: string; content: string }>('studio.project.readFile', { draftId, path: filePath })
        if (draftIdRef.current === draftId && file.path === filePath) {
          setSource(file.content)
          setSavedSource(file.content)
        }
      }
      await applyDraftBuild(draftId, true)
      if (draftIdRef.current === draftId) {
        for (const element of draftElements) {
          for (const definition of flattenVariableTree(element.element.variables ?? [])) {
            if (definition.defaultSource === undefined) continue
            sourceVariableBaselines.current.set(
              `${draftId}\0${element.owner}\0${element.element.id}\0${definition.id}`,
              element.values[definition.id]!,
            )
          }
          const key = elementStyleKey(draftId, element)
          if (styles.some(item => item.elementId === element.element.id)) {
            elementStyleBaselines.current.set(key, JSON.stringify(elementStyles[key] ?? []))
          }
        }
        setModifiedElementDefaults(current => new Set([...current].filter(key => !key.startsWith(`${draftId}\0`))))
        setElementSourceMessage(t('elementSourceSaved', { count: result.files.length }))
      }
      void callStudio<StudioReadinessReport>('studio.readiness.inspect', { draftId }).then(next => {
        if (draftIdRef.current === draftId) setReadiness(next)
      }).catch(() => undefined)
    } catch (cause) {
      if (draftIdRef.current === draftId) setError(localizeError(cause))
    } finally {
      setElementSourceBusy(false)
      setBuildOperations(current => {
        const next = { ...current }
        delete next[draftId]
        return next
      })
    }
  }

  useEffect(() => {
    const save = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (!fileBusy && filePath !== '' && source !== savedSource) void saveFile()
    }
    window.addEventListener('keydown', save, { capture: true })
    return () => window.removeEventListener('keydown', save, { capture: true })
  }, [fileBusy, filePath, savedSource, selectedDraftId, source])

  useEffect(() => {
    if (!hasUnsavedSource) return
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedSource])

  const changePreviewMode = (mode: 'browse' | 'inspect'): void => {
    previewModeRef.current = mode
    setPreviewMode(mode)
    const target = selectedDraftId ?? CURRENT_INSTANCE_KEY
    const connection = previewConnections.current.get(target)
    connection?.port.postMessage({ type: 'set-mode', sessionId: connection.sessionId, nonce: connection.nonce, mode })
    queuePreviewUpdate(target, { connected: true, mode })
  }

  const setVariable = (
    target: StudioVariableUpdate,
    sourceBaseline?: StudioVariableValue,
  ): void => {
    setError(undefined)
    if (selectedDraftId === undefined) return
    const draftId = selectedDraftId
    const connection = previewConnections.current.get(draftId)
    if (connection === undefined) return
    const requestId = nextBrowserId()
    const result = new Promise<void>((resolve, reject) => {
      pendingVariableResults.current.set(requestId, { resolve, reject })
    })
    variableUpdateTail.current = variableUpdateTail.current.catch(() => undefined).then(() => result)
    void variableUpdateTail.current.catch(() => undefined)
    if (target.scope === 'element' && sourceBaseline !== undefined) {
      const key = `${draftId}\0${target.owner}\0${target.elementId}\0${target.variableId}`
      if (!sourceVariableBaselines.current.has(key)) sourceVariableBaselines.current.set(key, sourceBaseline)
      void result.then(() => {
        const baseline = sourceVariableBaselines.current.get(key)
        setModifiedElementDefaults(current => {
          const next = new Set(current)
          if (Object.is(target.value, baseline)) next.delete(key)
          else next.add(key)
          return next
        })
      }).catch(() => undefined)
    }
    connection.port.postMessage({
      type: 'set-variable',
      requestId,
      sessionId: connection.sessionId,
      nonce: connection.nonce,
      target,
    })
  }

  const elementStyleKey = (draftId: string, element: StudioElementSnapshot): string =>
    `${draftId}\0${element.owner}\0${element.element.id}`

  const addElementStyleRule = (element: StudioElementSnapshot, selector: string): void => {
    if (selectedDraftId === undefined) return
    const key = elementStyleKey(selectedDraftId, element)
    setElementStyles(current => ({
      ...current,
      [key]: [...(current[key] ?? []), { selector, declarations: [] }],
    }))
  }

  const requestElementStyleSelectors = (element: StudioElementSnapshot): void => {
    if (selectedDraftId === undefined) return
    const connection = previewConnections.current.get(selectedDraftId)
    connection?.port.postMessage({
      type: 'get-element-style-selectors', requestId: nextBrowserId(),
      sessionId: connection.sessionId, nonce: connection.nonce,
      target: {
        owner: element.owner,
        elementId: element.element.id,
        boundary: { surfaceId: element.element.boundary.surfaceId, path: [...element.element.boundary.path] },
      },
    })
  }

  const setElementStyle = (element: StudioElementSnapshot, selector: string, property: string, value?: string): void => {
    if (selectedDraftId === undefined) return
    const connection = previewConnections.current.get(selectedDraftId)
    if (connection === undefined) return
    const draftId = selectedDraftId
    const target: StudioElementStyleTarget = {
      owner: element.owner,
      elementId: element.element.id,
      boundary: { surfaceId: element.element.boundary.surfaceId, path: [...element.element.boundary.path] },
      selector,
      property,
      ...(value === undefined ? {} : { value }),
    }
    connection.port.postMessage({
      type: 'set-element-style', requestId: nextBrowserId(), sessionId: connection.sessionId, nonce: connection.nonce, target,
    })
    setElementStyles(current => {
      const key = elementStyleKey(draftId, element)
      const rules = current[key] ?? []
      const existing = rules.find(rule => rule.selector === selector)
      const declarations = existing?.declarations ?? []
      const nextDeclarations = value === undefined
        ? declarations.filter(declaration => declaration.property !== property)
        : [...declarations.filter(declaration => declaration.property !== property), { property, value }]
      const nextRule = { selector, declarations: nextDeclarations }
      return { ...current, [key]: [...rules.filter(rule => rule.selector !== selector), nextRule] }
    })
  }

  const removeElementStyleRule = (element: StudioElementSnapshot, selector: string): void => {
    if (selectedDraftId === undefined) return
    const key = elementStyleKey(selectedDraftId, element)
    const rule = elementStyles[key]?.find(candidate => candidate.selector === selector)
    for (const declaration of rule?.declarations ?? []) setElementStyle(element, selector, declaration.property)
    setElementStyles(current => ({
      ...current,
      [key]: (current[key] ?? []).filter(candidate => candidate.selector !== selector),
    }))
  }

  const togglePreviewFullscreen = (): void => {
    setPreviewZoomFocus(undefined)
    setPreviewFullscreen(current => !current)
  }

  const togglePreviewAspectLock = (): void => {
    setPreviewAspectLocked(current => {
      if (!current) previewLockedAspectRatioRef.current = previewViewport.width / previewViewport.height
      return !current
    })
  }

  const runPack = async (): Promise<void> => {
    if (project === undefined || selectedDraftId === undefined) return
    const draftId = selectedDraftId
    const request = ++packRequest.current
    setPackingDraftId(draftId)
    setError(undefined)
    try {
      const next = await callStudio<StudioReadinessReport>('studio.readiness.pack', { draftId })
      if (packRequest.current === request && draftIdRef.current === draftId) setReadiness(next)
    } catch (cause) {
      if (packRequest.current === request && draftIdRef.current === draftId) {
        setError(localizeError(cause))
      }
    } finally {
      setPackingDraftId(current => current === draftId ? undefined : current)
    }
  }

  const createAgent = async (): Promise<void> => {
    if (!agentTargetReady) return
    const draftId = selectedDraftId
    const currentTarget = draftId === undefined
    const target = draftId ?? CURRENT_INSTANCE_KEY
    const projectName = currentTarget ? 'Current WebUI' : project?.name ?? 'Draft'
    setCreatingAgentDraftId(target)
    setError(undefined)
    try {
      const result = await callStudio<StudioAgentBinding>(currentTarget
        ? 'studio.current.agent.create' : 'studio.agent.create', currentTarget ? {} : { draftId })
      if (currentTarget) {
        setCurrentInstance(current => current === undefined ? current : { ...current, agent: result })
        if (currentInstanceRef.current !== undefined) currentInstanceRef.current = { ...currentInstanceRef.current, agent: result }
      } else {
        setDrafts(current => current.map(draft => draft.id === draftId ? { ...draft, agent: result } : draft))
      }
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) {
        sessionRef.current = result.sessionId
        setSessionId(result.sessionId)
      }
      const studioSession = result.sessionId as SessionId
      await studioApi.sessions.rename({ sessionId: studioSession, title: `Studio: ${projectName}` })
    } catch (cause) {
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) setError(localizeError(cause))
    } finally {
      setCreatingAgentDraftId(current => current === target ? undefined : current)
    }
  }

  const attachAgent = async (): Promise<void> => {
    if (!agentTargetReady || selectedAgentSessionId === '') return
    const draftId = selectedDraftId
    const currentTarget = draftId === undefined
    const target = draftId ?? CURRENT_INSTANCE_KEY
    setAttachingAgentDraftId(target)
    setError(undefined)
    try {
      const result = await callStudio<StudioAgentBinding>(currentTarget
        ? 'studio.current.agent.attach' : 'studio.agent.attach', currentTarget
        ? { sessionId: selectedAgentSessionId }
        : { draftId, sessionId: selectedAgentSessionId })
      if (currentTarget) {
        setCurrentInstance(current => current === undefined ? current : { ...current, agent: result })
        if (currentInstanceRef.current !== undefined) currentInstanceRef.current = { ...currentInstanceRef.current, agent: result }
      } else {
        setDrafts(current => current.map(draft => draft.id === draftId ? { ...draft, agent: result } : draft))
      }
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) {
        sessionRef.current = result.sessionId
        setSessionId(result.sessionId)
      }
    } catch (cause) {
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) setError(localizeError(cause))
    } finally {
      setAttachingAgentDraftId(current => current === target ? undefined : current)
    }
  }

  const leaveAgent = async (): Promise<void> => {
    if (sessionId === undefined || running) return
    const draftId = selectedDraftId
    const currentTarget = draftId === undefined
    const target = draftId ?? CURRENT_INSTANCE_KEY
    setLeavingAgentDraftId(target)
    setError(undefined)
    try {
      if (currentTarget) {
        const view = await callStudio<StudioCurrentInstanceView>('studio.current.agent.leave', {})
        currentInstanceRef.current = view
        setCurrentInstance(view)
      } else {
        const view = await callStudio<StudioDraftView>('studio.agent.leave', { draftId })
        setDrafts(current => current.map(draft => draft.id === draftId ? view : draft))
      }
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) {
        sessionRef.current = undefined
        setSessionId(undefined)
        setEvents([])
        setHasOlderMessages(false)
        setRunning(false)
      }
    } catch (cause) {
      if ((draftIdRef.current ?? CURRENT_INSTANCE_KEY) === target) setError(localizeError(cause))
    } finally {
      setLeavingAgentDraftId(current => current === target ? undefined : current)
    }
  }

  const loadOlderAgentMessages = async (): Promise<void> => {
    const beforeSeq = events[0]?.event.seq
    if (sessionId === undefined || beforeSeq === undefined || loadingOlderMessages || !hasOlderMessages) return
    const targetSessionId = sessionId
    setLoadingOlderMessages(true)
    try {
      const page = apiValue(await studioApi.sessions.history({
        sessionId: targetSessionId as SessionId,
        beforeSeq,
        maxMessages: 50,
      }))
      if (sessionRef.current !== targetSessionId) return
      const older = page.events as HistoryEntry[]
      setEvents(current => [...older, ...current.filter(entry => !older.some(item => item.event.seq === entry.event.seq))]
        .sort((a, b) => a.event.seq - b.event.seq))
      setHasOlderMessages(page.hasMore)
    } catch (cause) {
      if (sessionRef.current === targetSessionId) setError(localizeError(cause))
    } finally {
      if (sessionRef.current === targetSessionId) setLoadingOlderMessages(false)
    }
  }

  const sendPrompt = async (): Promise<void> => {
    const text = prompt.trim()
    if (sessionId === undefined || text === '') return
    setSending(true)
    setError(undefined)
    try {
      apiValue(await studioApi.sessions.prompt({
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }))
      setPrompt('')
    } catch (cause) {
      setError(localizeError(cause))
    } finally {
      setSending(false)
    }
  }

  const respondToAgentInteraction = async (response: ClientResponse): Promise<void> => {
    const receipt = await studioApi.respond(response).catch(cause => {
      throw new Error(localizeError(cause))
    })
    if (!receipt.accepted) throw new Error(receipt.reason === 'not-pending'
      ? t('agentInteractionExpired')
      : t('agentInteractionRejected'))
  }

  const selectAgentModel = async (selection: ModelSelection): Promise<void> => {
    if (sessionId === undefined || selectingAgentModel) return
    const targetSessionId = sessionId
    setSelectingAgentModel(true)
    setError(undefined)
    try {
      const result = apiValue(await studioApi.sessions.selectModel({
        sessionId: targetSessionId as SessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }))
      if (sessionRef.current !== targetSessionId) return
      setAgentModels(current => current === undefined ? current : {
        ...current,
        current: result.selected,
        routable: true,
      })
    } catch (cause) {
      if (sessionRef.current === targetSessionId) setError(localizeError(cause))
    } finally {
      if (sessionRef.current === targetSessionId) setSelectingAgentModel(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (sessionId === undefined) return
    try {
      apiValue(await studioApi.sessions.cancel({ sessionId: sessionId as SessionId }))
    } catch (cause) {
      setError(localizeError(cause))
    }
  }

  const selectDraft = (draftId: string, nextOpenDraftIds = openDraftIds): boolean => {
    if (draftId !== selectedDraftId && hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedSwitchDraft'))
      return false
    }
    activateDraft(draftId)
    setSelection(undefined)
    setRegistry(EMPTY_REGISTRY)
    queueWorkspaceUpdate(nextOpenDraftIds, draftId)
    return true
  }

  const selectCurrentInstance = (): void => {
    if (selectedDraftId !== undefined && hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedSwitchDraft'))
      return
    }
    activateDraft(undefined)
    setSelection(undefined)
    setRegistry(EMPTY_REGISTRY)
    queueWorkspaceUpdate(openDraftIds, undefined)
  }

  const openDraft = (draftId: string): void => {
    const nextOpenDraftIds = openDraftIds.includes(draftId) ? openDraftIds : [...openDraftIds, draftId]
    if (!selectDraft(draftId, nextOpenDraftIds)) return
    setOpenDraftIds(nextOpenDraftIds)
  }

  const closeDraft = (draftId: string): void => {
    if (draftId === selectedDraftId && hasUnsavedSource) {
      setPanel('source')
      setError(t('errorUnsavedCloseDraft'))
      return
    }
    const index = openDraftIds.indexOf(draftId)
    const nextOpenDraftIds = openDraftIds.filter(id => id !== draftId)
    setOpenDraftIds(nextOpenDraftIds)
    const nextDraftId = draftId === selectedDraftId
      ? nextOpenDraftIds[Math.min(index, nextOpenDraftIds.length - 1)]
      : selectedDraftId
    queueWorkspaceUpdate(nextOpenDraftIds, nextDraftId)
    if (draftId !== selectedDraftId) return
    activateDraft(nextDraftId)
    setSelection(undefined)
    setRegistry(EMPTY_REGISTRY)
  }

  const moveDraftTabToIndex = (draftId: string, targetIndex: number): void => {
    const sourceIndex = openDraftIds.indexOf(draftId)
    if (sourceIndex === -1) return
    const reordered = openDraftIds.filter(id => id !== draftId)
    const boundedIndex = Math.max(0, Math.min(targetIndex, reordered.length))
    reordered.splice(boundedIndex, 0, draftId)
    if (reordered.every((id, index) => id === openDraftIds[index])) return
    setOpenDraftIds(reordered)
    queueWorkspaceUpdate(reordered, selectedDraftId)
  }

  const beginDraftTabPointerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    draftId: string,
    sourceIndex: number,
  ): void => {
    if (!event.isPrimary || event.button !== 0) return
    const tab = event.currentTarget.closest<HTMLElement>('.draft-tab')
    const root = event.currentTarget.closest<HTMLElement>('.studio-ui-root')
    const tabList = tab?.parentElement
    if (tab === null || root === null || !tabList?.classList.contains('draft-tab-list')) return
    const rail = tabList.parentElement
    if (rail === null || rail === undefined) return

    activeDragCleanupRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const bounds = tab.getBoundingClientRect()
    const tabGap = Number.parseFloat(getComputedStyle(tabList).columnGap) || 0
    const tabSpan = bounds.width + tabGap
    const tabRects = Array.from(tabList.querySelectorAll<HTMLElement>(':scope > .draft-tab'))
      .map((element, index) => ({ id: element.dataset.draftId, index, bounds: element.getBoundingClientRect() }))
    const railBounds = rail.getBoundingClientRect()
    const siblingCenters = tabRects
      .filter(item => item.id !== draftId)
      .map(item => item.bounds.left + item.bounds.width / 2)
    const collapsedSiblingCenters = tabRects
      .filter(item => item.id !== draftId)
      .map(item => item.bounds.left + item.bounds.width / 2 - (item.index > sourceIndex ? tabSpan : 0))
    const pointerOffsetX = startX - bounds.left
    const pointerOffsetY = startY - bounds.top
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let dragging = false
    let targetIndex: number | undefined
    let indicator = false
    let preview: HTMLElement | undefined

    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      preview?.remove()
      delete document.body.dataset.studioDragging
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setDraftTabDrag(undefined)
      activeDragCleanupRef.current = undefined
    }
    const start = (nextEvent: PointerEvent): void => {
      dragging = true
      preview = tab.cloneNode(true) as HTMLElement
      preview.classList.add('draft-tab-drag-preview')
      preview.removeAttribute('data-active')
      preview.removeAttribute('data-dragging')
      preview.removeAttribute('data-draft-id')
      preview.style.removeProperty('--draft-tab-shift')
      preview.style.width = `${bounds.width}px`
      preview.style.height = `${bounds.height}px`
      root.append(preview)
      document.body.dataset.studioDragging = 'true'
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
      setDraftTabDrag({ draftId, sourceIndex, targetIndex, indicator, span: tabSpan, width: bounds.width })
      update(nextEvent)
    }
    const update = (nextEvent: PointerEvent): void => {
      const left = nextEvent.clientX - pointerOffsetX
      const top = nextEvent.clientY - pointerOffsetY
      if (preview !== undefined) preview.style.transform = `translate3d(${left}px, ${top}px, 0)`
      const draggedCenter = left + bounds.width / 2
      const insideRail = nextEvent.clientX >= railBounds.left && nextEvent.clientX <= railBounds.right
        && nextEvent.clientY >= railBounds.top && nextEvent.clientY <= railBounds.bottom
      const insertionIndex = siblingCenters.filter(center => center < draggedCenter).length
      const nextTargetIndex = insideRail
        ? insertionIndex !== sourceIndex ? insertionIndex : undefined
        : collapsedSiblingCenters.filter(center => center < draggedCenter).length
      const nextIndicator = !insideRail
      if (nextTargetIndex === targetIndex && nextIndicator === indicator) return
      targetIndex = nextTargetIndex
      indicator = nextIndicator
      setDraftTabDrag(current => current === undefined ? current : { ...current, targetIndex, indicator })
    }
    const move = (nextEvent: PointerEvent): void => {
      if (nextEvent.pointerId !== pointerId) return
      if (!dragging && Math.hypot(nextEvent.clientX - startX, nextEvent.clientY - startY) < 5) return
      nextEvent.preventDefault()
      if (!dragging) start(nextEvent)
      else update(nextEvent)
    }
    const end = (nextEvent: PointerEvent): void => {
      if (nextEvent.pointerId !== pointerId) return
      if (!dragging) {
        cleanup()
        return
      }
      suppressDraftTabClickRef.current = draftId
      cleanup()
      if (targetIndex !== undefined) moveDraftTabToIndex(draftId, targetIndex)
      window.setTimeout(() => {
        if (suppressDraftTabClickRef.current === draftId) suppressDraftTabClickRef.current = undefined
      })
    }
    const cancel = (nextEvent: PointerEvent): void => {
      if (nextEvent.pointerId === pointerId) cleanup()
    }

    activeDragCleanupRef.current = cleanup
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
  }

  const selectDraftByKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const nextIndex = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : Math.min(openDrafts.length - 1, index + 1)
      const draft = openDrafts[index]
      if (draft !== undefined && nextIndex !== index) moveDraftTabToIndex(draft.id, nextIndex)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const last = openDrafts.length - 1
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? last
      : event.key === 'ArrowLeft' ? (index + last) % openDrafts.length : (index + 1) % openDrafts.length
    const draft = openDrafts[nextIndex]
    if (draft === undefined || !selectDraft(draft.id)) return
    event.currentTarget.closest('.draft-tab-list')
      ?.querySelectorAll<HTMLButtonElement>('.draft-tab-select')[nextIndex]?.focus()
  }

  const beginPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    cursor: string,
    onMove: (dx: number, dy: number) => void,
  ): void => {
    event.preventDefault()
    activeDragCleanupRef.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.dataset.studioDragging = 'true'
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'
    const move = (nextEvent: PointerEvent): void => onMove(nextEvent.clientX - startX, nextEvent.clientY - startY)
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      delete document.body.dataset.studioDragging
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      activeDragCleanupRef.current = undefined
    }
    activeDragCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const beginPreviewPan = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 1) return
    event.stopPropagation()
    const initial = previewOrigin
    beginPointerDrag(event, 'grabbing', (dx, dy) => {
      setPreviewOrigin({ x: initial.x + dx, y: initial.y + dy })
    })
  }

  const beginPreviewZoomFocusMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || previewZoomFocus === undefined) return
    event.stopPropagation()
    const initial = previewZoomFocus
    const stage = previewStageRef.current?.getBoundingClientRect()
    const radius = event.currentTarget.getBoundingClientRect().width / 2
    beginPointerDrag(event, 'grabbing', (dx, dy) => {
      setPreviewZoomFocus(current => current === undefined || stage === undefined ? current : {
        x: clamp(initial.x + dx, radius, Math.max(radius, stage.width - radius)),
        y: clamp(initial.y + dy, radius, Math.max(radius, stage.height - radius)),
        phase: 'active',
      })
    })
  }

  const suppressPreviewMiddleMouse = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
  }

  const zoomPreviewFromCanvas = (event: ReactWheelEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest('.preview-artboard') !== null) return
    event.preventDefault()
    if (previewMode === 'browse') {
      const overFocus = event.target instanceof Element && event.target.closest('.preview-zoom-focus') !== null
      const stage = event.currentTarget.getBoundingClientRect()
      const phase: PreviewZoomFocus['phase'] = document.hasFocus() ? 'active' : 'fading'
      setPreviewZoomFocus(current => overFocus && current !== undefined
        ? { ...current, phase }
        : { x: event.clientX - stage.left, y: event.clientY - stage.top, phase })
    }
    zoomPreviewByWheel(event.deltaY, event.deltaMode)
  }

  const beginSidebarResize = (event: ReactPointerEvent<HTMLElement>, side: 'left' | 'right'): void => {
    const initial = side === 'left' ? leftSidebarWidth : rightSidebarWidth
    beginPointerDrag(event, 'col-resize', dx => {
      if (side === 'left') setLeftSidebarWidth(clamp(initial + dx, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX))
      else setRightSidebarWidth(clamp(initial - dx, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX))
    })
  }

  const changeSidebarWidthByKeyboard = (side: 'left' | 'right', delta: number): void => {
    if (side === 'left') setLeftSidebarWidth(value => clamp(value + delta, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX))
    else setRightSidebarWidth(value => clamp(value - delta, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX))
  }

  const changePreviewAspectRatio = (value: PreviewAspectRatio): void => {
    if (value === 'custom') return
    const ratio = aspectRatioValue(value)
    const nextViewport = {
      ...previewViewport,
      height: Math.max(1, Math.round(previewViewport.width / ratio)),
    }
    if (previewAspectLocked) previewLockedAspectRatioRef.current = ratio
    setPreviewAspectRatio(value)
    setPreviewViewport(nextViewport)
    fitPreviewToStage(nextViewport)
  }

  const changePreviewDimension = (dimension: 'width' | 'height', value: number): void => {
    if (!Number.isFinite(value)) return
    setPreviewViewport(current => {
      const nextValue = Math.max(1, Math.round(value))
      const ratio = previewLockedAspectRatioRef.current
      const next = previewAspectLocked
        ? dimension === 'width'
          ? { width: nextValue, height: Math.max(1, Math.round(nextValue / ratio)) }
          : { width: Math.max(1, Math.round(nextValue * ratio)), height: nextValue }
        : { ...current, [dimension]: nextValue }
      setPreviewAspectRatio(aspectRatioLabel(next.width, next.height))
      return next
    })
  }

  const changePreviewScale = (nextScale: number): void => {
    if (!Number.isFinite(nextScale)) return
    const scale = Math.max(0.01, nextScale)
    const visibleWidth = Math.max(0, previewStageSize.width - previewInsets.left - previewInsets.right)
    setPreviewScale(scale)
    setPreviewOrigin({
      x: previewInsets.left + (visibleWidth - previewViewport.width * scale) / 2,
      y: (previewStageSize.height - previewViewport.height * scale) / 2,
    })
  }

  const beginPreviewResize = (event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection): void => {
    const initial = previewRect
    beginPointerDrag(event, `${direction}-resize`, (dx, dy) => {
      const next = resizeRect(initial, direction, dx, dy, undefined, {
        width: PREVIEW_MIN_SIZE.width * previewScale,
        height: PREVIEW_MIN_SIZE.height * previewScale,
      }, previewAspectLocked)
      const viewport = {
        width: Math.max(1, Math.round(next.width / previewScale)),
        height: Math.max(1, Math.round(next.height / previewScale)),
      }
      setPreviewOrigin({ x: next.x, y: next.y })
      setPreviewViewport(viewport)
      setPreviewAspectRatio(aspectRatioLabel(viewport.width, viewport.height))
    })
  }

  const terminalViewportBounds = (): LayoutRect => ({
    x: 8,
    y: 8,
    width: Math.max(0, window.innerWidth - 16),
    height: Math.max(0, window.innerHeight - 16),
  })

  const defaultTerminalRect = (): LayoutRect => {
    const preview = previewSectionRef.current?.getBoundingClientRect()
    const bounds = terminalViewportBounds()
    const availableWidth = Math.max(TERMINAL_MIN_SIZE.width, (preview?.width ?? bounds.width) - 24)
    const width = Math.min(900, availableWidth, bounds.width)
    const height = Math.min(440, Math.max(260, (preview?.height ?? bounds.height) * 0.42), bounds.height)
    const x = clamp((preview?.left ?? bounds.x) + 12, bounds.x, bounds.x + bounds.width - width)
    const y = clamp((preview?.bottom ?? bounds.y + bounds.height) - height - 12,
      bounds.y, bounds.y + bounds.height - height)
    return { x, y, width, height }
  }

  const beginTerminalMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (terminalRect === undefined || (event.target as HTMLElement).closest('button') !== null) return
    const initial = terminalRect
    beginPointerDrag(event, 'move', (dx, dy) => setTerminalRect(moveRect(initial, dx, dy, terminalViewportBounds())))
  }

  const beginTerminalResize = (event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection): void => {
    if (terminalRect === undefined) return
    const initial = terminalRect
    beginPointerDrag(event, `${direction}-resize`, (dx, dy) => setTerminalRect(resizeRect(
      initial,
      direction,
      dx,
      dy,
      terminalViewportBounds(),
      TERMINAL_MIN_SIZE,
      false,
    )))
  }

  const toggleTerminal = (): void => {
    const scrollTop = terminalRef.current?.scrollTop
    if (terminalExpanded) setLeftSidebarCollapsed(false)
    else setTerminalRect(defaultTerminalRect())
    setTerminalMinimized(false)
    setTerminalExpanded(!terminalExpanded)
    requestAnimationFrame(() => {
      const terminal = terminalRef.current
      if (terminal !== null) terminal.scrollTop = terminalPinnedRef.current ? terminal.scrollHeight : scrollTop ?? 0
      terminalToggleRef.current?.focus()
    })
  }

  const toggleTerminalMinimized = (): void => {
    if (!terminalMinimized) {
      setTerminalExpanded(false)
      setLeftSidebarCollapsed(false)
    }
    setTerminalMinimized(value => !value)
    requestAnimationFrame(() => {
      const output = terminalRef.current
      if (output !== null && terminalPinnedRef.current) output.scrollTop = output.scrollHeight
    })
  }

  const terminal = selectedDraft === undefined ? null : <section id="draft-terminal"
    className="host-terminal studio-ui-root" data-expanded={terminalExpanded} data-minimized={terminalMinimized}
    style={terminalExpanded && terminalRect !== undefined ? {
      left: terminalRect.x,
      top: terminalRect.y,
      width: terminalRect.width,
      height: terminalRect.height,
    } : undefined}
    aria-label={t('terminalHostLabel')}>
    <div className="host-terminal-bar" data-draggable={terminalExpanded || undefined}
      onPointerDown={terminalExpanded ? beginTerminalMove : undefined}>
      <button type="button" className="terminal-section-toggle"
        aria-expanded={!terminalMinimized} aria-controls="draft-terminal-output" onClick={toggleTerminalMinimized}>
        <DisclosureIcon expanded={!terminalMinimized} /><strong>{t('terminal')}</strong>
        {terminalMinimized && <code className="terminal-latest-line" title={terminalLatestLine}>{terminalLatestLine}</code>}
        {!terminalMinimized && terminalRuntimeLabel !== undefined
          && <span className="terminal-runtime-state" aria-live="polite" data-state={terminalRuntimeState}>
            {terminalRuntimeLabel}
          </span>}
      </button>
      <div className="host-terminal-actions">
        <IconButton ref={terminalToggleRef} className="terminal-layout-button" size="small" variant="ghost"
          aria-expanded={terminalExpanded} aria-controls="draft-terminal" onClick={toggleTerminal}
          label={terminalExpanded ? t('terminalDock') : t('terminalExpand')}>
          <TerminalLayoutIcon expanded={terminalExpanded} />
        </IconButton>
      </div>
    </div>
    {!terminalMinimized && <pre id="draft-terminal-output" ref={terminalRef} role="log" aria-live="off"
      aria-label={t('terminalReadonly')} tabIndex={0} onScroll={event => {
      const terminal = event.currentTarget
      terminalPinnedRef.current = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 24
    }}>{terminalOutput || t('terminalNotStarted')}</pre>}
    {terminalExpanded && !terminalMinimized && <ResizeHandles kind="terminal" onPointerDown={beginTerminalResize} />}
  </section>

  return <div className="studio-shell studio-ui-root">
    <header className="studio-header">
      <div className="studio-brand">
        <span className="studio-mark" aria-hidden="true">
          <img className="studio-mark-color" src={`${STUDIO_PATH}/assets/harmony-icon.png`} alt="" />
          <img className="studio-mark-mono" src={`${STUDIO_PATH}/assets/harmony-icon-mono.png`} alt="" />
        </span>
        <div><strong>DeepSeek WebUI Studio</strong><span>{t('appSubtitle')}</span></div>
      </div>
      <nav className="draft-tabs" aria-label={t('draftWorkspace')} data-empty={!loadingDrafts && openDrafts.length === 0 || undefined}>
        <div className="draft-tab-list" role="tablist" aria-label={t('draftTabs')}>
          {loadingDrafts
            ? <span className="draft-tabs-loading" aria-live="polite">{t('draftLoading')}</span>
            : <>
              <div className="draft-tab current-instance-tab" data-active={selectedDraftId === undefined || undefined}>
                <button id="current-instance-tab" className="draft-tab-select" type="button" role="tab"
                  aria-selected={selectedDraftId === undefined} aria-controls="draft-workspace"
                  tabIndex={selectedDraftId === undefined ? 0 : -1} onClick={selectCurrentInstance}>
                  <span className="draft-tab-label" data-state="running">
                    <span className="draft-tab-dot" aria-hidden="true" />
                    <span>{t('currentInstance')}</span>
                  </span>
                </button>
              </div>
              {openDrafts.map((draft, index) => {
                  const state = (instanceOperations[draft.id] === 'start' || instanceOperations[draft.id] === 'restart')
                    && draft.runtime.state !== 'running'
                    ? 'starting' : draft.runtime.state
                  const dirty = draft.id === selectedDraftId && hasUnsavedSource
                  let shift = 0
                  let dropIndicator: 'before' | 'after' | undefined
                  if (draftTabDrag !== undefined && draft.id !== draftTabDrag.draftId) {
                    const visibleIndex = index < draftTabDrag.sourceIndex ? index : index - 1
                    if (index > draftTabDrag.sourceIndex) shift -= draftTabDrag.span
                    if (!draftTabDrag.indicator && draftTabDrag.targetIndex !== undefined
                      && visibleIndex >= draftTabDrag.targetIndex) {
                      shift += draftTabDrag.span
                    }
                    if (draftTabDrag.indicator && draftTabDrag.targetIndex !== undefined) {
                      if (visibleIndex === draftTabDrag.targetIndex) dropIndicator = 'before'
                      else if (draftTabDrag.targetIndex === openDrafts.length - 1
                        && visibleIndex === openDrafts.length - 2) dropIndicator = 'after'
                    }
                  }
                  return <div key={draft.id} className="draft-tab" data-draft-id={draft.id}
                    data-active={draft.id === selectedDraftId || undefined}
                    data-dragging={draftTabDrag?.draftId === draft.id || undefined}
                    data-drop-indicator={dropIndicator}
                    style={{ '--draft-tab-shift': `${shift}px` } as CSSProperties}>
                    <button id={`draft-tab-${draft.id}`} className="draft-tab-select" type="button" role="tab"
                      aria-selected={draft.id === selectedDraftId} aria-controls="draft-workspace"
                      tabIndex={draft.id === selectedDraftId ? 0 : -1}
                      aria-label={t('draftTabLabel', {
                        name: draft.label,
                        state: runtimeLabel(state, t),
                        dirty: dirty ? t('draftTabDirtySuffix') : '',
                      })}
                      title={t('draftTabMoveHint')}
                      onPointerDown={event => beginDraftTabPointerDrag(event, draft.id, index)}
                      onClick={() => {
                        if (suppressDraftTabClickRef.current === draft.id) {
                          suppressDraftTabClickRef.current = undefined
                          return
                        }
                        selectDraft(draft.id)
                      }} onKeyDown={event => selectDraftByKeyboard(event, index)}>
                      <span className="draft-tab-label" data-state={state}>
                        <span className="draft-tab-dot" aria-hidden="true" />
                        <span>{draft.label}</span>
                        {dirty && <span className="draft-tab-dirty" aria-hidden="true" />}
                      </span>
                    </button>
                    <IconButton className="draft-tab-close" size="small" variant="ghost"
                      onClick={() => closeDraft(draft.id)} label={t('draftClose', { name: draft.label })}><CloseIcon /></IconButton>
                  </div>
                })}
            </>}
        </div>
        <IconButton className="draft-tab-add" size="small" variant="ghost" aria-haspopup="dialog"
          aria-expanded={createDialogOpen} aria-controls="studio-create-draft-dialog"
          style={{ '--draft-tab-add-shift': `${draftTabDrag !== undefined
            && (draftTabDrag.indicator || draftTabDrag.targetIndex === undefined) ? -draftTabDrag.span : 0}px` } as CSSProperties}
          data-empty={!loadingDrafts && openDrafts.length === 0 || undefined}
          onClick={() => setCreateDialogOpen(true)} label={t('draftNew')}>
          <PlusIcon />
          {!loadingDrafts && openDrafts.length === 0 && <span className="draft-tab-add-label">{t('draftNew')}</span>}
        </IconButton>
        {!loadingDrafts && openDrafts.length === 0
          && <span className="draft-tabs-empty">{t('draftOpenFromPlugins')}</span>}
      </nav>
      <div className="studio-header-actions">
        <IconButton className="settings-button" size="small" variant="ghost" label={t('settings')}
          title={t('settings')} onClick={() => setSettingsOpen(true)}><SettingsIcon /></IconButton>
        <Status tone={connected ? 'success' : 'neutral'} label={localDshStatusLabel}>{localDshStatusLabel}</Status>
      </div>
    </header>

    <main id="draft-workspace" className="studio-main" role="tabpanel"
      aria-labelledby={selectedDraftId === undefined ? 'current-instance-tab' : `draft-tab-${selectedDraftId}`}
      data-left-collapsed={leftSidebarCollapsed} data-right-collapsed={rightSidebarCollapsed}
      data-preview-fullscreen={previewFullscreen || undefined}
      style={{
        '--studio-left-sidebar': `${leftSidebarCollapsed ? 48 : leftSidebarWidth}px`,
        '--studio-right-sidebar': `${rightSidebarCollapsed ? 56 : rightSidebarWidth}px`,
      } as CSSProperties}>
      <Panel id="dsh-control-sidebar" as="aside" className="studio-project studio-sidebar" data-collapsed={leftSidebarCollapsed}
        aria-label={t('controlSidebar')}>
        <div className="sidebar-heading">
          <div className="sidebar-title"><strong>{t('controlTitle')}</strong><span>{t('controlSubtitle')}</span></div>
          <IconButton size="small" variant="ghost" aria-expanded={!leftSidebarCollapsed}
            aria-controls="dsh-control-sidebar" onClick={() => setLeftSidebarCollapsed(value => !value)}
            label={leftSidebarCollapsed ? t('controlExpand') : t('controlCollapse')}>
            <SidebarToggleIcon side="left" collapsed={leftSidebarCollapsed} />
          </IconButton>
        </div>
        <div className="project-body sidebar-content">
          <Tabs id="left-sidebar" className="left-sidebar-tabs" label={t('controlPages')} value={leftPanel}
            onChange={(value: LeftPanel) => setLeftPanel(value)}
            options={selectedDraft === undefined ? [
              { value: 'instance', label: t('instanceStatus') },
            ] : [
              { value: 'instance', label: t('instanceStatus') },
              { value: 'plugins', label: t('pluginManagement') },
              { value: 'patches', label: t('patchManagement') },
            ]} />
          {selectedDraft === undefined
            ? <section id={`left-sidebar-panel-${leftPanel}`} role="tabpanel"
                aria-labelledby={`left-sidebar-tab-${leftPanel}`} className="left-sidebar-page instance-control-panel">
                <div className="instance-summary" data-state="running">
                  <span className="instance-status-dot" aria-hidden="true" />
                  <strong>{t('currentInstanceActive')}</strong>
                </div>
                <p className="current-instance-description">{t('currentInstanceDescription')}</p>
                <section className="instance-preview-section" aria-labelledby="current-instance-preview-heading">
                  <div id="current-instance-preview-heading" className="control-section-heading">
                    <div><strong>{t('livePreview')}</strong><span>{t('currentInstanceReadOnly')}</span></div>
                  </div>
                  <div className="preview-controls">
                    <div className="preview-mode-field" data-mode={previewMode} data-disabled={previewUrl === undefined || undefined}>
                      <div className="preview-mode-heading">
                        <strong>{t('interactionMode')}</strong>
                        <span>{previewMode === 'browse' ? t('interactionBrowseDescription') : t('interactionInspectDescription')}</span>
                      </div>
                      <SegmentedControl className="preview-mode-control" label={t('previewInteractionMode')} value={previewMode}
                        options={[
                          { value: 'browse', label: t('browse'), disabled: previewUrl === undefined },
                          { value: 'inspect', label: t('inspect'), disabled: previewUrl === undefined },
                        ]} onChange={changePreviewMode} />
                    </div>
                    <div className="control-action-row">
                      <Button size="small" className="sidebar-action-button preview-fit-button"
                        onClick={() => fitPreviewToStage()}>{t('fitCanvas')}</Button>
                      <Button size="small" className="sidebar-action-button preview-fullscreen-button" disabled={previewUrl === undefined}
                        onClick={togglePreviewFullscreen}>
                        <FullscreenIcon active={previewFullscreen} />{previewFullscreen ? t('exitFullscreen') : t('fullscreen')}
                      </Button>
                    </div>
                  </div>
                </section>
              </section>
            : leftPanel === 'instance' && <section id="left-sidebar-panel-instance" role="tabpanel"
                aria-labelledby="left-sidebar-tab-instance" className="left-sidebar-page instance-control-panel">
                <div className="instance-summary" data-state={selectedInstanceStarting ? 'starting' : selectedDraft.runtime.state}>
                  <span className="instance-status-dot" aria-hidden="true" />
                  <strong>{selectedInstanceOperation === 'restart' ? t('instanceRestarting')
                    : selectedInstanceOperation === 'start' ? t('instanceStarting') : selectedInstanceOperation === 'stop' ? t('instanceStopping')
                    : selectedDraft.runtime.state === 'running' ? t('instanceRunning')
                    : selectedDraft.runtime.state === 'failed' ? t('instanceFailed') : t('instanceStopped')}</strong>
                </div>
                <div className="instance-fields">
                  <label><span>{t('draftName')}</span><Input value={draftLabelInput} maxLength={120}
                    onChange={event => setDraftLabelInput(event.target.value)} onBlur={() => void renameDraft()}
                    onKeyDown={event => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        setDraftLabelInput(selectedDraft.label)
                        event.currentTarget.blur()
                      }
                    }} /></label>
                  <label><span>{t('worktreeLocation')}</span><code title={selectedDraft.worktreeDir}>{selectedDraft.worktreeDir}</code></label>
                  {selectedDraft.destinationDirectory !== undefined && <label>
                    <span>{t('draftDestinationDirectory')}</span>
                    <code title={selectedDraft.destinationDirectory}>{selectedDraft.destinationDirectory}</code>
                  </label>}
                </div>
                <div className="instance-actions">
                  <Button size="small" variant="primary" className="sidebar-action-button"
                    onClick={() => void startDraft()} loading={selectedInstanceOperation === 'start'}
                    loadingLabel={t('starting')} disabled={selectedDraft.runtime.state === 'running' || selectedInstanceOperation !== undefined}>
                    <StartIcon />{t('start')}</Button>
                  <Button size="small" className="sidebar-action-button" onClick={() => void stopDraft()}
                    loading={selectedInstanceOperation === 'stop'} loadingLabel={t('stopping')}
                    disabled={selectedDraft.runtime.state !== 'running' || selectedInstanceOperation !== undefined}><StopIcon />{t('stop')}</Button>
                  <Button size="small" className="sidebar-action-button" onClick={() => void restartDraft()}
                    loading={selectedInstanceOperation === 'restart'} loadingLabel={t('restarting')}
                    disabled={selectedDraft.runtime.state !== 'running' || selectedInstanceOperation !== undefined}
                    aria-label={t('restartInstance')}><RefreshIcon />{t('restart')}</Button>
                </div>
                {selectedDraft.destinationDirectory !== undefined && <div className="instance-export">
                  <Button size="small" className="sidebar-action-button" onClick={() => void exportDraft()}
                    loading={exportingDraftId === selectedDraft.id} loadingLabel={t('draftExporting')}>
                    {t('draftExportToFolder')}
                  </Button>
                  <span>{selectedDraft.exportedAt === undefined ? t('draftDestinationPending') : t('draftDestinationSaved')}</span>
                </div>}
                {selectedDraft.runtime.error !== undefined && <Notice tone="danger">
                  {studioErrorCodeMessage('internal', selectedDraft.runtime.error, t)}
                </Notice>}
                <section className="instance-preview-section" aria-labelledby="instance-preview-heading">
                  <div id="instance-preview-heading" className="control-section-heading">
                    <div><strong>{t('livePreview')}</strong><span>{t('previewInteractionCanvas')}</span></div>
                  </div>
                  <div className="preview-controls">
                    <div className="preview-mode-field" data-mode={previewMode} data-disabled={previewUrl === undefined || undefined}>
                      <div className="preview-mode-heading">
                        <strong>{t('interactionMode')}</strong>
                        <span>{previewMode === 'browse' ? t('interactionBrowseDescription') : t('interactionInspectDescription')}</span>
                      </div>
                      <SegmentedControl className="preview-mode-control" label={t('previewInteractionMode')} value={previewMode}
                        options={[
                          { value: 'browse', label: t('browse'), disabled: previewUrl === undefined },
                          { value: 'inspect', label: t('inspect'), disabled: previewUrl === undefined },
                        ]} onChange={changePreviewMode} />
                    </div>
                    <div className="preview-resolution-line">
                      <label><span>W</span><Input type="number" min={1} value={previewViewport.width}
                        aria-label={t('viewportWidth')} onChange={event => changePreviewDimension('width', event.target.valueAsNumber)} /></label>
                      <label><span>H</span><Input type="number" min={1} value={previewViewport.height}
                        aria-label={t('viewportHeight')} onChange={event => changePreviewDimension('height', event.target.valueAsNumber)} /></label>
                    </div>
                    <div className="preview-canvas-line">
                      <div className="preview-zoom-control" aria-label={t('previewZoom')}>
                        <Button size="small" className="preview-zoom-step" onClick={() => changePreviewScale(previewScale / 1.25)}
                          aria-label={t('zoomOut')}>-</Button>
                        <span onWheel={event => {
                          event.preventDefault()
                          zoomPreviewByWheel(event.deltaY, event.deltaMode)
                        }}>{Math.round(previewScale * 100)}%</span>
                        <Button size="small" className="preview-zoom-step" onClick={() => changePreviewScale(previewScale * 1.25)}
                          aria-label={t('zoomIn')}>+</Button>
                      </div>
                      <Select className="preview-aspect-select" value={previewAspectRatio} aria-label={t('artboardRatio')}
                        onChange={event => changePreviewAspectRatio(event.target.value as PreviewAspectRatio)}>
                        {previewAspectRatios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
                        {previewAspectRatio === 'custom' && <option value="custom">{t('custom')}</option>}
                      </Select>
                      <IconButton className="preview-aspect-lock" size="small" variant="secondary"
                        aria-pressed={previewAspectLocked} onClick={togglePreviewAspectLock}
                        label={previewAspectLocked ? t('unlockAspectRatio') : t('lockAspectRatio')}>
                        <AspectRatioLockIcon locked={previewAspectLocked} />
                      </IconButton>
                    </div>
                    <div className="control-action-row">
                      <Button size="small" className="sidebar-action-button preview-fit-button"
                        onClick={() => fitPreviewToStage()}>{t('fitCanvas')}</Button>
                      <Button size="small" className="sidebar-action-button preview-fullscreen-button" disabled={previewUrl === undefined}
                        onClick={togglePreviewFullscreen}>
                        <FullscreenIcon active={previewFullscreen} />{previewFullscreen ? t('exitFullscreen') : t('fullscreen')}
                      </Button>
                    </div>
                  </div>
                </section>
              </section>}

          {selectedDraft !== undefined && <PluginManagement selectedDraft={selectedDraft}
            view={leftPanel === 'instance' ? undefined : leftPanel} />}
        </div>
        {!terminalExpanded && terminal}
        {!leftSidebarCollapsed && <span className="sidebar-resizer" data-side="left" role="separator" tabIndex={0}
          aria-label={t('controlResize')} aria-orientation="vertical"
          aria-valuemin={LEFT_SIDEBAR_MIN} aria-valuemax={LEFT_SIDEBAR_MAX} aria-valuenow={leftSidebarWidth}
          onPointerDown={event => beginSidebarResize(event, 'left')}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            changeSidebarWidthByKeyboard('left', event.key === 'ArrowLeft' ? -12 : 12)
          }} />}
      </Panel>

      <Panel ref={previewSectionRef} className="studio-preview"
        data-fullscreen={previewFullscreen || undefined} aria-label={t('previewLabel')}>
        {previewFullscreen && <div className="preview-fullscreen-tools" aria-label={t('fullscreenStudioControls')}>
          <IconButton className="preview-fullscreen-exit" variant="secondary"
            onClick={togglePreviewFullscreen} label={t('previewExitFullscreen')}>
            <FullscreenIcon active />
          </IconButton>
        </div>}
        <div ref={previewStageRef} className="preview-stage"
          onPointerDownCapture={previewFullscreen ? undefined : beginPreviewPan}
          onMouseDownCapture={previewFullscreen ? undefined : suppressPreviewMiddleMouse}
          onAuxClickCapture={previewFullscreen ? undefined : suppressPreviewMiddleMouse}
          onWheel={previewFullscreen ? undefined : zoomPreviewFromCanvas}>
          {previewZoomFocus !== undefined && !previewFullscreen && <div className="preview-zoom-focus" aria-hidden="true"
            data-phase={previewZoomFocus.phase}
            style={{ left: previewZoomFocus.x, top: previewZoomFocus.y }}
            onPointerDown={beginPreviewZoomFocusMove}
            onPointerEnter={() => setPreviewZoomFocus(current => current === undefined
              ? undefined : { ...current, phase: document.hasFocus() ? 'active' : 'fading' })}
            onPointerLeave={() => setPreviewZoomFocus(current => current === undefined
              ? undefined : { ...current, phase: 'fading' })} />}
          <div className="preview-artboard" data-empty={previewUrl === undefined || undefined}
            data-mode={previewMode}
            style={previewFullscreen
              ? { inset: 0, width: '100%', height: '100%' }
              : { left: previewRect.x, top: previewRect.y, width: previewRect.width, height: previewRect.height }}>
            <div className="preview-viewport" style={previewFullscreen
              ? { width: '100%', height: '100%' }
              : { width: previewViewport.width, height: previewViewport.height, transform: `scale(${previewScale})` }}>
                {previewUrl === undefined && <EmptyState className="preview-empty"
                      title={selectedDraft !== undefined ? t('previewStartDraft', { name: selectedDraft.label })
                        : drafts.length === 0 ? t('createFirstDraft') : t('previewNoOpenDraft')}
                      description={selectedDraft !== undefined ? t('previewHostDescription')
                        : drafts.length === 0 ? t('previewCreateDescription')
                          : t('previewReopenDescription')}
                      action={selectedDraft === undefined
                        ? drafts.length === 0
                          ? <Button variant="primary" onClick={() => setCreateDialogOpen(true)}>{t('createDraft')}</Button>
                          : <Button variant="primary" onClick={() => {
                              setLeftSidebarCollapsed(false)
                              setLeftPanel('plugins')
                            }}>{t('openPluginManagement')}</Button>
                        : undefined} />}
                {currentInstance !== undefined && <iframe ref={previewFrameRef(CURRENT_INSTANCE_KEY)}
                  key={`${CURRENT_INSTANCE_KEY}:${currentInstance.bridgeCapability}:${previewVersions[CURRENT_INSTANCE_KEY] ?? 0}`}
                  data-active={selectedDraftId === undefined} aria-hidden={selectedDraftId !== undefined}
                  title={t('currentInstancePreview')} src={currentInstance.previewUrl} />}
                {openDrafts.flatMap(draft => {
                  const url = draft.runtime.previewUrl
                  const session = draft.runtime.bridgeCapability
                  if (url === undefined || session === undefined) return []
                  const active = draft.id === selectedDraftId
                  return <iframe ref={previewFrameRef(draft.id)}
                    key={`${draft.id}:${session}:${previewVersions[draft.id] ?? 0}`}
                    data-active={active} aria-hidden={!active}
                    title={t('previewFrameTitle')} src={url} />
                })}
            </div>
            {!previewFullscreen && <ResizeHandles kind="preview" onPointerDown={beginPreviewResize} />}
          </div>
        </div>
      </Panel>

      <aside id="draft-control-sidebar" className="studio-inspector-rail studio-sidebar" data-collapsed={rightSidebarCollapsed}
        aria-label={t('inspectorSidebar')}>
        {!rightSidebarCollapsed && <span className="sidebar-resizer" data-side="right" role="separator" tabIndex={0}
          aria-label={t('inspectorResize')} aria-orientation="vertical"
          aria-valuemin={RIGHT_SIDEBAR_MIN} aria-valuemax={RIGHT_SIDEBAR_MAX} aria-valuenow={rightSidebarWidth}
          onPointerDown={event => beginSidebarResize(event, 'right')}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            changeSidebarWidthByKeyboard('right', event.key === 'ArrowLeft' ? -12 : 12)
          }} />}
        <Panel className="studio-inspector studio-inspector-block">
          <div className="inspector-nav">
            {!rightSidebarCollapsed && <Tabs id="studio" label={t('studioTools')} value={panel} onChange={(value: Panel) => setPanel(value)} options={availablePanels.map(item => ({
                value: item,
                label: item === 'elements' ? t('panelElements') : item === 'selection' ? t('panelSelect') : item === 'source' ? t('panelSource')
                  : item === 'build' ? t('panelBuild') : t('panelAgent'),
              }))} />}
            <IconButton size="small" variant="ghost" aria-expanded={!rightSidebarCollapsed}
              aria-controls="draft-control-sidebar" onClick={() => setRightSidebarCollapsed(value => !value)}
              label={rightSidebarCollapsed ? t('inspectorExpand') : t('inspectorCollapse')}>
              <SidebarToggleIcon side="right" collapsed={rightSidebarCollapsed} />
            </IconButton>
          </div>

        {error !== undefined && <Notice className="panel-error" tone="danger">{error}</Notice>}

        {panel === 'elements' && <PanelBody id="studio-panel-elements" aria-labelledby="studio-tab-elements" className="panel-content elements-panel" role="tabpanel">
          <div className="panel-heading">
            <div><h2>{t('elementsTitle')}</h2><p>{t('elementsDescription')}</p></div>
            <div className="elements-heading-actions">
              <Badge tone="info">{draftElements.length}</Badge>
              <Button variant="primary" size="small" loading={elementSourceBusy}
                loadingLabel={t('savingElementToSource')}
                disabled={!hasModifiedElementSource || elementSourceBusy || selectedBuildRunning}
                onClick={() => void saveElementDefaults()}>{t('saveElementToSource')}</Button>
            </div>
          </div>
          {elementSourceMessage !== undefined && <Notice className="element-source-notice" tone="success">{elementSourceMessage}</Notice>}
          {draftElements.length === 0 && draftVariables.length === 0
            ? <EmptyState title={t('elementsEmpty')}
                description={t('elementsEmptyDescription')} />
            : <>
                {draftElements.length > 0 && <div className="element-tree" aria-label={t('registeredElements')}>
                  {draftElements.map((element, index) => {
                    const matched = matchedElement?.element.id === element.element.id
                    return <ElementTreeNode key={element.element.id} element={element} matched={matched}
                      styles={elementStyles[elementStyleKey(selectedDraftId!, element)] ?? []}
                      selectorCandidates={elementSelectorCandidates[elementStyleKey(selectedDraftId!, element)] ?? []}
                      onRequestSelectors={() => requestElementStyleSelectors(element)}
                      canEditStyles={selectedDraft?.runtime.state === 'running'}
                      sourceAvailable={files.some(file => file.path === element.element.source.file)}
                      initialOpen={matched || index === 0}
                      onOpenSource={() => {
                        setPanel('source')
                        void openFile(element.element.source.file)
                      }}
                      onChange={(definition, value) => setVariable({
                        scope: 'element', owner: element.owner, elementId: element.element.id,
                        variableId: definition.id, value,
                      }, definition.defaultSource === undefined ? undefined : element.values[definition.id])}
                      onAddStyleRule={selector => addElementStyleRule(element, selector)}
                      onRemoveStyleRule={selector => removeElementStyleRule(element, selector)}
                      onAddStyle={(selector, property, value) => setElementStyle(element, selector, property, value)}
                      onRemoveStyle={(selector, property) => setElementStyle(element, selector, property)}
                      t={t} />
                  })}
                </div>}

                {draftVariables.map(group => <section className="global-variables" key={group.owner}>
                  <div className="section-heading"><strong>{t('pluginVariables')}</strong><span>{flattenVariableTree(group.variables).length}</span></div>
                  <VariableTree nodes={group.variables} values={group.values}
                    onChange={(definition, value) => setVariable({ scope: 'global', owner: group.owner, variableId: definition.id, value })} />
                </section>)}
                <p className="variable-note">{t('variableNote')}</p>
              </>}
        </PanelBody>}

        {panel === 'selection' && <PanelBody id="studio-panel-selection" aria-labelledby="studio-tab-selection" className="panel-content selection-panel" role="tabpanel">
          <div className="panel-heading">
            <div><h2>{t('selectionTitle')}</h2><p>{selectedDraftId === undefined
              ? t('selectionCurrentDescription') : t('selectionDescription')}</p></div>
          </div>
          {selection === undefined
            ? <EmptyState title={t('selectionEmpty')}
                description={t('selectionEmptyDescription')} />
            : <section className="selection-result" aria-label={t('selectedElement')}>
                <div className="selection-title">
                  <code>{selection.tag}{selection.id === undefined ? '' : `#${selection.id}`}
                    {selection.classes.map(name => `.${name}`).join('')}</code>
                  <Badge tone={selection.confidence === 'mapped' ? 'success' : selection.confidence === 'component-only' ? 'info' : 'neutral'}>
                    {selection.confidence === 'mapped' ? t('confidenceSourceMapped')
                      : selection.confidence === 'component-only' ? t('confidenceReactMapped') : t('confidenceDomOnly')}
                  </Badge>
                </div>
                {selection.text !== '' && <p className="selection-text">{selection.text}</p>}
                <dl className="selection-meta">
                  <div><dt>{t('position')}</dt><dd>{Math.round(selection.rect.x)}, {Math.round(selection.rect.y)} · {Math.round(selection.rect.width)} × {Math.round(selection.rect.height)}</dd></div>
                  {selection.react?.component !== undefined && <div><dt>{t('component')}</dt><dd>{selection.react.component}</dd></div>}
                  {selection.react !== undefined && selection.react.owners.length > 0
                    && <div><dt>{t('owners')}</dt><dd>{selection.react.owners.join(' → ')}</dd></div>}
                  {selection.react?.source !== undefined && <div><dt>{t('source')}</dt><dd>
                    <code>{selection.react.source.resolved?.package === undefined ? '' : `${selection.react.source.resolved.package} · `}
                      {selection.react.source.resolved?.file ?? selection.react.source.file}
                      {selection.react.source.line === undefined ? '' : `:${selection.react.source.line}`}
                      {selection.react.source.column === undefined ? '' : `:${selection.react.source.column}`}</code>
                    {selection.react.source.resolved !== undefined && <small className="source-resolution">
                      {selection.react.source.resolved.kind} · {selection.react.source.resolved.confidence}
                    </small>}
                    {selection.react.source.resolved?.kind === 'draft' && <Button className="source-link" variant="ghost" size="small" onClick={() => {
                      setPanel('source')
                      void openFile(selection.react!.source!.resolved!.file)
                    }}>{t('openSelectedSource')}</Button>}
                  </dd></div>}
                </dl>
                <div className="selection-actions">
                  <Button size="small" variant="primary" disabled={selection.react?.source?.resolved?.package === undefined
                    || selectedDraftId === undefined || ((selection.text.trim() === '') && (matchedElement !== undefined
                      || selection.react.component === undefined || automaticPatchScope(selection) === undefined))}
                    onClick={() => setAutomaticPatchOpen(true)}>{t('automaticPatchAction')}</Button>
                </div>
                {selection.react !== undefined && Object.keys(selection.react.props).length > 0 && <details>
                  <summary>{t('safeProps')}</summary>
                  <pre className="selection-code">{JSON.stringify(selection.react.props, null, 2)}</pre>
                </details>}
                <details>
                  <summary>{t('sanitizedHtml')}</summary>
                  <pre className="selection-code">{selection.outerHTML}</pre>
                </details>
              </section>}
        </PanelBody>}

        {panel === 'source' && <PanelBody id="studio-panel-source" aria-labelledby="studio-tab-source" className="panel-content source-panel" role="tabpanel">
          <div className="panel-heading">
            <div><h2>{t('sourceTitle')}</h2><p>{t('sourceDescription')}</p></div>
          </div>
          <div className="source-toolbar">
            <FormField id="source-file" label={t('projectFile')}>
              <Select value={filePath} onChange={event => void openFile(event.target.value)}
                disabled={project === undefined || fileBusy}>
                <option value="">{files.length === 0 ? t('noEditableFiles') : t('selectFile')}</option>
                {files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
              </Select>
            </FormField>
          </div>
          {filePath === ''
            ? <EmptyState className="source-empty" title={project === undefined ? t('openLinkedDraft') : t('selectDraftFile')}
                description={t('sourceSafety')} />
            : <>
                <CodeEditor key={filePath} path={filePath} value={source} onChange={setSource} />
                <div className="source-actions">
                  <span>{source === savedSource ? t('saved') : t('unsaved')}</span>
                  <Button variant="primary" onClick={() => void saveFile()} loading={fileBusy}
                    loadingLabel={t('saving')} disabled={source === savedSource}>{t('saveToDraft')}</Button>
                </div>
              </>}
        </PanelBody>}

        {panel === 'build' && <PanelBody id="studio-panel-build" aria-labelledby="studio-tab-build"
          className="panel-content build-panel" role="tabpanel">
          <div className="panel-heading build-heading">
            <div><h2>{t('panelBuild')}</h2><p>{t('buildDescription')}</p></div>
          </div>
          <section className="build-action" aria-label={t('hotReload')}>
            <div><strong>{t('hotReload')}</strong><p>{t('hotReloadDescription')}</p></div>
            <Button variant="primary" onClick={() => void hotReloadDraft()} loading={selectedBuildRunning}
              loadingLabel={t('hotReloading')}
              disabled={project?.state !== 'active' || selectedDraft?.runtime.state !== 'running'}>
              <RefreshIcon />{t('hotReload')}
            </Button>
          </section>
          {project?.state !== 'active' && <Notice className="build-notice" tone="warning">
            {t('hotReloadUnavailable')}
          </Notice>}
          {selectedBuildOutput !== undefined && <section className="build-output" aria-label={t('latestBuildOutput')}>
            <div><strong>{t('latestBuild')}</strong><code>{selectedBuildOutput.argv.join(' ')}</code></div>
            {(selectedBuildOutput.stdout !== '' || selectedBuildOutput.stderr !== '')
              && <pre className="selection-code">{[selectedBuildOutput.stdout, selectedBuildOutput.stderr].filter(Boolean).join('\n')}</pre>}
          </section>}
          <section className="readiness-section" aria-labelledby="studio-readiness-title">
            <div className="panel-heading readiness-heading">
              <h3 id="studio-readiness-title">{t('readinessTitle')}</h3>
              <Button size="small" onClick={() => void runPack()} loading={packingDraftId === selectedDraftId} loadingLabel={t('checking')}
                disabled={project === undefined}>{t('packDryRun')}</Button>
            </div>
            {project === undefined
              ? <EmptyState title={t('openDraftFirst')} description={t('readinessEmptyDescription')} />
              : <>
                <div className="readiness-summary" aria-label={t('readinessSummary')}>
                  {(['error', 'warning', 'info'] as StudioReadinessLevel[]).map(level => <div key={level} data-level={level}>
                    <strong>{readiness.findings.filter(item => item.level === level).length}</strong>
                    <span>{level === 'error' ? t('readinessError') : level === 'warning' ? t('readinessWarning') : t('readinessInfo')}</span>
                  </div>)}
                </div>
                {readiness.findings.length === 0
                  ? <p className="readiness-clear">{t('readinessClear')}</p>
                  : <div className="readiness-findings">{readiness.findings.map((item, index) => <article
                      key={`${item.code}:${item.patch ?? item.file ?? index}`} data-level={item.level}>
                      <div><span>{item.level === 'error' ? t('readinessError')
                        : item.level === 'warning' ? t('readinessWarning') : t('readinessInfo')}</span><code>{item.code}</code></div>
                      <p>{item.message}</p>
                      {(item.file !== undefined || item.patch !== undefined) && <small>{[item.patch, item.file].filter(Boolean).join(' · ')}</small>}
                    </article>)}</div>}
                {readiness.pack !== undefined && <section className="pack-result" data-ok={readiness.pack.ok} aria-label={t('packDryRunResult')}>
                  <div><strong>{readiness.pack.ok ? t('packPassed') : t('packFailed')}</strong>
                    <span>{t('fileCount', { count: readiness.pack.files.length })}</span></div>
                  {readiness.pack.files.length > 0 && <details><summary>{t('viewPackFiles')}</summary>
                    <pre className="selection-code">{readiness.pack.files.join('\n')}</pre></details>}
                  {(readiness.pack.stdout !== '' || readiness.pack.stderr !== '') && <details><summary>{t('viewNpmOutput')}</summary>
                    <pre className="selection-code">{[readiness.pack.stdout, readiness.pack.stderr].filter(Boolean).join('\n')}</pre></details>}
                </section>}
              </>}
          </section>
        </PanelBody>}

        {panel === 'agent' && <PanelBody id="studio-panel-agent" aria-labelledby="studio-tab-agent" className="agent-panel" role="tabpanel">
          <div className="panel-heading agent-heading">
            <div><h2>{t('agentTitle')}</h2><p>{selectedDraftId === undefined
              ? t('agentCurrentInstanceSubtitle') : t('agentSubtitle')}</p></div>
            <div className="agent-heading-actions">
              {running && <Button variant="danger" size="small" onClick={() => void cancel()}>{t('agentCancel')}</Button>}
              {sessionId !== undefined && <Button size="small" loading={leavingAgentDraftId === activePreviewKey}
                loadingLabel={t('agentLeaving')} disabled={running} title={running ? t('agentLeaveRunning') : t('agentLeaveDescription')}
                onClick={() => void leaveAgent()}>{t('agentLeave')}</Button>}
            </div>
          </div>
          <AgentSession entries={events} streaming={streaming} queue={queuedPrompts} prompt={prompt}
            placeholder={selectedDraftId === undefined ? t('agentCurrentPlaceholder') : undefined}
            sessionActive={sessionId !== undefined} sending={sending} models={agentModels}
            modelsLoading={loadingAgentModels} modelSelecting={selectingAgentModel}
            contextPressure={agentContextPressure} contextBreakdown={agentContextBreakdown}
            loadingOlder={loadingOlderMessages}
            hasOlder={hasOlderMessages} t={t} onPromptChange={setPrompt} onSubmit={() => void sendPrompt()}
            onSelectModel={selection => void selectAgentModel(selection)}
            onLoadOlder={() => void loadOlderAgentMessages()}
            interaction={activeAgentInteraction === undefined ? undefined
              : <AgentInteractionComposer key={activeAgentInteraction.rpcId} interaction={activeAgentInteraction}
                  pendingCount={pendingAgentInteractions.length} approvalArguments={activeAgentApprovalArguments}
                  t={t} onRespond={respondToAgentInteraction} />}
            empty={agentTargetReady && sessionId === undefined
              ? <div className="agent-entry-actions">
                    <Button variant="primary" loading={creatingAgentDraftId === activePreviewKey} loadingLabel={t('agentStarting')}
                      onClick={() => void createAgent()}>{t('agentStart')}</Button>
                    <div className="agent-entry-divider"><span>{t('agentOrExisting')}</span></div>
                    <Select aria-label={t('agentExistingSession')} value={selectedAgentSessionId}
                      disabled={loadingAgentSessions || attachingAgentDraftId === activePreviewKey}
                      onChange={event => setSelectedAgentSessionId(event.target.value)}>
                      <option value="">{loadingAgentSessions ? t('agentSessionsLoading') : agentSessions.length === 0
                        ? t('agentSessionsEmpty') : t('agentChooseSession')}</option>
                      {agentSessions.map(session => <option key={String(session.sessionId)} value={String(session.sessionId)} disabled={session.running}>
                        {sessionTitle(session)}{session.running ? ` · ${t('agentSessionRunning')}` : ''}
                      </option>)}
                    </Select>
                    <Button loading={attachingAgentDraftId === activePreviewKey} loadingLabel={t('agentAttaching')}
                      disabled={selectedAgentSession === undefined || selectedAgentSession.running}
                      onClick={() => void attachAgent()}>{t('agentAttach')}</Button>
                    <small>{selectedDraftId === undefined ? t('agentCurrentInstanceDescription') : t('agentAttachDescription')}</small>
                  </div>
              : undefined} />
        </PanelBody>}
      </Panel>
      </aside>
    </main>
    {terminalExpanded && terminal !== null && createPortal(terminal, document.body)}
    <CreateDraftDialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} onCreate={createDraft} />
    <AutomaticPatchDialog open={automaticPatchOpen} draftId={selectedDraftId} selection={selection} files={files}
      existingElement={matchedElement} allowCss={matchedElement === undefined}
      onClose={() => setAutomaticPatchOpen(false)} onCreated={async result => {
        if (selectedDraftId === undefined) return
        await applyDraftBuild(selectedDraftId)
        setFiles(await callStudio<StudioProjectFile[]>('studio.project.files', { draftId: selectedDraftId }))
        setRightSidebarCollapsed(false)
        setPanel('elements')
        setElementSourceMessage(t('automaticPatchCreated', { count: result.provider.patchIds.length }))
      }} onAgent={nextPrompt => {
        setAutomaticPatchOpen(false)
        setPanel('agent')
        setPrompt(nextPrompt)
      }} />
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </div>
}
