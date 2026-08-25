import type {
  HarmonyInspection,
  HarmonyProfileView,
  HarmonyRuntimeProfileUpdateResult,
  HarmonyService,
} from 'dsh-harmony'
import type {
  StudioElementDefinition,
  StudioVariableNode,
  StudioVariableValue,
} from 'dsh-harmony-react/studio'

export const STUDIO_PATH = '/studio'
export const STUDIO_PREVIEW_FRAGMENT = 'dsh-studio-preview'

export interface StudioServerRequest<T = unknown> {
  type: 'server-request'
  rpcId: string
  method: 'events.mux' | 'events.host'
  payload: T
}

export interface StudioAgentBinding {
  sessionId: string
  agentPreset?: string
  source: 'created' | 'existing'
}

export interface StudioCurrentInstanceView {
  previewUrl: string
  bridgeCapability: string
  agent?: StudioAgentBinding
}

export interface StudioReactSnapshot {
  component?: string
  owners: string[]
  props: Record<string, string | number | boolean | null>
  source?: StudioSourceLocation & { resolved?: StudioSourceCandidate }
  patches: StudioPatchTrace[]
}

export interface StudioPatchTrace {
  key: string
  owner: string
  effect:
    | 'replace-element'
    | 'wrap-element'
    | 'insert-before'
    | 'insert-after'
    | 'transform-props'
    | 'decorate-component'
    | 'replace-component'
  declaration: string
  target: { package: string; file: string }
  confidence: 'candidate'
}

export interface StudioSourceLocation {
  file: string
  line?: number
  column?: number
}

export interface StudioSourceCandidate extends StudioSourceLocation {
  package?: string
  kind: 'draft' | 'dependency' | 'generated' | 'unknown'
  confidence: 'exact' | 'candidate'
}

export interface StudioDomSelection {
  tag: string
  id?: string
  classes: string[]
  attributes: Record<string, string>
  text: string
  outerHTML: string
  rect: { x: number; y: number; width: number; height: number }
  style: Record<string, string>
  selector?: string
  boundaries: StudioSurfaceBoundary[]
  react?: StudioReactSnapshot
  confidence: 'mapped' | 'component-only' | 'dom-only'
}

export interface StudioSurfaceBoundary {
  surfaceId: string
  path: string[]
}

export interface StudioElementStyleTarget {
  owner: string
  elementId: string
  boundary: StudioSurfaceBoundary
  selector: string
  property: string
  value?: string
}

export interface StudioElementStyleDeclaration {
  property: string
  value: string
}

export interface StudioElementStyleRule {
  selector: string
  declarations: StudioElementStyleDeclaration[]
}

export interface StudioElementStyleSource {
  elementId: string
  rules: StudioElementStyleRule[]
}

export interface StudioElementSelectorTarget {
  owner: string
  elementId: string
  boundary: StudioSurfaceBoundary
}

export interface StudioElementSnapshot {
  owner: string
  element: StudioElementDefinition
  values: Readonly<Record<string, StudioVariableValue>>
}

export interface StudioVariablesSnapshot {
  owner: string
  variables: readonly StudioVariableNode[]
  values: Readonly<Record<string, StudioVariableValue>>
}

export interface StudioRegistrySnapshot {
  elements: readonly StudioElementSnapshot[]
  variables: readonly StudioVariablesSnapshot[]
}

export interface StudioPreviewStatus {
  connected: boolean
  graphRev?: string
  mode: 'browse' | 'inspect'
  selection?: StudioDomSelection
  registry?: StudioRegistrySnapshot
}

export interface StudioAgentContext {
  target: 'draft' | 'current-instance'
  readOnly: boolean
  selection: StudioDomSelection | null
  project: StudioProjectState
  preview: StudioPreviewStatus
  projectFiles: StudioProjectFile[]
  profile: HarmonyProfileView
  harmony: StudioHarmonyInspection | null
  targetRefs: Array<{ package: string; file: string }>
  targetRefsTruncated: boolean
  readiness: { findings: StudioReadinessFinding[] }
}

export interface StudioPreviewUpdate {
  connected: boolean
  graphRev?: string
  mode: 'browse' | 'inspect'
  selection?: StudioDomSelection | null
  registry?: StudioRegistrySnapshot | null
}

export interface StudioProjectFile {
  path: string
  size: number
}

export type StudioHarmonyInspection = HarmonyInspection
export interface StudioRuntimePluginEntry {
  entryId: string
  moduleName: string
  enabled: boolean
}
export type StudioHarmonyProfile = HarmonyProfileView & { runtimePlugins: StudioRuntimePluginEntry[] }
export type StudioHarmonyProfileUpdateResult = Omit<HarmonyRuntimeProfileUpdateResult, 'profile'> & {
  profile: StudioHarmonyProfile
}

export type StudioReadinessLevel = 'error' | 'warning' | 'info'

export interface StudioReadinessFinding {
  level: StudioReadinessLevel
  code: string
  message: string
  file?: string
  patch?: string
}

export interface StudioPackResult {
  ok: boolean
  argv: string[]
  files: string[]
  stdout: string
  stderr: string
  truncated: boolean
}

export interface StudioReadinessReport {
  findings: StudioReadinessFinding[]
  pack?: StudioPackResult
}

export interface StudioProjectState {
  name: string
  root: string
  state: 'active' | 'preview-pending' | 'closed'
  graphRev: string
}

export type StudioDraftProfileMode = 'main-home' | 'custom'

export type StudioDraftSource =
  | { kind: 'new'; packageName: string }
  | { kind: 'existing'; directory: string }

export interface StudioDraftRecord {
  id: string
  name: string
  label: string
  source: StudioDraftSource
  destinationDirectory?: string
  exportedAt?: string
  repositoryDir: string
  worktreeDir: string
  root: string
  runtimeHome: string
  profileMode: StudioDraftProfileMode
  profileDirectory?: string
  createdAt: string
}

export interface StudioDraftView extends StudioDraftRecord {
  runtime: {
    state: 'stopped' | 'starting' | 'running' | 'failed'
    previewUrl?: string
    bridgeCapability?: string
    error?: string
    log: string
  }
  project?: StudioProjectState
  agent?: StudioAgentBinding
}

export interface StudioCreateDraftInput {
  source: StudioDraftSource
  profileMode: StudioDraftProfileMode
  profileDirectory?: string
  destinationDirectory?: string
}

export interface StudioWorkspaceState {
  openDraftIds: string[]
  selectedDraftId?: string
}

export interface StudioBuildOutput {
  argv: string[]
  stdout: string
  stderr: string
  truncated: boolean
}

export interface StudioBuildResult {
  project: StudioProjectState
  build: StudioBuildOutput
}

export interface StudioAutomaticPatchTarget {
  package: string
  file: string
}

export interface StudioAutomaticCssVariable {
  id: string
  label: string
  property: string
  control: 'color' | 'length' | 'number' | 'enum' | 'string'
  value: string | number
  options?: string[]
  constraints?: { min?: number; max?: number; step?: number }
}

export type StudioAutomaticPatchRequest =
  | {
    kind: 'replace-string'
    targets: StudioAutomaticPatchTarget[]
    text: string
    replacement: string
    clientFile: string
    boundary: StudioSurfaceBoundary
    targetSelector?: string
    selector: string
    elementId: string
    elementLabel: string
    elementSourceFile?: string
  }
  | {
    kind: 'css-style'
    targets: StudioAutomaticPatchTarget[]
    component: string
    clientFile: string
    boundary: StudioSurfaceBoundary
    targetSelector?: string
    selector: string
    elementId: string
    elementLabel: string
    variables: StudioAutomaticCssVariable[]
  }

export interface StudioAutomaticPatchMatch {
  line: number
  column: number
  excerpt: string
  applicable: boolean
  reason?: string
}

export interface StudioAutomaticPatchTargetAnalysis extends StudioAutomaticPatchTarget {
  version: string
  matches: StudioAutomaticPatchMatch[]
}

export interface StudioAutomaticPatchPlan {
  request: StudioAutomaticPatchRequest
  targets: StudioAutomaticPatchTargetAnalysis[]
  canApply: boolean
  provider: {
    file: string
    source: string
    patchIds: string[]
  }
  client?: {
    file: string
    source: string
    export: string
    entryFile: string
  }
}

export interface StudioAutomaticPatchWriteResult extends StudioAutomaticPatchPlan {
  files: string[]
}

export type StudioHarmonyService = HarmonyService

export interface StudioPreviewInspection {
  harmony: StudioHarmonyInspection
}
