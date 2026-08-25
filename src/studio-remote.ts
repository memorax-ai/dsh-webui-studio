import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  StudioAgentBinding,
  StudioAutomaticPatchPlan,
  StudioAutomaticPatchRequest,
  StudioAutomaticPatchWriteResult,
  StudioBuildResult,
  StudioCreateDraftInput,
  StudioCurrentInstanceView,
  StudioDraftView,
  StudioElementStyleSource,
  StudioHarmonyInspection,
  StudioHarmonyProfile,
  StudioHarmonyProfileUpdateResult,
  StudioPreviewStatus,
  StudioPreviewUpdate,
  StudioProjectFile,
  StudioProjectState,
  StudioReadinessReport,
  StudioSourceCandidate,
  StudioSourceLocation,
  StudioWorkspaceState,
} from './contracts.js'

export interface StudioRemote {
  currentGet(signal?: AbortSignal): Promise<RemoteResult<StudioCurrentInstanceView>>
  currentPreviewStatus(signal?: AbortSignal): Promise<RemoteResult<StudioPreviewStatus>>
  currentPreviewUpdate(input: StudioPreviewUpdate, signal?: AbortSignal): Promise<RemoteResult<StudioPreviewStatus>>
  currentResolveSource(input: { source: StudioSourceLocation }, signal?: AbortSignal): Promise<RemoteResult<StudioSourceCandidate>>
  currentAgentCreate(input: { agentPreset?: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAgentBinding>>
  currentAgentAttach(input: { sessionId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAgentBinding>>
  currentAgentLeave(signal?: AbortSignal): Promise<RemoteResult<StudioCurrentInstanceView>>
  draftsList(signal?: AbortSignal): Promise<RemoteResult<StudioDraftView[]>>
  draftsCreate(input: StudioCreateDraftInput, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
  draftsRename(input: { draftId: string; label: string }, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
  draftsExport(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
  draftsStart(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
  draftsStop(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
  workspaceGet(signal?: AbortSignal): Promise<RemoteResult<StudioWorkspaceState>>
  workspaceUpdate(input: StudioWorkspaceState, signal?: AbortSignal): Promise<RemoteResult<StudioWorkspaceState>>
  harmonyProfile(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioHarmonyProfile>>
  harmonyInspect(input: { draftId: string; package?: string; file?: string }, signal?: AbortSignal): Promise<RemoteResult<StudioHarmonyInspection>>
  harmonyUpdateProfile(input: {
    draftId: string
    order?: string[]
    patchOrder?: string[]
    disabled?: string[]
  }, signal?: AbortSignal): Promise<RemoteResult<StudioHarmonyProfileUpdateResult>>
  projectState(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioProjectState>>
  projectActivate(input: { draftId: string; graphRev: string }, signal?: AbortSignal): Promise<RemoteResult<StudioProjectState>>
  projectFiles(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioProjectFile[]>>
  projectReadFile(input: { draftId: string; path: string }, signal?: AbortSignal): Promise<RemoteResult<{ path: string; content: string }>>
  projectWriteFile(input: { draftId: string; path: string; content: string }, signal?: AbortSignal): Promise<RemoteResult<{ path: string; saved: true }>>
  projectBuild(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioBuildResult>>
  projectCancelBuild(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<{ canceled: boolean }>>
  elementsStyles(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioElementStyleSource[]>>
  elementsSaveSource(input: { draftId: string; styles: StudioElementStyleSource[] }, signal?: AbortSignal): Promise<RemoteResult<{ files: string[] }>>
  patchesAnalyzeAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAutomaticPatchPlan>>
  patchesCreateAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAutomaticPatchWriteResult>>
  readinessInspect(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioReadinessReport>>
  readinessPack(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioReadinessReport>>
  previewStatus(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioPreviewStatus>>
  previewUpdate(input: StudioPreviewUpdate & { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioPreviewStatus>>
  previewResolveSource(input: { draftId: string; source: StudioSourceLocation }, signal?: AbortSignal): Promise<RemoteResult<StudioSourceCandidate>>
  agentCreate(input: { draftId: string; agentPreset?: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAgentBinding>>
  agentAttach(input: { draftId: string; sessionId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioAgentBinding>>
  agentLeave(input: { draftId: string }, signal?: AbortSignal): Promise<RemoteResult<StudioDraftView>>
}

export function invokeStudioRemote(
  remote: StudioRemote,
  method: string,
  payload: any,
  signal?: AbortSignal,
): Promise<RemoteResult<unknown>> | undefined {
  const calls: Readonly<Record<string, () => Promise<RemoteResult<unknown>>>> = {
    'studio.current.get': () => remote.currentGet(signal),
    'studio.current.preview.status': () => remote.currentPreviewStatus(signal),
    'studio.current.preview.update': () => remote.currentPreviewUpdate(payload, signal),
    'studio.current.resolveSource': () => remote.currentResolveSource(payload, signal),
    'studio.current.agent.create': () => remote.currentAgentCreate(payload, signal),
    'studio.current.agent.attach': () => remote.currentAgentAttach(payload, signal),
    'studio.current.agent.leave': () => remote.currentAgentLeave(signal),
    'studio.drafts.list': () => remote.draftsList(signal),
    'studio.drafts.create': () => remote.draftsCreate(payload, signal),
    'studio.drafts.rename': () => remote.draftsRename(payload, signal),
    'studio.drafts.export': () => remote.draftsExport(payload, signal),
    'studio.drafts.start': () => remote.draftsStart(payload, signal),
    'studio.drafts.stop': () => remote.draftsStop(payload, signal),
    'studio.workspace.get': () => remote.workspaceGet(signal),
    'studio.workspace.update': () => remote.workspaceUpdate(payload, signal),
    'studio.drafts.harmony.profile': () => remote.harmonyProfile(payload, signal),
    'studio.drafts.harmony.inspect': () => remote.harmonyInspect(payload, signal),
    'studio.drafts.harmony.updateProfile': () => remote.harmonyUpdateProfile(payload, signal),
    'studio.harmony.inspect': () => remote.harmonyInspect(payload, signal),
    'studio.project.state': () => remote.projectState(payload, signal),
    'studio.project.activate': () => remote.projectActivate(payload, signal),
    'studio.project.files': () => remote.projectFiles(payload, signal),
    'studio.project.readFile': () => remote.projectReadFile(payload, signal),
    'studio.project.writeFile': () => remote.projectWriteFile(payload, signal),
    'studio.project.build': () => remote.projectBuild(payload, signal),
    'studio.project.cancelBuild': () => remote.projectCancelBuild(payload, signal),
    'studio.elements.styles': () => remote.elementsStyles(payload, signal),
    'studio.elements.saveSource': () => remote.elementsSaveSource(payload, signal),
    'studio.patches.analyzeAutomatic': () => remote.patchesAnalyzeAutomatic(payload, signal),
    'studio.patches.createAutomatic': () => remote.patchesCreateAutomatic(payload, signal),
    'studio.readiness.inspect': () => remote.readinessInspect(payload, signal),
    'studio.readiness.pack': () => remote.readinessPack(payload, signal),
    'studio.preview.status': () => remote.previewStatus(payload, signal),
    'studio.preview.update': () => remote.previewUpdate(payload, signal),
    'studio.preview.resolveSource': () => remote.previewResolveSource(payload, signal),
    'studio.agent.create': () => remote.agentCreate(payload, signal),
    'studio.agent.attach': () => remote.agentAttach(payload, signal),
    'studio.agent.leave': () => remote.agentLeave(payload, signal),
  }
  return calls[method]?.()
}

const nonEmpty = z.string().min(1)
const draftIdSchema = z.object({ draftId: nonEmpty })
const stringList = z.array(nonEmpty)
const sourceLocationSchema = z.object({
  file: nonEmpty,
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
})
const boundarySchema = z.object({ surfaceId: nonEmpty, path: stringList })
const targetSchema = z.object({ package: nonEmpty, file: nonEmpty })
const createDraftSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('new'), packageName: nonEmpty }),
    z.object({ kind: z.literal('existing'), directory: nonEmpty }),
  ]),
  profileMode: z.enum(['main-home', 'custom']),
  profileDirectory: nonEmpty.optional(),
  destinationDirectory: nonEmpty.optional(),
})
const workspaceSchema = z.object({
  openDraftIds: z.array(nonEmpty),
  selectedDraftId: nonEmpty.optional(),
})
const harmonyInputSchema = draftIdSchema.extend({ package: nonEmpty.optional(), file: nonEmpty.optional() })
const profileUpdateSchema = draftIdSchema.extend({
  order: stringList.optional(),
  patchOrder: stringList.optional(),
  disabled: stringList.optional(),
})
const styleSchema = z.object({
  elementId: nonEmpty,
  rules: z.array(z.object({
    selector: z.string(),
    declarations: z.array(z.object({ property: nonEmpty, value: z.string() })),
  })),
})
const automaticBase = {
  draftId: nonEmpty,
  targets: z.array(targetSchema).min(1),
  clientFile: nonEmpty,
  boundary: boundarySchema,
  targetSelector: nonEmpty.optional(),
  selector: nonEmpty,
  elementId: nonEmpty,
  elementLabel: nonEmpty,
}
const automaticPatchSchema = z.discriminatedUnion('kind', [
  z.object({
    ...automaticBase,
    kind: z.literal('replace-string'),
    text: z.string(),
    replacement: z.string(),
    elementSourceFile: nonEmpty.optional(),
  }),
  z.object({
    ...automaticBase,
    kind: z.literal('css-style'),
    component: nonEmpty,
    variables: z.array(z.object({
      id: nonEmpty,
      label: nonEmpty,
      property: nonEmpty,
      control: z.enum(['color', 'length', 'number', 'enum', 'string']),
      value: z.union([z.string(), z.number()]),
      options: stringList.optional(),
      constraints: z.object({
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
      }).optional(),
    })).min(1),
  }),
])
const previewUpdateSchema = draftIdSchema.extend({
  connected: z.boolean(),
  graphRev: z.string().optional(),
  mode: z.enum(['browse', 'inspect']),
  selection: z.unknown().optional(),
  registry: z.unknown().optional(),
})
const currentPreviewUpdateSchema = previewUpdateSchema.omit({ draftId: true })

function codec(typeSymbol: string, schema: z.ZodType): InvocationDescriptor['result'] {
  return { mode: 'strict', typeSymbol, schema }
}

function invocation(method: string, input?: z.ZodType, result: z.ZodType = z.unknown()): InvocationDescriptor {
  return {
    id: `dsh-webui-studio#studio/${method}`,
    service: 'studio',
    namespace: 'studio',
    method,
    invocation: { kind: 'direct' },
    parameters: input === undefined ? [] : [{
      name: 'input',
      wire: 'input',
      source: 'json',
      codec: codec(`dsh-webui-studio#studio/${method}:input`, input),
    }],
    cancellation: { parameter: 'signal' },
    result: codec(`dsh-webui-studio#studio/${method}:result`, result),
  }
}

export const STUDIO_INVOCATIONS: readonly InvocationDescriptor[] = [
  invocation('currentGet'),
  invocation('currentPreviewStatus'),
  invocation('currentPreviewUpdate', currentPreviewUpdateSchema),
  invocation('currentResolveSource', z.object({ source: sourceLocationSchema })),
  invocation('currentAgentCreate', z.object({ agentPreset: nonEmpty.optional() })),
  invocation('currentAgentAttach', z.object({ sessionId: nonEmpty })),
  invocation('currentAgentLeave'),
  invocation('draftsList'),
  invocation('draftsCreate', createDraftSchema),
  invocation('draftsRename', draftIdSchema.extend({ label: z.string() })),
  invocation('draftsExport', draftIdSchema),
  invocation('draftsStart', draftIdSchema),
  invocation('draftsStop', draftIdSchema),
  invocation('workspaceGet'),
  invocation('workspaceUpdate', workspaceSchema),
  invocation('harmonyProfile', draftIdSchema),
  invocation('harmonyInspect', harmonyInputSchema),
  invocation('harmonyUpdateProfile', profileUpdateSchema),
  invocation('projectState', draftIdSchema),
  invocation('projectActivate', draftIdSchema.extend({ graphRev: nonEmpty })),
  invocation('projectFiles', draftIdSchema),
  invocation('projectReadFile', draftIdSchema.extend({ path: nonEmpty })),
  invocation('projectWriteFile', draftIdSchema.extend({ path: nonEmpty, content: z.string() })),
  invocation('projectBuild', draftIdSchema),
  invocation('projectCancelBuild', draftIdSchema, z.object({ canceled: z.boolean() })),
  invocation('elementsStyles', draftIdSchema),
  invocation('elementsSaveSource', draftIdSchema.extend({ styles: z.array(styleSchema) })),
  invocation('patchesAnalyzeAutomatic', automaticPatchSchema),
  invocation('patchesCreateAutomatic', automaticPatchSchema),
  invocation('readinessInspect', draftIdSchema),
  invocation('readinessPack', draftIdSchema),
  invocation('previewStatus', draftIdSchema),
  invocation('previewUpdate', previewUpdateSchema),
  invocation('previewResolveSource', draftIdSchema.extend({ source: sourceLocationSchema })),
  invocation('agentCreate', draftIdSchema.extend({ agentPreset: nonEmpty.optional() })),
  invocation('agentAttach', draftIdSchema.extend({ sessionId: nonEmpty })),
  invocation('agentLeave', draftIdSchema),
]

export const STUDIO_REMOTE: TypertRemoteContribution = {
  package: 'dsh-webui-studio/studio',
  descriptors: STUDIO_INVOCATIONS,
}
