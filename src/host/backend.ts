import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
import type {
  StudioBuildResult,
  StudioAgentBinding,
  StudioAgentContext,
  StudioAutomaticCssVariable,
  StudioAutomaticPatchPlan,
  StudioAutomaticPatchRequest,
  StudioAutomaticPatchWriteResult,
  StudioCreateDraftInput,
  StudioCurrentInstanceView,
  StudioDraftRecord,
  StudioDraftView,
  StudioHarmonyInspection,
  StudioHarmonyProfile,
  StudioHarmonyProfileUpdateResult,
  StudioHarmonyService,
  StudioElementStyleSource,
  StudioPreviewStatus,
  StudioPreviewUpdate,
  StudioProjectFile,
  StudioProjectState,
  StudioReadinessReport,
  StudioSourceLocation,
  StudioWorkspaceState,
} from '../contracts.js'
import { StudioAgentController, type StudioAgentWorkspace } from './agent.js'
import { analyzeAutomaticPatch, writeAutomaticPatch } from './automatic-patch.js'
import { StudioBuildRunner } from './build.js'
import type { StudioCommandRunner, StudioDraftRegistry } from './drafts.js'
import { readElementsStyles, saveElementsSource } from './element-source.js'
import { dshPackageModules, StudioPreviewSupervisor } from './preview.js'
import { applyProjectPatch, listProjectFiles, readProjectFile, writeProjectFile } from './project-files.js'
import { inspectReadiness, StudioPackRunner } from './readiness.js'
import { assertDraftPackageIdentity, installDraftDependencies } from './runtime-profile.js'
import { StudioSourceResolver } from './source-resolution.js'
import type { StudioWorkspaceStore } from './workspace.js'

const HARMONY_BIN_ENTRY = fileURLToPath(import.meta.resolve('dsh-harmony/bin'))

function objectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) throw new Error('request payload must be an object')
  return payload as Record<string, unknown>
}

function draftId(payload: unknown): string {
  const id = objectPayload(payload).draftId
  if (typeof id !== 'string') throw new Error('draftId is required')
  return id
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  return value
}

function automaticPatchRequest(payload: unknown): StudioAutomaticPatchRequest {
  const input = objectPayload(payload)
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error('automatic Patch targets must be a non-empty array')
  }
  const targets = input.targets.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error(`automatic Patch target ${index} must be an object`)
    const target = value as Record<string, unknown>
    if (typeof target.package !== 'string' || target.package === '' || typeof target.file !== 'string' || target.file === '') {
      throw new Error(`automatic Patch target ${index} requires package and file`)
    }
    return { package: target.package, file: target.file }
  })
  if (input.kind === 'replace-string') {
    if (typeof input.text !== 'string' || typeof input.replacement !== 'string' || typeof input.clientFile !== 'string'
      || typeof input.selector !== 'string' || typeof input.elementId !== 'string' || typeof input.elementLabel !== 'string'
      || typeof input.boundary !== 'object' || input.boundary === null || !Array.isArray((input.boundary as Record<string, unknown>).path)) {
      throw new Error('automatic content Patch requires text, replacement, client source, boundary, selector, and element identity')
    }
    const boundary = input.boundary as Record<string, unknown>
    if (typeof boundary.surfaceId !== 'string' || !(boundary.path as unknown[]).every(item => typeof item === 'string')) {
      throw new Error('automatic content Patch boundary is invalid')
    }
    if (input.targetSelector !== undefined && (typeof input.targetSelector !== 'string' || input.targetSelector === '')) {
      throw new Error('automatic content Patch target selector is invalid')
    }
    if (input.elementSourceFile !== undefined && (typeof input.elementSourceFile !== 'string' || input.elementSourceFile === '')) {
      throw new Error('automatic content Patch Element source is invalid')
    }
    return {
      kind: input.kind, targets, text: input.text, replacement: input.replacement, clientFile: input.clientFile,
      boundary: { surfaceId: boundary.surfaceId, path: boundary.path as string[] },
      ...(input.targetSelector === undefined ? {} : { targetSelector: input.targetSelector as string }),
      selector: input.selector, elementId: input.elementId, elementLabel: input.elementLabel,
      ...(input.elementSourceFile === undefined ? {} : { elementSourceFile: input.elementSourceFile as string }),
    }
  }
  if (input.kind !== 'css-style' || typeof input.component !== 'string' || typeof input.clientFile !== 'string'
    || typeof input.selector !== 'string' || typeof input.elementId !== 'string' || typeof input.elementLabel !== 'string'
    || typeof input.boundary !== 'object' || input.boundary === null || !Array.isArray((input.boundary as Record<string, unknown>).path)
    || !Array.isArray(input.variables)) throw new Error('automatic CSS Patch requires component, client source, boundary, selector, element identity, and variables')
  const boundary = input.boundary as Record<string, unknown>
  if (typeof boundary.surfaceId !== 'string' || !(boundary.path as unknown[]).every(item => typeof item === 'string')) {
    throw new Error('automatic CSS Patch boundary is invalid')
  }
  if (input.targetSelector !== undefined && (typeof input.targetSelector !== 'string' || input.targetSelector === '')) {
    throw new Error('automatic CSS Patch target selector is invalid')
  }
  return {
    kind: input.kind,
    targets,
    component: input.component,
    clientFile: input.clientFile,
    boundary: { surfaceId: boundary.surfaceId, path: boundary.path as string[] },
    ...(input.targetSelector === undefined ? {} : { targetSelector: input.targetSelector as string }),
    selector: input.selector,
    elementId: input.elementId,
    elementLabel: input.elementLabel,
    variables: input.variables as StudioAutomaticCssVariable[],
  }
}

function elementStyleSources(payload: unknown): StudioElementStyleSource[] {
  const value = objectPayload(payload).styles
  if (!Array.isArray(value)) throw new Error('styles must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`styles[${index}] must be an object`)
    const input = entry as Record<string, unknown>
    if (typeof input.elementId !== 'string' || !Array.isArray(input.rules)) throw new Error(`styles[${index}] requires elementId and rules`)
    return { elementId: input.elementId, rules: input.rules as StudioElementStyleSource['rules'] }
  })
}

class StudioDraftController implements StudioAgentWorkspace {
  readonly kind = 'draft' as const
  private projectState?: StudioProjectState
  private previewState: StudioPreviewStatus = { connected: false, mode: 'browse' }
  private readonly builds: StudioBuildRunner
  private readonly packs: StudioPackRunner
  private readonly agent: StudioAgentController
  private automaticPatchWrites: Promise<void> = Promise.resolve()
  readonly preview: StudioPreviewSupervisor

  constructor(
    public record: StudioDraftRecord,
    profileDir: string,
    parentOrigin: string,
    private readonly commands: StudioCommandRunner,
    harmonyBinEntry: string,
    agents: AgentRegistry,
    subprocess: SubprocessRuntime,
  ) {
    this.preview = new StudioPreviewSupervisor(record, profileDir, parentOrigin, commands, harmonyBinEntry)
    this.builds = new StudioBuildRunner(subprocess)
    this.packs = new StudioPackRunner(subprocess)
    this.agent = new StudioAgentController(agents, this)
  }

  view(): StudioDraftView {
    const agent = this.agent.snapshot()
    return {
      ...this.record,
      runtime: this.preview.snapshot(),
      ...(this.projectState === undefined ? {} : { project: this.projectState }),
      ...(agent === undefined ? {} : { agent }),
    }
  }

  async start(): Promise<StudioDraftView> {
    await this.preview.start()
    this.projectState = await this.preview.state()
    return this.view()
  }

  async stop(): Promise<StudioDraftView> {
    await this.agent.leave()
    await this.builds.cancel()
    await this.preview.stop()
    this.projectState = undefined
    this.previewState = { connected: false, mode: 'browse' }
    return this.view()
  }

  async dispose(): Promise<void> {
    await this.agent.leave()
    await this.builds.dispose()
    await this.packs.dispose()
    await this.preview.dispose()
  }

  project(): StudioProjectState {
    if (this.projectState === undefined) throw new Error('Draft Preview Host is not running')
    return this.projectState
  }

  async refreshProject(): Promise<StudioProjectState> {
    this.projectState = await this.preview.state()
    return this.projectState
  }

  async activate(graphRev: string): Promise<StudioProjectState> {
    this.projectState = await this.preview.activate(graphRev)
    return this.projectState
  }

  selection(): StudioPreviewStatus['selection'] {
    return this.previewState.selection
  }

  async context(): Promise<StudioAgentContext> {
    const selection = this.selection()
    const refs = new Map<string, { package: string; file: string }>()
    for (const patch of selection?.react?.patches ?? []) {
      const key = `${patch.target.package}\0${patch.target.file}`
      refs.set(key, patch.target)
    }
    const source = selection?.react?.source?.resolved
    if (source?.package !== undefined) {
      const key = `${source.package}\0${source.file}`
      refs.set(key, { package: source.package, file: source.file })
    }
    const allTargetRefs = [...refs.values()]
    const targetRefs = allTargetRefs.slice(0, 8)
    const inspections = await Promise.all(targetRefs.map(ref => this.inspectHarmony(ref)))
    const inspectedHarmony = inspections.length === 0 ? null : {
      patches: [...new Map(inspections.flatMap(item => item.patches).map(patch => [patch.key, patch])).values()],
      targets: [...new Map(inspections.flatMap(item => item.targets).map(target => [`${target.package}\0${target.file}`, target])).values()],
    }
    const harmony = inspectedHarmony !== null && Buffer.byteLength(JSON.stringify(inspectedHarmony)) <= 256 * 1024
      ? inspectedHarmony : null
    const readiness = await this.readiness()
    return {
      target: 'draft',
      readOnly: false,
      selection: selection ?? null,
      project: this.project(),
      preview: this.previewStatus(),
      projectFiles: await listProjectFiles(this.record.root),
      profile: await this.harmonyProfile(),
      harmony,
      targetRefs,
      targetRefsTruncated: targetRefs.length < allTargetRefs.length,
      readiness: { findings: readiness.findings },
    }
  }

  updatePreview(update: StudioPreviewUpdate): StudioPreviewStatus {
    const next = { ...this.previewState, ...update } as StudioPreviewStatus & {
      selection?: StudioPreviewStatus['selection'] | null
      registry?: StudioPreviewStatus['registry'] | null
    }
    if (next.selection === null) delete next.selection
    if (next.registry === null) delete next.registry
    this.previewState = next
    return this.previewState
  }

  previewStatus(): StudioPreviewStatus {
    return this.previewState
  }

  resolveSource(source: StudioSourceLocation) {
    return this.preview.resolveSource(source)
  }

  readDependencySource(packageName: string, file: string): Promise<string> {
    return this.preview.readDependencySource(packageName, file)
  }

  async inspectHarmony(input: { package?: string; file?: string }): Promise<StudioHarmonyInspection> {
    return (await this.preview.inspect(input)).harmony
  }

  harmonyProfile() {
    return this.preview.profile()
  }

  profile(): Promise<StudioHarmonyProfile> {
    return this.preview.profile()
  }

  updateProfile(input: { order?: string[]; patchOrder?: string[]; disabled?: string[] }): Promise<StudioHarmonyProfileUpdateResult> {
    return this.preview.updateProfile(input)
  }

  async readiness(): Promise<StudioReadinessReport> {
    const inspection = await this.preview.inspect()
    return inspectReadiness(
      this.record.root,
      this.record.name,
      inspection.harmony,
      `${this.record.runtimeHome}/profiles/web`,
    )
  }

  async pack(): Promise<StudioReadinessReport> {
    const report = await this.readiness()
    report.pack = await this.packs.run(this.record.root)
    return report
  }

  async readFile(path: string): Promise<string> {
    return readProjectFile(this.record.root, path)
  }

  async applyPatch(path: string, before: string, after: string): Promise<'created' | 'updated'> {
    return applyProjectPatch(this.record.root, path, before, after)
  }

  private draftElements() {
    const elements = this.previewStatus().registry?.elements.filter(item => item.owner === this.record.name) ?? []
    if (elements.length === 0) throw new Error('No Elements are registered by the active Draft')
    return elements
  }

  async readElementStyles(): Promise<StudioElementStyleSource[]> {
    return readElementsStyles(this.record.root, this.draftElements())
  }

  async saveElementSource(styles: StudioElementStyleSource[]): Promise<{ files: string[] }> {
    return saveElementsSource(this.record.root, this.draftElements(), styles)
  }

  async analyzeAutomaticPatch(request: StudioAutomaticPatchRequest): Promise<StudioAutomaticPatchPlan> {
    const sources = await Promise.all(request.targets.map(target => this.preview.readPatchTarget(target.package, target.file)))
    return analyzeAutomaticPatch(request, sources, this.record.name)
  }

  async createAutomaticPatch(request: StudioAutomaticPatchRequest): Promise<StudioAutomaticPatchWriteResult> {
    const run = this.automaticPatchWrites.then(async () => {
      const plan = await this.analyzeAutomaticPatch(request)
      const result = await writeAutomaticPatch(this.record.root, plan)
      if (plan.client !== undefined) await installDraftDependencies(this.record, this.commands)
      return result
    })
    this.automaticPatchWrites = run.then(() => undefined, () => undefined)
    return run
  }

  async build(signal: AbortSignal): Promise<StudioBuildResult> {
    const current = this.project()
    if (current.state !== 'active') throw new Error('Draft must be active before it can be built')
    await assertDraftPackageIdentity(this.record)
    const build = await this.builds.run(current.root, signal)
    this.projectState = await this.preview.applyBuild()
    return { build, project: this.projectState }
  }

  cancelBuild(): Promise<boolean> {
    return this.builds.cancel()
  }

  createAgent(agentPreset?: string): Promise<StudioAgentBinding> {
    return this.agent.create(agentPreset)
  }

  attachAgent(sessionId: string): Promise<StudioAgentBinding> {
    return this.agent.attach(sessionId)
  }

  async leaveAgent(): Promise<StudioDraftView> {
    await this.agent.leave()
    return this.view()
  }
}

class StudioCurrentInstanceController implements StudioAgentWorkspace {
  readonly kind = 'current-instance' as const
  private previewState: StudioPreviewStatus = { connected: false, mode: 'browse' }
  private readonly agent: StudioAgentController
  private readonly sources: StudioSourceResolver

  constructor(
    private readonly harmony: StudioHarmonyService,
    agents: AgentRegistry,
    private readonly previewUrl: string,
    private readonly bridgeCapability: string,
  ) {
    this.agent = new StudioAgentController(agents, this)
    const profileDir = harmony.profile().dir
    this.sources = new StudioSourceResolver(undefined, profileDir, [dshPackageModules(HARMONY_BIN_ENTRY)])
  }

  view(): StudioCurrentInstanceView {
    const agent = this.agent.snapshot()
    return {
      previewUrl: this.previewUrl,
      bridgeCapability: this.bridgeCapability,
      ...(agent === undefined ? {} : { agent }),
    }
  }

  project(): StudioProjectState {
    const profile = this.harmony.profile()
    return {
      name: 'current-webui',
      root: profile.dir,
      state: 'active',
      graphRev: this.previewState.graphRev ?? String(profile.revision),
    }
  }

  selection() {
    return this.previewState.selection
  }

  previewStatus(): StudioPreviewStatus {
    return this.previewState
  }

  updatePreview(update: StudioPreviewUpdate): StudioPreviewStatus {
    const next = { ...this.previewState, ...update } as StudioPreviewStatus & {
      selection?: StudioPreviewStatus['selection'] | null
      registry?: StudioPreviewStatus['registry'] | null
    }
    if (next.selection === null) delete next.selection
    if (next.registry === null) delete next.registry
    this.previewState = next
    return this.previewState
  }

  resolveSource(source: StudioSourceLocation) {
    return this.sources.resolve(source)
  }

  harmonyProfile() {
    return Promise.resolve(this.harmony.profile())
  }

  inspectHarmony(input: { package?: string; file?: string }): Promise<StudioHarmonyInspection> {
    return Promise.resolve(this.harmony.inspect(input))
  }

  readDependencySource(packageName: string, file: string): Promise<string> {
    return this.sources.readDependency(packageName, file)
  }

  async context(): Promise<StudioAgentContext> {
    const selection = this.selection()
    const refs = new Map<string, { package: string; file: string }>()
    for (const patch of selection?.react?.patches ?? []) {
      refs.set(`${patch.target.package}\0${patch.target.file}`, patch.target)
    }
    const source = selection?.react?.source?.resolved
    if (source?.package !== undefined) refs.set(`${source.package}\0${source.file}`, { package: source.package, file: source.file })
    const allTargetRefs = [...refs.values()]
    const targetRefs = allTargetRefs.slice(0, 8)
    const inspections = await Promise.all(targetRefs.map(ref => this.inspectHarmony(ref)))
    const inspectedHarmony = inspections.length === 0 ? null : {
      patches: [...new Map(inspections.flatMap(item => item.patches).map(patch => [patch.key, patch])).values()],
      targets: [...new Map(inspections.flatMap(item => item.targets).map(target => [`${target.package}\0${target.file}`, target])).values()],
    }
    const harmony = inspectedHarmony !== null && Buffer.byteLength(JSON.stringify(inspectedHarmony)) <= 256 * 1024
      ? inspectedHarmony : null
    return {
      target: 'current-instance',
      readOnly: true,
      selection: selection ?? null,
      project: this.project(),
      preview: this.previewStatus(),
      projectFiles: [],
      profile: this.harmony.profile(),
      harmony,
      targetRefs,
      targetRefsTruncated: targetRefs.length < allTargetRefs.length,
      readiness: { findings: [] },
    }
  }

  createAgent(agentPreset?: string) {
    return this.agent.create(agentPreset)
  }

  attachAgent(sessionId: string) {
    return this.agent.attach(sessionId)
  }

  async leaveAgent(): Promise<StudioCurrentInstanceView> {
    await this.agent.leave()
    return this.view()
  }

  dispose() {
    return this.agent.leave()
  }
}

/** Stable-Host control plane for persistent, isolated Draft Preview runtimes. */
export class StudioBackend {
  private readonly controllers = new Map<string, StudioDraftController>()
  private readonly controllerCreations = new Map<string, Promise<StudioDraftController>>()
  private readonly current: StudioCurrentInstanceController

  constructor(
    private readonly harmony: StudioHarmonyService,
    private readonly agents: AgentRegistry,
    private readonly subprocess: SubprocessRuntime,
    private readonly registry: StudioDraftRegistry,
    private readonly workspace: StudioWorkspaceStore,
    private readonly commands: StudioCommandRunner,
    private readonly parentOrigin: string,
    currentBridgeCapability = 'current-instance',
  ) {
    this.current = new StudioCurrentInstanceController(
      harmony,
      agents,
      `${parentOrigin}/#dsh-studio-preview=${encodeURIComponent(currentBridgeCapability)}`,
      currentBridgeCapability,
    )
  }

  currentGet(): StudioCurrentInstanceView {
    return this.current.view()
  }

  currentPreviewStatus(): StudioPreviewStatus {
    return this.current.previewStatus()
  }

  currentProjectState(): StudioProjectState {
    return this.current.project()
  }

  currentContext(): Promise<StudioAgentContext> {
    return this.current.context()
  }

  currentHarmonyProfile() {
    return this.current.harmonyProfile()
  }

  currentHarmonyInspect(input: { package?: string; file?: string }): Promise<StudioHarmonyInspection> {
    return this.current.inspectHarmony(input)
  }

  currentReadDependencySource(input: { package: string; file: string }): Promise<string> {
    return this.current.readDependencySource(input.package, input.file)
  }

  currentPreviewUpdate(input: StudioPreviewUpdate): StudioPreviewStatus {
    return this.current.updatePreview(this.parsePreviewStatus(input))
  }

  currentResolveSource(input: { source: StudioSourceLocation }) {
    if (typeof input.source?.file !== 'string') throw new Error('source is required')
    return this.current.resolveSource(input.source)
  }

  currentAgentCreate(input: { agentPreset?: string }): Promise<StudioAgentBinding> {
    if (input.agentPreset !== undefined && typeof input.agentPreset !== 'string') throw new Error('agentPreset must be a string')
    return this.current.createAgent(input.agentPreset)
  }

  currentAgentAttach(input: { sessionId: string }): Promise<StudioAgentBinding> {
    if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') throw new Error('sessionId is required')
    if ([...this.controllers.values()].some(controller => controller.view().agent?.sessionId === input.sessionId)) {
      throw new Error('the selected session is already attached to a Draft')
    }
    return this.current.attachAgent(input.sessionId)
  }

  currentAgentLeave(): Promise<StudioCurrentInstanceView> {
    return this.current.leaveAgent()
  }

  draftsList(): Promise<StudioDraftView[]> {
    return this.list()
  }

  draftsCreate(input: StudioCreateDraftInput): Promise<StudioDraftView> {
    return this.create(input)
  }

  async workspaceGet(): Promise<StudioWorkspaceState> {
    const records = await this.registry.list()
    return this.workspace.read(records.map(record => record.id))
  }

  async workspaceUpdate(input: StudioWorkspaceState): Promise<StudioWorkspaceState> {
    const records = await this.registry.list()
    return this.workspace.write(input, records.map(record => record.id))
  }

  async harmonyProfile(input: { draftId: string }): Promise<StudioHarmonyProfile> {
    return (await this.controller(draftId(input))).profile()
  }

  async harmonyInspect(input: { draftId: string; package?: string; file?: string }): Promise<StudioHarmonyInspection> {
    const controller = await this.controller(draftId(input))
    return controller.inspectHarmony({
      ...(input.package === undefined ? {} : { package: input.package }),
      ...(input.file === undefined ? {} : { file: input.file }),
    })
  }

  async harmonyUpdateProfile(input: {
    draftId: string
    order?: string[]
    patchOrder?: string[]
    disabled?: string[]
  }): Promise<StudioHarmonyProfileUpdateResult> {
    const controller = await this.controller(draftId(input))
    const order = optionalStringList(input.order, 'order')
    const patchOrder = optionalStringList(input.patchOrder, 'patchOrder')
    const disabled = optionalStringList(input.disabled, 'disabled')
    return controller.updateProfile({
      ...(order === undefined ? {} : { order }),
      ...(patchOrder === undefined ? {} : { patchOrder }),
      ...(disabled === undefined ? {} : { disabled }),
    })
  }

  async draftsRename(input: { draftId: string; label: string }): Promise<StudioDraftView> {
    const controller = await this.controller(draftId(input))
    if (typeof input.label !== 'string') throw new Error('Draft name is required')
    controller.record = await this.registry.rename(controller.record.id, input.label)
    return controller.view()
  }

  async draftsExport(input: { draftId: string }): Promise<StudioDraftView> {
    const controller = await this.controller(draftId(input))
    controller.record = await this.registry.export(controller.record.id)
    return controller.view()
  }

  async draftsStart(input: { draftId: string }): Promise<StudioDraftView> {
    return (await this.controller(draftId(input))).start()
  }

  async draftsStop(input: { draftId: string }): Promise<StudioDraftView> {
    return (await this.controller(draftId(input))).stop()
  }

  async projectState(input: { draftId: string }): Promise<StudioProjectState> {
    return (await this.controller(draftId(input))).refreshProject()
  }

  async projectActivate(input: { draftId: string; graphRev: string }): Promise<StudioProjectState> {
    if (typeof input.graphRev !== 'string') throw new Error('graphRev is required')
    return (await this.controller(draftId(input))).activate(input.graphRev)
  }

  async projectFiles(input: { draftId: string }): Promise<StudioProjectFile[]> {
    const controller = await this.controller(draftId(input))
    return listProjectFiles(controller.record.root)
  }

  async projectReadFile(input: { draftId: string; path: string }): Promise<{ path: string; content: string }> {
    if (typeof input.path !== 'string') throw new Error('path is required')
    const controller = await this.controller(draftId(input))
    return { path: input.path, content: await controller.readFile(input.path) }
  }

  async projectWriteFile(input: { draftId: string; path: string; content: string }): Promise<{ path: string; saved: true }> {
    if (typeof input.path !== 'string' || typeof input.content !== 'string') throw new Error('path and content are required')
    const controller = await this.controller(draftId(input))
    await writeProjectFile(controller.record.root, input.path, input.content)
    return { path: input.path, saved: true }
  }

  async elementsStyles(input: { draftId: string }): Promise<StudioElementStyleSource[]> {
    return (await this.controller(draftId(input))).readElementStyles()
  }

  async elementsSaveSource(input: { draftId: string; styles: StudioElementStyleSource[] }): Promise<{ files: string[] }> {
    return (await this.controller(draftId(input))).saveElementSource(elementStyleSources(input))
  }

  async patchesAnalyzeAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }): Promise<StudioAutomaticPatchPlan> {
    return (await this.controller(draftId(input))).analyzeAutomaticPatch(automaticPatchRequest(input))
  }

  async patchesCreateAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }): Promise<StudioAutomaticPatchWriteResult> {
    return (await this.controller(draftId(input))).createAutomaticPatch(automaticPatchRequest(input))
  }

  async projectBuild(input: { draftId: string }, signal: AbortSignal): Promise<StudioBuildResult> {
    return (await this.controller(draftId(input))).build(signal)
  }

  async projectCancelBuild(input: { draftId: string }): Promise<{ canceled: boolean }> {
    return { canceled: await (await this.controller(draftId(input))).cancelBuild() }
  }

  async readinessInspect(input: { draftId: string }): Promise<StudioReadinessReport> {
    return (await this.controller(draftId(input))).readiness()
  }

  async readinessPack(input: { draftId: string }): Promise<StudioReadinessReport> {
    return (await this.controller(draftId(input))).pack()
  }

  async previewStatus(input: { draftId: string }): Promise<StudioPreviewStatus> {
    return (await this.controller(draftId(input))).previewStatus()
  }

  async previewUpdate(input: StudioPreviewUpdate & { draftId: string }): Promise<StudioPreviewStatus> {
    return (await this.controller(draftId(input))).updatePreview(this.parsePreviewStatus(input))
  }

  async previewResolveSource(input: { draftId: string; source: StudioSourceLocation }) {
    if (typeof input.source?.file !== 'string') throw new Error('source is required')
    return (await this.controller(draftId(input))).resolveSource(input.source)
  }

  async agentCreate(input: { draftId: string; agentPreset?: string }): Promise<StudioAgentBinding> {
    if (input.agentPreset !== undefined && typeof input.agentPreset !== 'string') throw new Error('agentPreset must be a string')
    return (await this.controller(draftId(input))).createAgent(input.agentPreset)
  }

  async agentAttach(input: { draftId: string; sessionId: string }): Promise<StudioAgentBinding> {
    const controller = await this.controller(draftId(input))
    if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') throw new Error('sessionId is required')
    if (this.current.view().agent?.sessionId === input.sessionId) {
      throw new Error('the selected session is already attached to the current instance')
    }
    const other = [...this.controllers.entries()].find(([id, candidate]) => (
      id !== controller.record.id && candidate.view().agent?.sessionId === input.sessionId
    ))
    if (other !== undefined) throw new Error('the selected session is already attached to another Draft')
    return controller.attachAgent(input.sessionId)
  }

  async agentLeave(input: { draftId: string }): Promise<StudioDraftView> {
    return (await this.controller(draftId(input))).leaveAgent()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.controllerCreations.values()].map(creation => creation.catch(() => undefined)))
    await Promise.all([this.current.dispose(), ...[...this.controllers.values()].map(controller => controller.dispose())])
    this.controllers.clear()
    this.controllerCreations.clear()
  }

  private async list(): Promise<StudioDraftView[]> {
    const records = await this.registry.list()
    return records.map(record => this.controllers.get(record.id)?.view() ?? {
      ...record,
      runtime: { state: 'stopped' as const, log: '' },
    })
  }

  private async create(payload: unknown): Promise<StudioDraftView> {
    const candidate = objectPayload(payload) as unknown as StudioCreateDraftInput
    if ((candidate.profileMode !== 'main-home' && candidate.profileMode !== 'custom')
      || typeof candidate.source !== 'object' || candidate.source === null
      || (candidate.source.kind !== 'new' && candidate.source.kind !== 'existing')
      || (candidate.profileDirectory !== undefined && typeof candidate.profileDirectory !== 'string')
      || (candidate.destinationDirectory !== undefined && typeof candidate.destinationDirectory !== 'string')) {
      throw new Error('Draft source and profileMode are invalid')
    }
    const record = await this.registry.create(candidate)
    return this.makeController(record).view()
  }

  private async controller(id: string): Promise<StudioDraftController> {
    const current = this.controllers.get(id)
    if (current !== undefined) return current
    const pending = this.controllerCreations.get(id)
    if (pending !== undefined) return pending
    const creation = this.registry.get(id).then(record => this.controllers.get(id) ?? this.makeController(record))
    this.controllerCreations.set(id, creation)
    try {
      return await creation
    } finally {
      if (this.controllerCreations.get(id) === creation) this.controllerCreations.delete(id)
    }
  }

  private makeController(record: StudioDraftRecord): StudioDraftController {
    const controller = new StudioDraftController(
      record,
      this.harmony.profile().dir,
      this.parentOrigin,
      this.commands,
      HARMONY_BIN_ENTRY,
      this.agents,
      this.subprocess,
    )
    this.controllers.set(record.id, controller)
    return controller
  }

  private parsePreviewStatus(payload: unknown): StudioPreviewUpdate {
    const candidate = objectPayload(payload) as unknown as Partial<StudioPreviewUpdate>
    if (typeof candidate.connected !== 'boolean' || (candidate.mode !== 'browse' && candidate.mode !== 'inspect')
      || (candidate.graphRev !== undefined && typeof candidate.graphRev !== 'string')) {
      throw new Error('Preview status is invalid')
    }
    if (candidate.registry !== undefined && candidate.registry !== null && (typeof candidate.registry !== 'object'
      || !Array.isArray(candidate.registry.elements) || !Array.isArray(candidate.registry.variables))) {
      throw new Error('Preview registry is invalid')
    }
    return {
      connected: candidate.connected,
      mode: candidate.mode,
      ...(candidate.graphRev === undefined ? {} : { graphRev: candidate.graphRev }),
      ...(candidate.selection === undefined ? {} : { selection: candidate.selection }),
      ...(candidate.registry === undefined ? {} : { registry: candidate.registry }),
    }
  }
}
