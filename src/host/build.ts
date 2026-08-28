import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const BUILD_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT_BYTES = 256 * 1024

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface StudioBuildOutput {
  argv: string[]
  stdout: string
  stderr: string
  truncated: boolean
}

export class StudioBuildError extends Error {
  constructor(
    readonly code: 'studio-build-busy' | 'studio-build-config' | 'studio-build-failed' | 'studio-build-timeout' | 'studio-build-canceled',
    message: string,
    readonly output?: StudioBuildOutput,
  ) {
    super(message)
    this.name = 'StudioBuildError'
  }
}

interface ActiveBuild {
  controller: AbortController
  canceled: boolean
  timedOut: boolean
  handle?: SubprocessHandle
}

export function resolvePackageManager(root: string, manifest: { packageManager?: unknown }): PackageManager {
  if (manifest.packageManager !== undefined) {
    if (typeof manifest.packageManager !== 'string') {
      throw new StudioBuildError('studio-build-config', 'Draft packageManager must be a string')
    }
    const name = manifest.packageManager.split('@', 1)[0]
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
    throw new StudioBuildError('studio-build-config', `Draft packageManager ${JSON.stringify(name)} is not supported`)
  }

  const candidates: Array<{ name: PackageManager; files: string[] }> = [
    { name: 'pnpm', files: ['pnpm-lock.yaml'] },
    { name: 'npm', files: ['package-lock.json'] },
    { name: 'yarn', files: ['yarn.lock'] },
    { name: 'bun', files: ['bun.lock', 'bun.lockb'] },
  ]
  const matches = candidates.filter(candidate => candidate.files.some(file => existsSync(join(root, file))))
  if (matches.length === 0) {
    throw new StudioBuildError('studio-build-config', 'Draft must declare packageManager or contain a supported lockfile')
  }
  if (matches.length > 1) {
    throw new StudioBuildError('studio-build-config', 'Draft contains lockfiles for multiple package managers')
  }
  return matches[0].name
}

export function resolveBuildArgv(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: unknown
    scripts?: { build?: unknown }
  }
  if (typeof manifest.scripts?.build !== 'string' || manifest.scripts.build.trim() === '') {
    throw new StudioBuildError('studio-build-config', 'Draft must define a non-empty scripts.build')
  }
  return [resolvePackageManager(root, manifest), 'run', 'build']
}

function outputOf(handle: SubprocessHandle, argv: string[]): StudioBuildOutput {
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    argv,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: stdout?.lossy === true || stderr?.lossy === true,
  }
}

export class StudioBuildRunner {
  private active?: ActiveBuild

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly timeoutMs = BUILD_TIMEOUT_MS,
  ) {}

  async run(root: string, signal?: AbortSignal): Promise<StudioBuildOutput> {
    if (this.active !== undefined) throw new StudioBuildError('studio-build-busy', 'a Draft build is already running')
    const buildArgv = resolveBuildArgv(root)
    const argv = process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', ...buildArgv]
      : buildArgv
    const active: ActiveBuild = { controller: new AbortController(), canceled: false, timedOut: false }
    this.active = active
    const externalAbort = (): void => {
      active.canceled = true
      active.controller.abort()
    }
    signal?.addEventListener('abort', externalAbort, { once: true })
    if (signal?.aborted === true) externalAbort()
    const timeout = setTimeout(() => {
      active.timedOut = true
      active.controller.abort()
    }, this.timeoutMs)
    try {
      argv[0] = await this.subprocess.resolveExecutable(argv[0], undefined, active.controller.signal)
      active.handle = this.subprocess.spawn({
        argv,
        cwd: root,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
          stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
        },
        graceMs: 2_000,
        signal: active.controller.signal,
      })
      const outcome = await active.handle.done
      const output = outputOf(active.handle, argv)
      if (active.timedOut) throw new StudioBuildError('studio-build-timeout', 'Draft build timed out', output)
      if (active.canceled) throw new StudioBuildError('studio-build-canceled', 'Draft build was canceled', output)
      if (outcome.exitCode !== 0) {
        throw new StudioBuildError(
          'studio-build-failed',
          `Draft build exited with ${outcome.exitCode === null ? outcome.signal ?? 'a signal' : `code ${outcome.exitCode}`}`,
          output,
        )
      }
      return output
    } catch (error) {
      if (error instanceof StudioBuildError) throw error
      if (active.timedOut) throw new StudioBuildError('studio-build-timeout', 'Draft build timed out')
      if (active.canceled) throw new StudioBuildError('studio-build-canceled', 'Draft build was canceled')
      throw new StudioBuildError('studio-build-failed', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', externalAbort)
      if (active.controller.signal.aborted && active.handle !== undefined) await active.handle.waitForExit()
      if (this.active === active) this.active = undefined
    }
  }

  async cancel(): Promise<boolean> {
    const active = this.active
    if (active === undefined) return false
    active.canceled = true
    active.controller.abort()
    if (active.handle !== undefined) await active.handle.waitForExit()
    return true
  }

  async dispose(): Promise<void> {
    await this.cancel()
  }
}
