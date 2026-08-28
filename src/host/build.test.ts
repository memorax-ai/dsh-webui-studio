import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, test, vi } from 'vitest'
import { resolveBuildArgv, StudioBuildError, StudioBuildRunner } from './build.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

function draft(manifest: Record<string, unknown>, lockfile?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-studio-build-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  if (lockfile !== undefined) writeFileSync(join(root, lockfile), '')
  return root
}

function outputReader(text: string) {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function handle(outcome: Promise<SubprocessOutcome> | SubprocessOutcome): SubprocessHandle {
  return {
    pid: 42,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: outputReader('built\n'), stderr: outputReader('') },
    done: Promise.resolve(outcome),
    terminate() {},
    async waitForExit() { return true },
  }
}

function subprocess(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): SubprocessRuntime {
  return {
    resolveExecutable: vi.fn(async command => isAbsolute(command) ? command : `/bin/${command}`),
    spawn: vi.fn(spawn),
  } as unknown as SubprocessRuntime
}

test('uses the declared package manager and only its fixed build script', () => {
  const root = draft({ packageManager: 'pnpm@10.0.0', scripts: { build: 'anything from the package' } })
  expect(resolveBuildArgv(root)).toEqual(['pnpm', 'run', 'build'])
})

test('detects the package manager from one lockfile', () => {
  const root = draft({ scripts: { build: 'vite build' } }, 'package-lock.json')
  expect(resolveBuildArgv(root)).toEqual(['npm', 'run', 'build'])
})

test('rejects missing build scripts and ambiguous package managers', () => {
  const missing = draft({ packageManager: 'npm@11' })
  expect(() => resolveBuildArgv(missing)).toThrow('scripts.build')

  const ambiguous = draft({ scripts: { build: 'vite build' } }, 'package-lock.json')
  writeFileSync(join(ambiguous, 'yarn.lock'), '')
  expect(() => resolveBuildArgv(ambiguous)).toThrow('multiple package managers')
})

test('runs the fixed build command with collected output', async () => {
  const root = draft({ packageManager: 'npm@11', scripts: { build: 'node build.mjs' } })
  const runtime = subprocess(() => handle({ exitCode: 0, signal: null }))
  const runner = new StudioBuildRunner(runtime)
  const argv = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', 'npm', 'run', 'build']
    : ['/bin/npm', 'run', 'build']

  await expect(runner.run(root)).resolves.toMatchObject({ argv, stdout: 'built\n' })
  expect(runtime.spawn).toHaveBeenCalledWith(expect.objectContaining({
    argv,
    cwd: root,
    signal: expect.any(AbortSignal),
  }))
})

test('reports non-zero exits without applying another command', async () => {
  const root = draft({ packageManager: 'npm@11', scripts: { build: 'node build.mjs' } })
  const runner = new StudioBuildRunner(subprocess(() => handle({ exitCode: 2, signal: null })))

  await expect(runner.run(root)).rejects.toMatchObject<Partial<StudioBuildError>>({
    code: 'studio-build-failed',
    output: expect.objectContaining({ stdout: 'built\n' }),
  })
})

test('cancels the active managed process tree', async () => {
  const root = draft({ packageManager: 'npm@11', scripts: { build: 'node build.mjs' } })
  let finish!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>(resolve => { finish = resolve })
  const active = handle(done)
  active.waitForExit = vi.fn(async () => {
    finish({ exitCode: null, signal: 'SIGTERM' })
    return true
  })
  const runtime = subprocess(() => active)
  const runner = new StudioBuildRunner(runtime)

  const running = runner.run(root)
  await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalled())
  await expect(runner.cancel()).resolves.toBe(true)
  await expect(running).rejects.toMatchObject({ code: 'studio-build-canceled' })
  expect(active.waitForExit).toHaveBeenCalled()
})

test('forwards an external abort into the managed process tree', async () => {
  const root = draft({ packageManager: 'npm@11', scripts: { build: 'node build.mjs' } })
  const runtime = subprocess(spec => {
    let finish!: (outcome: SubprocessOutcome) => void
    const active = handle(new Promise<SubprocessOutcome>(resolve => { finish = resolve }))
    spec.signal?.addEventListener('abort', () => finish({ exitCode: null, signal: 'SIGTERM' }), { once: true })
    return active
  })
  const runner = new StudioBuildRunner(runtime)
  const controller = new AbortController()

  const running = runner.run(root, controller.signal)
  await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalled())
  controller.abort()

  await expect(running).rejects.toMatchObject({ code: 'studio-build-canceled' })
})

test('times out the active managed process', async () => {
  const root = draft({ packageManager: 'npm@11', scripts: { build: 'node build.mjs' } })
  const runtime = subprocess(spec => {
    let finish!: (outcome: SubprocessOutcome) => void
    const active = handle(new Promise<SubprocessOutcome>(resolve => { finish = resolve }))
    spec.signal?.addEventListener('abort', () => finish({ exitCode: null, signal: 'SIGTERM' }), { once: true })
    return active
  })
  const runner = new StudioBuildRunner(runtime, 5)

  await expect(runner.run(root)).rejects.toMatchObject({ code: 'studio-build-timeout' })
})
