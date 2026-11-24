import { STUDIO_RUNTIME_KEY, type StudioBrowserRuntime } from 'dsh-harmony-react/studio-host'
import {
  getElementAtPoint,
  getElementBounds,
  getElementContext,
  isElementGrabbable,
  type ReactGrabElementContext,
} from 'react-grab/primitives'
import {
  STUDIO_PREVIEW_FRAGMENT,
  type StudioDomSelection,
  type StudioElementSelectorTarget,
  type StudioElementStyleTarget,
  type StudioReactSnapshot,
  type StudioSurfaceBoundary,
} from '../contracts'
import { StudioPreviewRegistry, type StudioVariableTarget } from './registry'
import { patchTraces, type FiberSnapshot } from './provenance'
import { pointInsideSelection } from './selection'
import { compileElementStyleSelector } from './element-style-selector'

const MAX_TEXT = 2_000
const MAX_HTML = 16_000
const SENSITIVE_ATTRIBUTE = /(?:value|password|passwd|secret|token|auth|cookie|session|credential)/i

interface BridgeMessage {
  type?: unknown
  sessionId?: unknown
  nonce?: unknown
  mode?: unknown
  target?: unknown
  requestId?: unknown
}

const elementStyles = new Map<string, StudioElementStyleTarget>()
let elementStyleObserver: MutationObserver | undefined
let elementStyleSheet: HTMLStyleElement | undefined
const styledElements = new Set<Element>()

declare global {
  interface Window {
    __DSH_STUDIO_PREVIEW__?: { parentOrigin: string; capability: string }
  }
}

const previewCapability = new URLSearchParams(location.hash.slice(1)).get(STUDIO_PREVIEW_FRAGMENT)
const previewConfig = window.__DSH_STUDIO_PREVIEW__
const previewEnabled = previewConfig !== undefined && previewCapability === previewConfig.capability
let port: MessagePort | undefined
let sessionId = ''
let nonce = ''
let readySent = false

function post(message: Record<string, unknown>): void {
  if (port !== undefined && nonce !== '') port.postMessage({ ...message, sessionId, nonce })
}

function boundedText(value: unknown, max = 2_000): value is string {
  return typeof value === 'string' && value.length <= max
}

function variableTarget(value: unknown): value is StudioVariableTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  const variableValue = target.value
  if (!(typeof variableValue === 'boolean' || (typeof variableValue === 'number' && Number.isFinite(variableValue))
    || boundedText(variableValue))) return false
  if (!boundedText(target.owner, 1_000) || !boundedText(target.variableId, 500)) return false
  if (target.scope === 'global') return true
  return target.scope === 'element' && boundedText(target.elementId, 500)
}

function elementStyleTarget(value: unknown): value is StudioElementStyleTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as Partial<StudioElementStyleTarget>
  return boundedText(target.owner, 1_000) && boundedText(target.elementId, 500)
    && typeof target.boundary === 'object' && target.boundary !== null
    && boundedText(target.boundary.surfaceId, 1_000) && Array.isArray(target.boundary.path)
    && target.boundary.path.length > 0 && target.boundary.path.every(segment => boundedText(segment, 500))
    && boundedText(target.selector, 1_000) && target.selector.startsWith('&')
    && !/[{},;]/.test(target.selector)
    && typeof target.property === 'string' && /^(?:--)?[a-zA-Z][a-zA-Z0-9-]*$/.test(target.property)
    && (target.value === undefined || boundedText(target.value, 2_000))
}

function elementSelectorTarget(value: unknown): value is StudioElementSelectorTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as Partial<StudioElementSelectorTarget>
  return boundedText(target.owner, 1_000) && boundedText(target.elementId, 500)
    && typeof target.boundary === 'object' && target.boundary !== null
    && boundedText(target.boundary.surfaceId, 1_000) && Array.isArray(target.boundary.path)
    && target.boundary.path.length > 0 && target.boundary.path.every(segment => boundedText(segment, 500))
}

function boundaryMatches(element: Element, boundary: StudioElementStyleTarget['boundary']): boolean {
  if (element.getAttribute('data-ui-surface') !== boundary.surfaceId) return false
  try {
    const path = JSON.parse(element.getAttribute('data-ui-surface-path') ?? '') as unknown
    return Array.isArray(path) && path.length === boundary.path.length && path.every((segment, index) => segment === boundary.path[index])
  } catch {
    return false
  }
}

function styleGroupKey(target: StudioElementStyleTarget): string {
  return `${target.owner}\0${target.elementId}\0${target.boundary.surfaceId}\0${JSON.stringify(target.boundary.path)}`
}

function validateRelativeSelector(selector: string): void {
  document.querySelector(compileElementStyleSelector(selector, '[data-dsh-studio-scope~="preview"]'))
}

function applyElementStyles(): void {
  elementStyleObserver?.disconnect()
  for (const element of styledElements) element.removeAttribute('data-dsh-studio-scope')
  styledElements.clear()
  elementStyleSheet?.remove()
  elementStyleSheet = undefined
  if (elementStyles.size === 0) return

  const elements = [...document.querySelectorAll('[data-ui-surface][data-ui-surface-path]')]
  const groups = new Map<string, { token: string; rules: Map<string, StudioElementStyleTarget[]> }>()
  for (const target of elementStyles.values()) {
    validateRelativeSelector(target.selector)
    const key = styleGroupKey(target)
    let group = groups.get(key)
    if (group === undefined) {
      group = { token: `s${groups.size + 1}`, rules: new Map() }
      groups.set(key, group)
      for (const element of elements) {
        if (!boundaryMatches(element, target.boundary)) continue
        const tokens = new Set((element.getAttribute('data-dsh-studio-scope') ?? '').split(/\s+/).filter(Boolean))
        tokens.add(group.token)
        element.setAttribute('data-dsh-studio-scope', [...tokens].join(' '))
        styledElements.add(element)
      }
    }
    const declarations = group.rules.get(target.selector)
    if (declarations === undefined) group.rules.set(target.selector, [target])
    else declarations.push(target)
  }

  elementStyleSheet = document.createElement('style')
  elementStyleSheet.dataset.dshStudioElementStyles = ''
  document.head.append(elementStyleSheet)
  const sheet = elementStyleSheet.sheet
  if (sheet === null) throw new Error('Preview stylesheet is unavailable')
  for (const group of groups.values()) {
    const scope = `[data-dsh-studio-scope~="${group.token}"]`
    for (const [selector, declarations] of group.rules) {
      const index = sheet.insertRule(`${compileElementStyleSelector(selector, scope)} {}`, sheet.cssRules.length)
      const rule = sheet.cssRules[index]
      if (!(rule instanceof CSSStyleRule)) throw new Error('Preview CSS rule could not be created')
      for (const declaration of declarations) rule.style.setProperty(declaration.property, declaration.value ?? '')
    }
  }
  elementStyleObserver?.observe(document.documentElement, { childList: true, subtree: true })
}

function updateElementStyle(target: StudioElementStyleTarget): void {
  validateRelativeSelector(target.selector)
  const key = `${styleGroupKey(target)}\0${target.selector}\0${target.property}`
  if (target.value === undefined) elementStyles.delete(key)
  else elementStyles.set(key, target)
  if (elementStyles.size > 0 && elementStyleObserver === undefined) {
    elementStyleObserver = new MutationObserver(() => applyElementStyles())
    elementStyleObserver.observe(document.documentElement, { childList: true, subtree: true })
  } else if (elementStyles.size === 0) {
    elementStyleObserver?.disconnect()
    elementStyleObserver = undefined
  }
  applyElementStyles()
}

function elementSelectorCandidates(target: StudioElementSelectorTarget): string[] {
  const candidates = new Set<string>()
  const roots = [...document.querySelectorAll('[data-ui-surface][data-ui-surface-path]')]
    .filter(element => boundaryMatches(element, target.boundary))
  const addElement = (prefix: string, element: Element): void => {
    candidates.add(`${prefix}${element.localName}`)
    for (const className of element.classList) candidates.add(`${prefix}.${CSS.escape(className)}`)
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith('data-ui-') || SENSITIVE_ATTRIBUTE.test(attribute.name)) continue
      candidates.add(`${prefix}[${CSS.escape(attribute.name)}]`)
    }
  }
  for (const root of roots) {
    for (const className of root.classList) candidates.add(`&.${CSS.escape(className)}`)
    for (const attribute of root.attributes) {
      if (attribute.name.startsWith('data-ui-') || SENSITIVE_ATTRIBUTE.test(attribute.name)) continue
      candidates.add(`&[${CSS.escape(attribute.name)}]`)
    }
    for (const child of [...root.children].slice(0, 100)) addElement('& > ', child)
    for (const descendant of [...root.querySelectorAll('*')].slice(0, 200)) addElement('& ', descendant)
  }
  return [...candidates].sort().slice(0, 500)
}

const registry = new StudioPreviewRegistry(() => {
  try {
    post({ type: 'registry', registry: registry.snapshot() })
  } catch (error) {
    post({ type: 'registry-error', code: 'preview-registry', error: error instanceof Error ? error.message : String(error) })
  }
})
const studioGlobal = globalThis as typeof globalThis & { [STUDIO_RUNTIME_KEY]?: StudioBrowserRuntime }
if (previewEnabled) studioGlobal[STUDIO_RUNTIME_KEY] = registry

function safeProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(props ?? {}).slice(0, 40)) {
    if (SENSITIVE_ATTRIBUTE.test(key) || key === 'children') continue
    if (typeof value === 'string') output[key] = value.slice(0, 200)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value
    else if (Array.isArray(value)) output[key] = `[array:${value.length}]`
    else output[key] = `[${typeof value}]`
  }
  return output
}

function reactSnapshot(context: ReactGrabElementContext): StudioReactSnapshot | undefined {
  const fiber = context.fiber as FiberSnapshot | null
  if (fiber === null && context.componentName === null && context.filePath === null) return undefined
  const owners = context.stack.flatMap(frame => typeof frame.functionName === 'string' && frame.functionName !== context.componentName
    ? [frame.functionName]
    : []).filter((name, index, all) => all.indexOf(name) === index)
  const source = context.filePath === null ? undefined : {
    file: context.filePath.slice(0, 1_000),
    ...(context.lineNumber === null ? {} : { line: context.lineNumber }),
    ...(context.columnNumber === null ? {} : { column: context.columnNumber }),
  }
  return {
    ...(context.componentName === null ? {} : { component: context.componentName }),
    owners: owners.slice(0, 20),
    props: safeProps(fiber?.memoizedProps),
    patches: patchTraces(fiber),
    ...(source === undefined ? {} : { source }),
  }
}

function formControl(element: Element): boolean {
  return element.matches('input, textarea, select')
}

function safeAttribute(name: string, value: string): string {
  const sanitized = /^(?:href|src|action|formaction|poster|cite)$/i.test(name) ? value.replace(/[?#].*/s, '') : value
  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}…` : sanitized
}

function sanitizedHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element
  const nodes = [clone, ...clone.querySelectorAll('*')]
  for (const node of nodes) {
    for (const attribute of [...node.attributes]) {
      if (SENSITIVE_ATTRIBUTE.test(attribute.name)) node.removeAttribute(attribute.name)
      else node.setAttribute(attribute.name, safeAttribute(attribute.name, attribute.value))
    }
    if (formControl(node)) {
      node.removeAttribute('value')
      node.textContent = ''
    }
  }
  return clone.outerHTML.slice(0, MAX_HTML)
}

function parentElement(element: Element): Element | undefined {
  if (element.assignedSlot !== null) return element.assignedSlot
  if (element.parentElement !== null) return element.parentElement
  const root = element.getRootNode()
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root) return (root as ShadowRoot).host
  try {
    return element.ownerDocument.defaultView?.frameElement ?? undefined
  } catch {
    return undefined
  }
}

function boundaryLineage(element: Element): StudioSurfaceBoundary[] {
  const boundaries: StudioSurfaceBoundary[] = []
  const visited = new Set<Element>()
  let current: Element | undefined = element
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    const surfaceId = current.getAttribute('data-ui-surface')
    const encodedPath = current.getAttribute('data-ui-surface-path')
    if (surfaceId !== null && encodedPath !== null) {
      try {
        const path = JSON.parse(encodedPath) as unknown
        if (Array.isArray(path) && path.length > 0 && path.every(segment => typeof segment === 'string')) {
          boundaries.push({ surfaceId, path })
        }
      } catch {}
    }
    current = parentElement(current)
  }
  return boundaries
}

async function snapshot(element: Element): Promise<StudioDomSelection> {
  const attributes: Record<string, string> = {}
  for (const attribute of [...element.attributes]) {
    if (!SENSITIVE_ATTRIBUTE.test(attribute.name)) attributes[attribute.name] = safeAttribute(attribute.name, attribute.value)
  }
  const rect = getElementBounds(element)
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element)
  let context: ReactGrabElementContext | undefined
  try {
    context = await getElementContext(element)
  } catch {}
  const react = context === undefined ? undefined : reactSnapshot(context)
  const selector = context?.selector == null || SENSITIVE_ATTRIBUTE.test(context.selector)
    ? undefined
    : context.selector.slice(0, 2_000)
  return {
    tag: element.tagName.toLowerCase(),
    ...(element.id === '' ? {} : { id: element.id }),
    classes: [...element.classList].slice(0, 30),
    attributes,
    text: formControl(element) ? '' : (element.textContent ?? '').trim().slice(0, MAX_TEXT),
    outerHTML: sanitizedHtml(element),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: {
      display: computed?.display ?? '',
      position: computed?.position ?? '',
      color: computed?.color ?? '',
      backgroundColor: computed?.backgroundColor ?? '',
      fontFamily: computed?.fontFamily ?? '',
      fontSize: computed?.fontSize ?? '',
    },
    boundaries: boundaryLineage(element),
    ...(selector === undefined ? {} : { selector }),
    ...(react === undefined ? {} : { react }),
    confidence: react === undefined ? 'dom-only' : react.source === undefined ? 'component-only' : 'mapped',
  }
}

let mode: 'browse' | 'inspect' = 'browse'
let candidate: Element | undefined
let overlay: HTMLDivElement | undefined
let shield: HTMLDivElement | undefined
let locked = false
let selectionRequest = 0
let panPointer: number | undefined
let panScreenX = 0
let panScreenY = 0

function showOverlay(element?: Element): void {
  candidate = element
  if (element === undefined) {
    overlay?.remove()
    overlay = undefined
    return
  }
  overlay ??= Object.assign(document.createElement('div'), { ariaHidden: 'true' })
  if (!overlay.isConnected) document.documentElement.append(overlay)
  const rect = getElementBounds(element)
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    border: '2px solid #235be6', background: 'rgba(35,91,230,.08)', boxSizing: 'border-box',
  })
}

function elementAtPointer(event: MouseEvent | PointerEvent): Element | undefined {
  const eventTarget = event.target !== null && (event.target as Node).nodeType === Node.ELEMENT_NODE
    ? event.target as Element
    : undefined
  const element = eventTarget !== undefined && eventTarget.ownerDocument !== document
    ? (isElementGrabbable(eventTarget) ? eventTarget : null)
    : getElementAtPoint(event.clientX, event.clientY, {
        filter: candidate => candidate !== overlay && candidate !== shield && isElementGrabbable(candidate),
      })
  return element ?? undefined
}

function pointer(event: PointerEvent): void {
  if (!locked) showOverlay(elementAtPointer(event))
}

async function click(event: MouseEvent): Promise<void> {
  event.preventDefault()
  event.stopImmediatePropagation()
  const selected = elementAtPointer(event)
  const lockedCandidate = candidate
  const clickedInsideLockedSelection = locked
    && lockedCandidate?.isConnected === true
    && pointInsideSelection(getElementBounds(lockedCandidate), event.clientX, event.clientY)
  if (locked && !clickedInsideLockedSelection) unlockSelection()
  if (selected === undefined) return
  const request = ++selectionRequest
  try {
    const selection = await snapshot(selected)
    if (mode === 'inspect' && request === selectionRequest) post({ type: 'selection', selection })
  } catch (error) {
    if (mode === 'inspect' && request === selectionRequest) {
      post({ type: 'selection-error', code: 'preview-selection', error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function doubleClick(event: MouseEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  const selected = elementAtPointer(event)
  if (selected === undefined) return
  locked = true
  showOverlay(selected)
}

function pointerleave(): void {
  if (!locked) showOverlay()
}

function suppress(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

function zoom(event: WheelEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  post({ type: 'preview-zoom', deltaY: event.deltaY, deltaMode: event.deltaMode })
}

function refreshOverlay(): void {
  if (candidate?.isConnected === true) showOverlay(candidate)
  else if (candidate !== undefined) unlockSelection()
}

function unlockSelection(): void {
  locked = false
  selectionRequest += 1
  showOverlay()
}

function beginPan(event: PointerEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  event.stopImmediatePropagation()
  panPointer = event.pointerId
  panScreenX = event.screenX
  panScreenY = event.screenY
  if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId)
}

function movePan(event: PointerEvent): void {
  if (event.pointerId !== panPointer) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const dx = event.screenX - panScreenX
  const dy = event.screenY - panScreenY
  panScreenX = event.screenX
  panScreenY = event.screenY
  if (dx !== 0 || dy !== 0) post({ type: 'preview-pan', dx, dy })
}

function endPan(event: PointerEvent): void {
  if (event.pointerId !== panPointer) return
  event.preventDefault()
  event.stopImmediatePropagation()
  panPointer = undefined
}

function suppressMiddleMouse(event: MouseEvent): void {
  if (event.button !== 1) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  setMode('browse')
  post({ type: 'mode', mode })
}

function setMode(next: 'browse' | 'inspect'): void {
  if (mode === next) return
  unlockSelection()
  shield?.removeEventListener('pointermove', pointer)
  shield?.removeEventListener('pointerleave', pointerleave)
  shield?.removeEventListener('click', click)
  shield?.removeEventListener('dblclick', doubleClick)
  shield?.removeEventListener('contextmenu', suppress)
  shield?.remove()
  shield = undefined
  window.removeEventListener('wheel', zoom, true)
  document.removeEventListener('keydown', keydown, true)
  window.removeEventListener('resize', refreshOverlay)
  document.removeEventListener('scroll', refreshOverlay, true)
  mode = next
  if (mode === 'inspect') {
    shield = Object.assign(document.createElement('div'), { ariaHidden: 'true' })
    Object.assign(shield.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', cursor: 'crosshair', touchAction: 'none',
    })
    document.documentElement.append(shield)
    shield.addEventListener('pointermove', pointer)
    shield.addEventListener('pointerleave', pointerleave)
    shield.addEventListener('click', click)
    shield.addEventListener('dblclick', doubleClick)
    shield.addEventListener('contextmenu', suppress)
    window.addEventListener('wheel', zoom, { capture: true, passive: false })
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('resize', refreshOverlay)
    document.addEventListener('scroll', refreshOverlay, true)
  }
}

function announceReady(): void {
  if (readySent || nonce === '') return
  const boot = (globalThis as typeof globalThis & { __DSH_BOOT__?: { rev?: unknown } }).__DSH_BOOT__
  if (typeof boot?.rev !== 'string' || boot.rev === '') return
  readySent = true
  post({ type: 'preview-ready', mode, graphRev: boot.rev.slice(0, 2_000), react: 'react-grab' })
  post({ type: 'registry', registry: registry.snapshot() })
}

function receiveParentCommand(portEvent: MessageEvent): void {
  if (typeof portEvent.data !== 'object' || portEvent.data === null || Array.isArray(portEvent.data)) return
  const command = portEvent.data as BridgeMessage
  if (command.sessionId !== sessionId) return
  if (nonce === '') {
    if (command.type !== 'connect' || !boundedText(command.nonce, 200) || command.nonce === '') return
    nonce = command.nonce
    announceReady()
    return
  }
  if (command.nonce !== nonce) return
  if (command.type === 'set-mode' && (command.mode === 'browse' || command.mode === 'inspect')) setMode(command.mode)
  if (command.type === 'unlock-selection') unlockSelection()
  if (command.type === 'refresh-overlay') requestAnimationFrame(refreshOverlay)
  if (command.type === 'set-variable' && boundedText(command.requestId, 200)
    && variableTarget(command.target)) {
    void registry.set(command.target).then(() => {
      post({ type: 'variable-result', requestId: command.requestId, ok: true })
    }).catch(error => {
      post({ type: 'variable-result', requestId: command.requestId, ok: false, code: 'preview-variable', error: error instanceof Error ? error.message : String(error) })
    })
  }
  if (command.type === 'set-element-style' && boundedText(command.requestId, 200)
    && elementStyleTarget(command.target)) {
    try {
      updateElementStyle(command.target)
      post({ type: 'element-style-result', requestId: command.requestId, ok: true })
    } catch (error) {
      post({ type: 'element-style-result', requestId: command.requestId, ok: false, code: 'preview-style', error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (command.type === 'get-element-style-selectors' && boundedText(command.requestId, 200)
    && elementSelectorTarget(command.target)) {
    post({
      type: 'element-style-selectors', requestId: command.requestId,
      owner: command.target.owner, elementId: command.target.elementId,
      candidates: elementSelectorCandidates(command.target),
    })
  }
}

if (previewEnabled) {
  const channel = new MessageChannel()
  port = channel.port1
  sessionId = previewCapability
  port.onmessage = portEvent => {
    receiveParentCommand(portEvent)
  }
  port.start()
  parent.postMessage({ type: 'dsh-studio-bridge', sessionId }, previewConfig.parentOrigin, [channel.port2])
  window.addEventListener('load', announceReady, { once: true })
  window.addEventListener('pointerdown', beginPan, true)
  window.addEventListener('pointermove', movePan, true)
  window.addEventListener('pointerup', endPan, true)
  window.addEventListener('pointercancel', endPan, true)
  window.addEventListener('mousedown', suppressMiddleMouse, true)
  window.addEventListener('auxclick', suppressMiddleMouse, true)
}

window.addEventListener('beforeunload', () => {
  setMode('browse')
  elementStyleObserver?.disconnect()
  elementStyles.clear()
  window.removeEventListener('pointerdown', beginPan, true)
  window.removeEventListener('pointermove', movePan, true)
  window.removeEventListener('pointerup', endPan, true)
  window.removeEventListener('pointercancel', endPan, true)
  window.removeEventListener('mousedown', suppressMiddleMouse, true)
  window.removeEventListener('auxclick', suppressMiddleMouse, true)
  window.removeEventListener('load', announceReady)
  port?.close()
  registry.dispose()
  if (studioGlobal[STUDIO_RUNTIME_KEY] === registry) delete studioGlobal[STUDIO_RUNTIME_KEY]
})
