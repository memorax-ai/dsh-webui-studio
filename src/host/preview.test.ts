import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { StudioDraftRecord } from '../contracts.js'
import type { StudioCommandRunner } from './drafts.js'
import { dshPackageModules, StudioPreviewSupervisor } from './preview.js'

const roots: string[] = []
const children: ChildProcess[] = []
const harmonyBinEntry = fileURLToPath(import.meta.resolve('dsh-harmony/bin'))

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('locates the node_modules tree that contains the installed DSH packages', () => {
  expect(existsSync(join(dshPackageModules(harmonyBinEntry), '@deepseek-ai', 'dsh', 'package.json'))).toBe(true)
})

it('keeps the Preview runtime starting until its worker survives initial Harmony setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-preview-readiness-'))
  roots.push(root)
  const mainProfile = join(root, 'main', 'profiles', 'web')
  const draftRoot = join(root, 'draft')
  const fakeHarmonyBin = join(root, 'harmony', 'lib', 'bin.js')
  await Promise.all([
    mkdir(mainProfile, { recursive: true }),
    mkdir(draftRoot),
    mkdir(join(root, 'harmony', 'lib'), { recursive: true }),
  ])
  await writeFile(join(mainProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  await writeFile(join(draftRoot, 'package.json'), JSON.stringify({
    name: 'draft-plugin', packageManager: 'npm@11', scripts: { build: 'echo built' },
  }))
  await writeFile(fakeHarmonyBin, `
    process.stdout.write('dsh web: http://127.0.0.1:65534\\n')
    setInterval(() => {}, 1_000)
  `)
  vi.stubEnv('DSH_HARMONY_DSH_ENTRY', fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js')))
  const draft: StudioDraftRecord = {
    id: 'id', name: 'draft-plugin', label: 'Draft plugin', source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root, worktreeDir: draftRoot, root: draftRoot,
    runtimeHome: join(root, 'runtime-home'), profileMode: 'main-home', createdAt: 'now',
  }
  const preview = new StudioPreviewSupervisor(
    draft,
    mainProfile,
    'http://127.0.0.1:3081',
    { async run() {} },
    fakeHarmonyBin,
    100,
  )

  const start = preview.start().catch(error => error as Error)
  await vi.waitFor(() => expect(preview.snapshot().previewUrl)
    .toMatch(/^http:\/\/127\.0\.0\.1:65534\/#dsh-studio-preview=.+/))
  expect(preview.snapshot().state).toBe('starting')
  await expect(preview.stop()).resolves.toMatchObject({ state: 'stopped' })
  await expect(start).resolves.toMatchObject({ message: 'Preview start canceled' })
})

it('publishes profile installation progress and a failed runtime snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-preview-'))
  roots.push(root)
  const mainProfile = join(root, 'main', 'profiles', 'web')
  const draftRoot = join(root, 'draft')
  await Promise.all([mkdir(mainProfile, { recursive: true }), mkdir(draftRoot)])
  await writeFile(join(mainProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  await writeFile(join(draftRoot, 'package.json'), JSON.stringify({
    name: 'draft-plugin', packageManager: 'npm@11', scripts: { build: 'echo built' },
  }))
  await writeFile(join(mainProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const draft: StudioDraftRecord = {
    id: 'id', name: 'draft-plugin', label: 'Draft plugin', source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root, worktreeDir: draftRoot, root: draftRoot,
    runtimeHome: join(root, 'runtime-home'), profileMode: 'main-home', createdAt: 'now',
  }
  let rejectInstall!: (reason: Error) => void
  let commandStarted!: () => void
  const started = new Promise<void>(resolve => { commandStarted = resolve })
  const install = new Promise<void>((_resolve, reject) => { rejectInstall = reject })
  const commands: StudioCommandRunner = {
    async run(_command, _args, _cwd, onOutput) {
      if (_args.includes('build')) return
      onOutput?.('Resolving packages\n')
      commandStarted()
      await install
    },
  }
  const preview = new StudioPreviewSupervisor(draft, mainProfile, 'http://127.0.0.1:3081', commands, harmonyBinEntry)

  const start = preview.start()
  await started
  const starting = preview.snapshot()
  expect(starting.state).toBe('starting')
  expect(starting.log).toContain(`${join(draft.runtimeHome, 'profiles', 'web')}\n$ `)
  expect(starting.log).toContain(' install --prefer-offline\nResolving packages')
  rejectInstall(new Error('Command exited with code 1\ndependency build rejected'))
  await expect(start).rejects.toThrow('Check the startup terminal')
  expect(preview.snapshot()).toMatchObject({
    state: 'failed',
    error: 'Profile dependency installation failed. Check the startup terminal for details.',
    log: expect.stringContaining('Command exited with code 1'),
  })
})

it('forcefully reaps a Preview Host that ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-preview-stop-'))
  roots.push(root)
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {})
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1_000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await once(child.stdout!, 'data')
  const draft: StudioDraftRecord = {
    id: 'id', name: 'draft-plugin', label: 'Draft plugin', source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root, worktreeDir: root, root,
    runtimeHome: join(root, 'runtime-home'), profileMode: 'main-home', createdAt: 'now',
  }
  const preview = new StudioPreviewSupervisor(
    draft,
    root,
    'http://127.0.0.1:3081',
    { async run() {} },
    harmonyBinEntry,
    500,
  )
  const mutablePreview = preview as unknown as { child: ChildProcess }
  mutablePreview.child = child

  await expect(preview.stop()).resolves.toMatchObject({ state: 'stopped' })
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL')
})

it('cancels and waits for a Preview start that is still installing dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-preview-cancel-'))
  roots.push(root)
  const mainProfile = join(root, 'main', 'profiles', 'web')
  const draftRoot = join(root, 'draft')
  await Promise.all([mkdir(mainProfile, { recursive: true }), mkdir(draftRoot)])
  await writeFile(join(mainProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  await writeFile(join(draftRoot, 'package.json'), JSON.stringify({
    name: 'draft-plugin',
    packageManager: 'npm@11',
    dependencies: { example: '1.0.0' },
  }))
  const draft: StudioDraftRecord = {
    id: 'id', name: 'draft-plugin', label: 'Draft plugin', source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root, worktreeDir: draftRoot, root: draftRoot,
    runtimeHome: join(root, 'runtime-home'), profileMode: 'main-home', createdAt: 'now',
  }
  let commandStarted!: () => void
  const started = new Promise<void>(resolve => { commandStarted = resolve })
  const commands: StudioCommandRunner = {
    async run(_command, _args, _cwd, _onOutput, signal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        commandStarted()
      })
    },
  }
  const preview = new StudioPreviewSupervisor(draft, mainProfile, 'http://127.0.0.1:3081', commands, harmonyBinEntry)

  const start = preview.start().catch(error => error as Error)
  await started
  await expect(preview.stop()).resolves.toMatchObject({ state: 'stopped' })
  await expect(start).resolves.toMatchObject({ message: 'Preview start canceled' })
  expect(preview.snapshot()).toMatchObject({ state: 'stopped' })
})

it('terminates a spawned Preview child before waiting for start to settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-preview-start-stop-'))
  roots.push(root)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
  children.push(child)
  const draft: StudioDraftRecord = {
    id: 'id', name: 'draft-plugin', label: 'Draft plugin', source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root, worktreeDir: root, root,
    runtimeHome: join(root, 'runtime-home'), profileMode: 'main-home', createdAt: 'now',
  }
  const preview = new StudioPreviewSupervisor(draft, root, 'http://127.0.0.1:3081', { async run() {} }, harmonyBinEntry, 100)
  const abort = new AbortController()
  const start = once(child, 'exit').then(() => { throw abort.signal.reason })
  const mutablePreview = preview as unknown as {
    child: ChildProcess
    startAbort: AbortController
    startPromise: Promise<never>
  }
  mutablePreview.child = child
  mutablePreview.startAbort = abort
  mutablePreview.startPromise = start

  await expect(preview.stop()).resolves.toMatchObject({ state: 'stopped' })
  await expect(start).rejects.toThrow('Preview start canceled')
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})
