import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {
  StudioAutomaticPatchRequest,
  StudioCreateDraftInput,
  StudioElementStyleSource,
  StudioPreviewUpdate,
  StudioSourceLocation,
  StudioWorkspaceState,
} from '../contracts.js'
import { STUDIO_INVOCATIONS } from '../studio-remote.js'
import { StudioBackend } from './backend.js'

export const STUDIO_LOCAL: TypertContribution = {
  package: 'dsh-webui-studio/studio',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: STUDIO_INVOCATIONS,
}

export class StudioService extends TypertRemoteService {
  constructor(ctx: Context, private readonly backend: StudioBackend) {
    super(ctx, 'studio')
  }

  currentGet(signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentGet() }
  currentPreviewStatus(signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentPreviewStatus() }
  currentPreviewUpdate(input: StudioPreviewUpdate, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentPreviewUpdate(input) }
  currentResolveSource(input: { source: StudioSourceLocation }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentResolveSource(input) }
  currentAgentCreate(input: { agentPreset?: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentAgentCreate(input) }
  currentAgentAttach(input: { sessionId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentAgentAttach(input) }
  currentAgentLeave(signal: AbortSignal) { signal.throwIfAborted(); return this.backend.currentAgentLeave() }

  draftsList(signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsList() }
  draftsCreate(input: StudioCreateDraftInput, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsCreate(input) }
  draftsRename(input: { draftId: string; label: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsRename(input) }
  draftsExport(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsExport(input) }
  draftsStart(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsStart(input) }
  draftsStop(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.draftsStop(input) }
  workspaceGet(signal: AbortSignal) { signal.throwIfAborted(); return this.backend.workspaceGet() }
  workspaceUpdate(input: StudioWorkspaceState, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.workspaceUpdate(input) }
  harmonyProfile(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.harmonyProfile(input) }
  harmonyInspect(input: { draftId: string; package?: string; file?: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.harmonyInspect(input) }
  harmonyUpdateProfile(input: { draftId: string; order?: string[]; patchOrder?: string[]; disabled?: string[] }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.harmonyUpdateProfile(input) }
  projectState(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectState(input) }
  projectActivate(input: { draftId: string; graphRev: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectActivate(input) }
  projectFiles(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectFiles(input) }
  projectReadFile(input: { draftId: string; path: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectReadFile(input) }
  projectWriteFile(input: { draftId: string; path: string; content: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectWriteFile(input) }
  projectBuild(input: { draftId: string }, signal: AbortSignal) { return this.backend.projectBuild(input, signal) }
  projectCancelBuild(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.projectCancelBuild(input) }
  elementsStyles(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.elementsStyles(input) }
  elementsSaveSource(input: { draftId: string; styles: StudioElementStyleSource[] }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.elementsSaveSource(input) }
  patchesAnalyzeAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.patchesAnalyzeAutomatic(input) }
  patchesCreateAutomatic(input: StudioAutomaticPatchRequest & { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.patchesCreateAutomatic(input) }
  readinessInspect(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.readinessInspect(input) }
  readinessPack(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.readinessPack(input) }
  previewStatus(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.previewStatus(input) }
  previewUpdate(input: StudioPreviewUpdate & { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.previewUpdate(input) }
  previewResolveSource(input: { draftId: string; source: StudioSourceLocation }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.previewResolveSource(input) }
  agentCreate(input: { draftId: string; agentPreset?: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.agentCreate(input) }
  agentAttach(input: { draftId: string; sessionId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.agentAttach(input) }
  agentLeave(input: { draftId: string }, signal: AbortSignal) { signal.throwIfAborted(); return this.backend.agentLeave(input) }
}
