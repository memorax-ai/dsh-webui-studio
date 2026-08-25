import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { NodePeerClient } from 'the-binding-of-dsh'
import type {
  StudioDraftRecord,
  StudioHarmonyProfile,
  StudioHarmonyProfileUpdateResult,
  StudioPreviewInspection,
  StudioProjectState,
  StudioSourceCandidate,
  StudioSourceLocation,
} from '../contracts.js'
import type { StudioCommandRunner } from './drafts.js'
import {
  STUDIO_PREVIEW_REMOTE,
  type StudioPreviewWorkerRemote,
} from './preview-worker.js'
import { studioPreviewPortPool, type StudioPreviewPortPool } from './preview-port.js'
import { buildDraft, installDraftDependencies, materializeDraftProfile, terminalCommandLine } from './runtime-profile.js'

const START_TIMEOUT_MS = 60_000
const LOG_LIMIT = 64_000

export interface StudioPreviewRuntime {
  state: 'stopped' | 'starting' | 'running' | 'failed'
  previewUrl?: string
  bridgeCapability?: string
  error?: string
  log: string
}

function appendLog(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-LOG_LIMIT)
}

function studioPackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

function harmonyPackageRoot(harmonyBinEntry: string): string {
  return dirname(dirname(harmonyBinEntry))
}

export function dshPackageModules(harmonyBinEntry: string): string {
  const configured = process.env.DSH_HARMONY_DSH_ENTRY
  const dshEntry = configured === undefined
    ? createRequire(harmonyBinEntry).resolve('@deepseek-ai/dsh/lib/bin.js')
    : resolve(configured)
  let directory = dirname(dshEntry)
  while (dirname(directory) !== directory) {
    if (basename(directory) === 'node_modules') return directory
    directory = dirname(directory)
  }
  throw new Error(`harmony-studio: cannot locate node_modules for ${JSON.stringify(dshEntry)}`)
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const exited = (): void => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.removeListener('exit', exited)
      resolve(false)
    }, timeoutMs)
    child.once('exit', exited)
  })
}

export class StudioPreviewSupervisor {
  private child?: ChildProcess
  private peerClient?: NodePeerClient
  private runtime: StudioPreviewRuntime = { state: 'stopped', log: '' }
  private startAbort?: AbortController
  private startPromise?: Promise<StudioPreviewRuntime>
  private previewPort?: number

  constructor(
    readonly draft: StudioDraftRecord,
    private readonly mainProfileDir: string,
    private readonly parentOrigin: string,
    private readonly commands: StudioCommandRunner,
    private readonly harmonyBinEntry: string,
    private readonly stopTimeoutMs = 5_000,
    private readonly portPool: StudioPreviewPortPool = studioPreviewPortPool,
  ) {}

  snapshot(): StudioPreviewRuntime {
    return { ...this.runtime }
  }

  async start(): Promise<StudioPreviewRuntime> {
    if (this.runtime.state === 'running') return this.snapshot()
    if (this.startPromise !== undefined) return this.startPromise
    const abort = new AbortController()
    const startPromise = this.startRuntime(abort.signal)
    this.startAbort = abort
    this.startPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.startPromise === startPromise) {
        this.startAbort = undefined
        this.startPromise = undefined
      }
    }
  }

  private async startRuntime(signal: AbortSignal): Promise<StudioPreviewRuntime> {
    this.runtime = { state: 'starting', log: '[studio] Preparing Draft dependencies and isolated profile\n' }
    try {
      await installDraftDependencies(
        this.draft,
        this.commands,
        chunk => { this.runtime.log = appendLog(this.runtime.log, chunk) },
        signal,
      )
      await buildDraft(
        this.draft,
        this.commands,
        chunk => { this.runtime.log = appendLog(this.runtime.log, chunk) },
        signal,
      )
      await materializeDraftProfile(
        this.draft,
        this.mainProfileDir,
        studioPackageRoot(),
        harmonyPackageRoot(this.harmonyBinEntry),
        this.commands,
        chunk => { this.runtime.log = appendLog(this.runtime.log, chunk) },
        signal,
      )
      signal.throwIfAborted()
      this.previewPort = this.portPool.claim()
      const hostArgs = [this.harmonyBinEntry, 'web', '--port', String(this.previewPort ?? 0), '--no-open']
      this.runtime.log = appendLog(this.runtime.log,
        `[studio] Profile dependencies ready\n[studio] Starting Preview Host\nDSH_HOME=${this.draft.runtimeHome}\n${terminalCommandLine(this.draft.worktreeDir, process.execPath, hostArgs)}`)
      const bridgeCapability = randomBytes(24).toString('base64url')
      const child = spawn(process.execPath, hostArgs, {
        cwd: this.draft.worktreeDir,
        env: {
          ...process.env,
          DSH_HOME: this.draft.runtimeHome,
          DSH_STUDIO_PREVIEW_DRAFT_ROOT: this.draft.root,
          DSH_STUDIO_PREVIEW_PARENT_ORIGIN: this.parentOrigin,
          DSH_STUDIO_PREVIEW_BRIDGE_CAPABILITY: bridgeCapability,
          DSH_STUDIO_PREVIEW_PACKAGE_DIRS: JSON.stringify([dshPackageModules(this.harmonyBinEntry)]),
          DSH_HARMONY_REACT_TRACE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      child.stdout?.on('data', chunk => {
        this.runtime.log = appendLog(this.runtime.log, chunk)
        const match = this.runtime.log.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)
        if (match?.[1] !== undefined) {
          const { error: _error, ...runtime } = this.runtime
          this.runtime = {
            ...runtime,
            previewUrl: `${match[1]}/#dsh-studio-preview=${encodeURIComponent(bridgeCapability)}`,
            bridgeCapability,
          }
        }
      })
      child.stderr?.on('data', chunk => { this.runtime.log = appendLog(this.runtime.log, chunk) })
      child.once('exit', (code, signal) => {
        if (this.child !== child) return
        this.child = undefined
        const peerClient = this.peerClient
        this.peerClient = undefined
        void peerClient?.close()
        this.releasePreviewPort()
        if (this.runtime.state === 'stopped') return
        const error = `Preview Host exited (${signal ?? code ?? 'unknown'})`
        this.runtime = { state: 'failed', error, log: this.runtime.log }
      })
      await this.waitForPreviewUrl(child, signal)
      const peerClient = new NodePeerClient({
        baseUrl: new URL('/', this.runtime.previewUrl),
        contribution: STUDIO_PREVIEW_REMOTE,
      })
      this.peerClient = peerClient
      await this.waitForWorker(child, signal)
      await this.invoke(this.remote().state(signal))
      this.runtime = { ...this.runtime, state: 'running' }
      return this.snapshot()
    } catch (error) {
      await this.closePeer()
      await this.terminateChild()
      if (signal.aborted) {
        this.runtime = { state: 'stopped', log: this.runtime.log }
        throw signal.reason
      }
      this.runtime = { state: 'failed', error: error instanceof Error ? error.message : String(error), log: this.runtime.log }
      throw error
    }
  }

  async stop(): Promise<StudioPreviewRuntime> {
    this.startAbort?.abort(new Error('Preview start canceled'))
    const start = this.startPromise
    this.runtime = { state: 'stopped', log: this.runtime.log }
    await this.closePeer()
    await this.terminateChild()
    if (start !== undefined) {
      try {
        await start
      } catch {}
    }
    this.runtime = { state: 'stopped', log: this.runtime.log }
    return this.snapshot()
  }

  private async terminateChild(): Promise<void> {
    const child = this.child
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM')
      if (!await waitForExit(child, this.stopTimeoutMs)) {
        child.kill('SIGKILL')
        if (!await waitForExit(child, this.stopTimeoutMs)) {
          const error = 'Preview Host did not exit after SIGTERM and SIGKILL'
          this.runtime = { state: 'failed', error, log: this.runtime.log }
          throw new Error(error)
        }
      }
    }
    if (this.child === child) this.child = undefined
    this.releasePreviewPort()
  }

  private releasePreviewPort(): void {
    this.portPool.release(this.previewPort)
    this.previewPort = undefined
  }

  async state(): Promise<StudioProjectState> {
    return this.invoke(this.remote().state())
  }

  async activate(graphRev: string): Promise<StudioProjectState> {
    return this.invoke(this.remote().activate(graphRev))
  }

  async applyBuild(): Promise<StudioProjectState> {
    await this.commands.run(
      process.execPath,
      [this.harmonyBinEntry, 'harmony', 'reload', this.draft.name],
      this.draft.worktreeDir,
      chunk => { this.runtime.log = appendLog(this.runtime.log, chunk) },
      undefined,
      { ...process.env, DSH_HOME: this.draft.runtimeHome },
    )
    await this.reconnectPeer()
    return this.invoke(this.remote().applyBuild(randomUUID()))
  }

  async inspect(input: { package?: string; file?: string } = {}): Promise<StudioPreviewInspection> {
    return this.invoke(this.remote().inspect(input))
  }

  async profile(): Promise<StudioHarmonyProfile> {
    return this.invoke(this.remote().profile())
  }

  async updateProfile(input: { order?: string[]; patchOrder?: string[]; disabled?: string[] }): Promise<StudioHarmonyProfileUpdateResult> {
    const operation = { ...input, operationId: randomUUID() }
    try {
      return await this.invoke(this.remote().updateProfile(operation))
    } catch (error) {
      if (!this.isGenerationLoss(error)) throw error
    }
    await this.reconnectPeer()
    return this.invoke(this.remote().updateProfile(operation))
  }

  async resolveSource(source: StudioSourceLocation): Promise<StudioSourceCandidate> {
    return this.invoke(this.remote().resolveSource(source))
  }

  async readDependencySource(packageName: string, file: string): Promise<string> {
    return this.invoke(this.remote().readSource(packageName, file))
  }

  async readPatchTarget(packageName: string, file: string): Promise<{
    package: string
    file: string
    version: string
    source: string
  }> {
    return this.invoke(this.remote().readPatchTarget(packageName, file))
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  private async waitForPreviewUrl(child: ChildProcess, signal: AbortSignal): Promise<void> {
    const started = Date.now()
    while (this.child === child && this.runtime.previewUrl === undefined && Date.now() - started < START_TIMEOUT_MS) {
      await this.delay(50, signal)
    }
    signal.throwIfAborted()
    if (this.runtime.previewUrl === undefined) {
      throw new Error(`${this.runtime.error ?? 'Preview Host did not publish its URL before timeout'}\n${this.runtime.log}`)
    }
  }

  private async waitForWorker(child: ChildProcess, signal: AbortSignal): Promise<void> {
    const started = Date.now()
    let lastError = 'Preview worker is still preparing the Draft'
    while (this.child === child && Date.now() - started < START_TIMEOUT_MS) {
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(1_000)])
        await this.peerClient?.connect(requestSignal)
        const health = await this.invoke(this.remote().health(requestSignal))
        if (health.ready) return
        if (health.error !== undefined) throw new Error(health.error)
      } catch (error) {
        signal.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
      }
      await this.delay(50, signal)
    }
    signal.throwIfAborted()
    throw new Error(`Preview worker did not become ready before timeout: ${lastError}`)
  }

  private remote(): StudioPreviewWorkerRemote {
    if (this.peerClient === undefined) throw new Error('Preview Host is not running')
    return (this.peerClient.remote as unknown as { studioPreviewWorker: StudioPreviewWorkerRemote }).studioPreviewWorker
  }

  private async invoke<T>(result: Promise<RemoteResult<T>>): Promise<T> {
    const settled = await result
    if (settled.ok) return settled.value
    throw new Error(`${settled.error.code}: ${settled.error.message}`)
  }

  private async closePeer(): Promise<void> {
    const peerClient = this.peerClient
    this.peerClient = undefined
    await peerClient?.close()
  }

  private isGenerationLoss(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Node peer connection closed')
  }

  private async reconnectPeer(): Promise<void> {
    const peerClient = this.peerClient
    if (peerClient === undefined || this.runtime.state !== 'running') {
      throw new Error('Preview Host is not running')
    }
    const signal = AbortSignal.timeout(START_TIMEOUT_MS)
    let lastError: unknown
    while (!signal.aborted) {
      try {
        await peerClient.connect(signal)
        return
      } catch (error) {
        lastError = error
      }
      await this.delay(50, signal)
    }
    throw new Error('Preview peer did not reconnect after Harmony reload', { cause: lastError })
  }

  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(done, milliseconds)
      const aborted = (): void => done(signal.reason)
      function done(error?: unknown): void {
        clearTimeout(timeout)
        signal.removeEventListener('abort', aborted)
        if (error === undefined) resolve()
        else reject(error)
      }
      signal.addEventListener('abort', aborted, { once: true })
    })
  }
}
