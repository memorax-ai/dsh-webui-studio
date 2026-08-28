import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  TypertRemoteService,
  type InvocationDescriptor,
  type RemoteResult,
  type TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'
import {
  STUDIO_PATH,
  type StudioHarmonyProfile,
  type StudioHarmonyProfileUpdateResult,
  type StudioHarmonyService,
  type StudioPreviewInspection,
  type StudioProjectState,
  type StudioSourceCandidate,
  type StudioSourceLocation,
} from '../contracts.js'
import { StudioPreviewDraft } from './preview-draft.js'
import { StudioSourceResolver } from './source-resolution.js'

interface PreviewWorkerOptions {
  root: string
  packageDirs: string[]
  parentOrigin: string
  bridgeCapability: string
  bridge: Buffer
}

export interface StudioPreviewHealth {
  ready: boolean
  error?: string
}

export interface StudioPreviewWorkerRemote {
  health(signal?: AbortSignal): Promise<RemoteResult<StudioPreviewHealth>>
  state(signal?: AbortSignal): Promise<RemoteResult<StudioProjectState>>
  activate(graphRev: string, signal?: AbortSignal): Promise<RemoteResult<StudioProjectState>>
  applyBuild(operationId: string, signal?: AbortSignal): Promise<RemoteResult<StudioProjectState>>
  inspect(input: { package?: string; file?: string }, signal?: AbortSignal): Promise<RemoteResult<StudioPreviewInspection>>
  profile(signal?: AbortSignal): Promise<RemoteResult<StudioHarmonyProfile>>
  updateProfile(input: {
    operationId: string
    order?: string[]
    patchOrder?: string[]
    disabled?: string[]
  }, signal?: AbortSignal): Promise<RemoteResult<StudioHarmonyProfileUpdateResult>>
  resolveSource(source: StudioSourceLocation, signal?: AbortSignal): Promise<RemoteResult<StudioSourceCandidate>>
  readSource(packageName: string, file: string, signal?: AbortSignal): Promise<RemoteResult<string>>
  readPatchTarget(packageName: string, file: string, signal?: AbortSignal): Promise<RemoteResult<{
    package: string
    file: string
    version: string
    source: string
  }>>
}

const projectStateSchema = z.object({
  name: z.string(),
  root: z.string(),
  state: z.enum(['active', 'preview-pending', 'closed']),
  graphRev: z.string(),
})
const sourceLocationSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
})
const sourceCandidateSchema = sourceLocationSchema.extend({
  package: z.string().optional(),
  kind: z.enum(['draft', 'dependency', 'generated', 'unknown']),
  confidence: z.enum(['exact', 'candidate']),
})
const stringListSchema = z.array(z.string().min(1))
const profileUpdateSchema = z.object({
  operationId: z.string().min(1),
  order: stringListSchema.optional(),
  patchOrder: stringListSchema.optional(),
  disabled: stringListSchema.optional(),
})
const inspectInputSchema = z.object({ package: z.string().optional(), file: z.string().optional() })
const healthSchema = z.object({ ready: z.boolean(), error: z.string().optional() })
const previewInspectionSchema = z.object({ harmony: z.unknown() })
const patchTargetSchema = z.object({
  package: z.string(),
  file: z.string(),
  version: z.string(),
  source: z.string(),
})

function jsonTransport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface ProfileUpdateOperation {
  readonly input: string
  readonly result: Promise<StudioHarmonyProfileUpdateResult>
}

const profileUpdateOperations = new Map<string, ProfileUpdateOperation>()
const applyBuildOperations = new Map<string, Promise<StudioProjectState>>()
const PROFILE_UPDATE_OPERATION_LIMIT = 32

function codec(typeSymbol: string, schema: z.ZodType): InvocationDescriptor['result'] {
  return { mode: 'strict', typeSymbol, schema }
}

function parameter(name: string, schema: z.ZodType): InvocationDescriptor['parameters'][number] {
  return { name, wire: name, source: 'json', codec: codec(`dsh-webui-studio#${name}`, schema) }
}

function invocation(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: z.ZodType,
): InvocationDescriptor {
  return {
    id: `dsh-webui-studio#studioPreviewWorker/${method}`,
    service: 'studioPreviewWorker',
    namespace: 'studioPreviewWorker',
    method,
    invocation: { kind: 'direct' },
    parameters,
    cancellation: { parameter: 'signal' },
    result: codec(`dsh-webui-studio#studioPreviewWorker/${method}:result`, result),
  }
}

export const STUDIO_PREVIEW_INVOCATIONS: readonly InvocationDescriptor[] = [
  invocation('health', [], healthSchema),
  invocation('state', [], projectStateSchema),
  invocation('activate', [parameter('graphRev', z.string().min(1))], projectStateSchema),
  invocation('applyBuild', [parameter('operationId', z.string().min(1))], projectStateSchema),
  invocation('inspect', [parameter('input', inspectInputSchema)], previewInspectionSchema),
  invocation('profile', [], z.unknown()),
  invocation('updateProfile', [parameter('input', profileUpdateSchema)], z.unknown()),
  invocation('resolveSource', [parameter('source', sourceLocationSchema)], sourceCandidateSchema),
  invocation('readSource', [parameter('packageName', z.string().min(1)), parameter('file', z.string().min(1))], z.string()),
  invocation('readPatchTarget', [parameter('packageName', z.string().min(1)), parameter('file', z.string().min(1))], patchTargetSchema),
]

export const STUDIO_PREVIEW_REMOTE: TypertRemoteContribution = {
  package: 'dsh-webui-studio/preview-worker',
  descriptors: STUDIO_PREVIEW_INVOCATIONS,
}

const STUDIO_PREVIEW_LOCAL: TypertContribution = {
  package: 'dsh-webui-studio/preview-worker',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: STUDIO_PREVIEW_INVOCATIONS,
}

export class StudioPreviewWorkerService extends TypertRemoteService {
  private readiness:
    | { state: 'starting' }
    | { state: 'ready' }
    | { state: 'failed'; error: unknown } = { state: 'starting' }
  private readonly ready: Promise<StudioPreviewDraft>
  private readonly sources: StudioSourceResolver

  constructor(
    ctx: Context,
    private readonly harmony: StudioHarmonyService,
    options: Pick<PreviewWorkerOptions, 'root' | 'packageDirs'>,
  ) {
    super(ctx, 'studioPreviewWorker')
    this.ready = Promise.resolve().then(() => new StudioPreviewDraft(ctx, harmony, options.root).open())
    void this.ready.then(
      () => { this.readiness = { state: 'ready' } },
      error => { this.readiness = { state: 'failed', error } },
    )
    this.sources = new StudioSourceResolver(options.root, harmony.profile().dir, options.packageDirs)
  }

  async health(signal: AbortSignal): Promise<StudioPreviewHealth> {
    signal.throwIfAborted()
    if (this.readiness.state === 'starting') return { ready: false }
    if (this.readiness.state === 'failed') {
      return {
        ready: false,
        error: this.readiness.error instanceof Error
          ? this.readiness.error.message
          : String(this.readiness.error),
      }
    }
    return { ready: true }
  }

  async state(signal: AbortSignal): Promise<StudioProjectState> {
    signal.throwIfAborted()
    return (await this.ready).snapshot()
  }

  async activate(graphRev: string, signal: AbortSignal): Promise<StudioProjectState> {
    signal.throwIfAborted()
    return (await this.ready).activate(graphRev)
  }

  async applyBuild(operationId: string, signal: AbortSignal): Promise<StudioProjectState> {
    signal.throwIfAborted()
    const existing = applyBuildOperations.get(operationId)
    if (existing !== undefined) return existing
    const result = this.ready.then(opened => opened.applyBuild()).then(jsonTransport)
    applyBuildOperations.set(operationId, result)
    while (applyBuildOperations.size > PROFILE_UPDATE_OPERATION_LIMIT) {
      const oldest = applyBuildOperations.keys().next().value as string | undefined
      if (oldest === undefined) break
      applyBuildOperations.delete(oldest)
    }
    return result
  }

  async inspect(
    input: { package?: string; file?: string },
    signal: AbortSignal,
  ): Promise<StudioPreviewInspection> {
    signal.throwIfAborted()
    await this.ready
    return jsonTransport({
      harmony: this.harmony.inspect(input),
    })
  }

  async profile(signal: AbortSignal): Promise<StudioHarmonyProfile> {
    signal.throwIfAborted()
    const opened = await this.ready
    return jsonTransport({ ...this.harmony.profile(), runtimePlugins: opened.runtimePlugins() })
  }

  async updateProfile(
    input: {
      operationId: string
      order?: string[]
      patchOrder?: string[]
      disabled?: string[]
    },
    signal: AbortSignal,
  ): Promise<StudioHarmonyProfileUpdateResult> {
    signal.throwIfAborted()
    await this.ready
    const { operationId, ...update } = input
    const serialized = JSON.stringify(update)
    const existing = profileUpdateOperations.get(operationId)
    if (existing !== undefined) {
      if (existing.input !== serialized) throw new Error('Profile update operation input changed')
      return existing.result
    }
    const result = this.harmony.updateProfile(update).then(async result => {
      const opened = await this.ready
      return jsonTransport({
        ...result,
        profile: { ...result.profile, runtimePlugins: opened.runtimePlugins() },
      })
    })
    profileUpdateOperations.set(operationId, { input: serialized, result })
    while (profileUpdateOperations.size > PROFILE_UPDATE_OPERATION_LIMIT) {
      const oldest = profileUpdateOperations.keys().next().value as string | undefined
      if (oldest === undefined) break
      profileUpdateOperations.delete(oldest)
    }
    return result
  }

  async resolveSource(
    source: StudioSourceLocation,
    signal: AbortSignal,
  ): Promise<StudioSourceCandidate> {
    signal.throwIfAborted()
    await this.ready
    return jsonTransport(await this.sources.resolve(source))
  }

  async readSource(packageName: string, file: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    await this.ready
    return this.sources.readDependency(packageName, file)
  }

  async readPatchTarget(
    packageName: string,
    file: string,
    signal: AbortSignal,
  ): Promise<{ package: string; file: string; version: string; source: string }> {
    signal.throwIfAborted()
    await this.ready
    return jsonTransport(await this.sources.readDependencyTarget(packageName, file))
  }

  async close(): Promise<void> {
    await this.ready.then(opened => opened.close(), () => undefined)
  }
}

function loopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '::1' || address === '127.0.0.1' || address?.startsWith('::ffff:127.') === true
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function applyPreviewWorker(
  ctx: Context,
  harmony: StudioHarmonyService,
  options: PreviewWorkerOptions,
): void {
  ctx.effect(() => {
    const worker = new StudioPreviewWorkerService(ctx, harmony, options)
    const disposeContribution = ctx.typert.register(STUDIO_PREVIEW_LOCAL)
    const bridge: WebRoute = {
      kind: 'exact',
      path: `${STUDIO_PATH}/bridge.js`,
      handler(request, response) {
        if (!loopback(request)) return json(response, 403, { error: 'Preview is local only' })
        response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/javascript; charset=utf-8' })
        response.end(request.method === 'HEAD' ? undefined : options.bridge)
      },
    }
    const dispose = [ctx.webServer.register(bridge), ctx.webServer.tapIndex(html => {
      const config = `<script>window.__DSH_STUDIO_PREVIEW__=${JSON.stringify({
        parentOrigin: options.parentOrigin,
        capability: options.bridgeCapability,
      })}</script><script src="${STUDIO_PATH}/bridge.js"></script>`
      const head = html.indexOf('<head>')
      return head === -1 ? `${config}${html}` : `${html.slice(0, head + 6)}${config}${html.slice(head + 6)}`
    })]
    return async () => {
      for (const stop of dispose.reverse()) stop()
      await disposeContribution()
      await worker.close()
    }
  }, 'harmony-studio: Preview worker')
}
