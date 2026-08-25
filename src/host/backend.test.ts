import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioDraftRecord, StudioHarmonyService } from '../contracts.js'
import { StudioBackend } from './backend.js'
import type { StudioCommandRunner, StudioDraftRegistry } from './drafts.js'
import type { StudioWorkspaceStore } from './workspace.js'

const previewState = vi.hoisted(() => ({
  project: { name: 'draft-plugin', root: '', state: 'preview-pending' as const, graphRev: 'graph-1' },
  profile: {
    dir: '/draft/profiles/web',
    order: ['dsh-harmony', 'draft-plugin'],
    patchOrder: ['draft-plugin/one'],
    disabled: [] as string[],
    plugins: [],
    orderViolations: [],
    patchOrderViolations: [],
    compatibility: [],
    runtimePlugins: [],
  },
  updateProfile: vi.fn(),
}))

vi.mock('./preview.js', () => ({
  dshPackageModules: () => '/dsh/node_modules',
  StudioPreviewSupervisor: class {
    runtime = { state: 'stopped', log: '' } as Record<string, string>
    snapshot() { return this.runtime }
    async start() {
      this.runtime = { state: 'running', previewUrl: 'http://127.0.0.1:4000/', bridgeCapability: 'cap', log: '' }
      return this.runtime
    }
    async stop() { this.runtime = { state: 'stopped', log: '' }; return this.runtime }
    async state() { return previewState.project }
    async activate(graphRev: string) { return { ...previewState.project, state: 'active', graphRev } }
    async applyBuild() { return { ...previewState.project, state: 'preview-pending', graphRev: 'graph-2' } }
    async inspect() { return { harmony: { patches: [], targets: [] } } }
    async profile() { return previewState.profile }
    async updateProfile(input: { order?: string[]; patchOrder?: string[]; disabled?: string[] }) {
      previewState.updateProfile(input)
      previewState.profile = { ...previewState.profile, ...input }
      return { mode: 'live', profile: previewState.profile, generation: 2, reload: { state: 'succeeded' } }
    }
    async readPatchTarget(packageName: string, file: string) {
      return { package: packageName, file, version: '1.2.3', source: 'const first = "Original";\nconst second = "Original";\n' }
    }
    async dispose() {}
  },
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function record(root: string): StudioDraftRecord {
  return {
    id: '4f5e9f53-5d56-4cb5-837e-a4c084ab6e9c',
    name: 'draft-plugin',
    label: 'Draft plugin',
    source: { kind: 'new', packageName: 'draft-plugin' },
    repositoryDir: root,
    worktreeDir: root,
    root,
    runtimeHome: join(root, 'runtime'),
    profileMode: 'main-home',
    createdAt: '2026-08-16T00:00:00.000Z',
  }
}

function backend(
  draft: StudioDraftRecord,
  get = vi.fn(async () => draft),
  harmony = { profile: () => ({ dir: '/home/profiles/web' }) } as StudioHarmonyService,
  agentRegistry?: AgentRegistry,
): StudioBackend {
  previewState.project = { name: draft.name, root: draft.root, state: 'preview-pending', graphRev: 'graph-1' }
  const agents = agentRegistry ?? ({ create: vi.fn(async () => ({ dispose: vi.fn(async () => {}) })) } as unknown as AgentRegistry)
  const subprocess = {} as SubprocessRuntime
  const registry = {
    list: vi.fn(async () => [draft]),
    get,
    create: vi.fn(async () => draft),
    rename: vi.fn(async (_id: string, label: string) => ({ ...draft, label: label.trim() })),
    export: vi.fn(async () => ({ ...draft, exportedAt: '2026-08-17T00:00:00.000Z' })),
  } as unknown as StudioDraftRegistry
  const workspace = {
    read: vi.fn(async () => ({ openDraftIds: [] })),
    write: vi.fn(async (state: unknown) => state),
  } as unknown as StudioWorkspaceStore
  const commands = { run: vi.fn() } as unknown as StudioCommandRunner
  return new StudioBackend(harmony, agents, subprocess, registry, workspace, commands, 'http://127.0.0.1:3081')
}

describe('StudioBackend', () => {
  it('tracks the current WebUI as a read-only Preview target without a Draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-current-'))
    temporaryDirectories.push(root)
    const studio = backend(record(root), undefined, {
      profile: () => ({
        revision: 4,
        dir: join(root, 'profile'),
        order: [], patchOrder: [], disabled: [], plugins: [],
        orderViolations: [], patchOrderViolations: [], compatibility: [],
      }),
      inspect: vi.fn(() => ({ patches: [], targets: [] })),
    } as unknown as StudioHarmonyService)

    expect(studio.currentGet()).toMatchObject({
      previewUrl: 'http://127.0.0.1:3081/#dsh-studio-preview=current-instance',
      bridgeCapability: 'current-instance',
    })
    studio.currentPreviewUpdate({ connected: true, mode: 'inspect', graphRev: 'live-4' })
    expect(studio.currentPreviewStatus()).toEqual({ connected: true, mode: 'inspect', graphRev: 'live-4' })
  })

  it('reads and transactionally updates the active Draft Preview Harmony profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    previewState.profile = {
      ...previewState.profile,
      order: ['dsh-harmony', draft.name],
      patchOrder: [`${draft.name}/one`],
      disabled: [],
    }
    previewState.updateProfile.mockClear()
    const studio = backend(draft)

    const current = await studio.harmonyProfile({ draftId: draft.id })
    const updated = await studio.harmonyUpdateProfile({
      draftId: draft.id,
      order: ['dsh-harmony', draft.name],
      patchOrder: [`${draft.name}/one`],
      disabled: [`${draft.name}/*`],
    })

    expect(current).toMatchObject({ dir: '/draft/profiles/web', disabled: [] })
    expect(previewState.updateProfile).toHaveBeenCalledWith({
      order: ['dsh-harmony', draft.name],
      patchOrder: [`${draft.name}/one`],
      disabled: [`${draft.name}/*`],
    })
    expect(updated).toMatchObject({
      profile: { disabled: [`${draft.name}/*`] }, generation: 2,
    })
  })

  it('rejects malformed Draft Preview profile updates before calling the worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    previewState.updateProfile.mockClear()
    const response = backend(draft).harmonyUpdateProfile({
      draftId: draft.id,
      disabled: ['plugin-a/*', 1] as unknown as string[],
    })

    await expect(response).rejects.toThrow('disabled must be an array of non-empty strings')
    expect(previewState.updateProfile).not.toHaveBeenCalled()
  })

  it('lists persistent Drafts and starts one isolated Preview runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const studio = backend(record(root))

    const listed = await studio.draftsList()
    const started = await studio.draftsStart({ draftId: record(root).id })

    expect(listed).toMatchObject([{ runtime: { state: 'stopped' } }])
    expect(started).toMatchObject({
      runtime: { state: 'running', previewUrl: 'http://127.0.0.1:4000/' },
      project: { state: 'preview-pending', graphRev: 'graph-1' },
    })
  })

  it('creates one controller for concurrent first access to a persistent Draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const get = vi.fn(async () => draft)
    const studio = backend(draft, get)

    const responses = await Promise.all([
      studio.draftsStart({ draftId: draft.id }),
      studio.draftsStart({ draftId: draft.id }),
    ])

    expect(responses.every(response => response.runtime.state === 'running')).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('renames the persistent Draft without replacing its package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const studio = backend(draft)

    const renamed = await studio.draftsRename({
      draftId: draft.id,
      label: 'Header experiment',
    })
    const listed = await studio.draftsList()

    expect(renamed).toMatchObject({ name: 'draft-plugin', label: 'Header experiment' })
    expect(listed).toMatchObject([{ name: 'draft-plugin', label: 'Header experiment' }])
  })

  it('reads and updates the persistent workspace without requiring a Draft id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const studio = backend(draft)

    const initial = await studio.workspaceGet()
    const updated = await studio.workspaceUpdate({
      openDraftIds: [draft.id],
      selectedDraftId: draft.id,
    })

    expect(initial).toEqual({ openDraftIds: [] })
    expect(updated).toEqual({ openDraftIds: [draft.id], selectedDraftId: draft.id })
  })

  it('routes activation and Preview selection by Draft id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const studio = backend(draft)
    await studio.draftsStart({ draftId: draft.id })
    const selection = {
      tag: 'button', classes: ['save'], attributes: {}, text: 'Save', outerHTML: '<button>Save</button>',
      rect: { x: 0, y: 0, width: 40, height: 20 }, style: {}, boundaries: [], confidence: 'dom-only',
    }
    const registry = {
      elements: [{
        owner: 'draft-plugin',
        element: {
          id: 'theme', label: 'Theme', boundary: { surfaceId: 'settings', path: ['appearance'] },
          source: { file: 'src/theme.tsx' }, variables: [],
        },
        values: {},
      }],
      variables: [],
    }

    const active = await studio.projectActivate({ draftId: draft.id, graphRev: 'graph-1' })
    await studio.previewUpdate({
      draftId: draft.id, connected: true, mode: 'inspect', selection, registry,
    })
    const connected = await studio.previewStatus({ draftId: draft.id })
    await studio.previewUpdate({
      draftId: draft.id, connected: false, mode: 'browse', selection: null, registry: null,
    })
    const disconnected = await studio.previewStatus({ draftId: draft.id })

    expect(active).toMatchObject({ state: 'active' })
    expect(connected).toMatchObject({ selection, registry })
    expect(disconnected).toEqual({ connected: false, mode: 'browse' })
  })

  it('reads and writes files in the selected Draft worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/index.ts'), 'before\n')
    const draft = record(root)
    const studio = backend(draft)

    const read = await studio.projectReadFile({ draftId: draft.id, path: 'src/index.ts' })
    const saved = await studio.projectWriteFile({ draftId: draft.id, path: 'src/index.ts', content: 'after\n' })

    expect(read).toMatchObject({ content: 'before\n' })
    expect(saved).toMatchObject({ saved: true })
  })

  it('persists every registered Element value through one Draft-level save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/theme.ts'), "const accent = '#235be6';\nexport { accent };\n")
    await writeFile(join(root, 'src/layout.ts'), "const density = 1;\nexport { density };\n")
    const draft = record(root)
    const studio = backend(draft)
    await studio.draftsStart({ draftId: draft.id })
    await studio.previewUpdate({
      draftId: draft.id,
      connected: true,
      mode: 'browse',
      registry: {
        elements: [{
          owner: draft.name,
          element: {
            id: 'theme',
            label: 'Theme',
            boundary: { surfaceId: 'settings', path: ['theme'] },
            source: { file: 'src/theme.ts' },
            variables: [{
              kind: 'variable',
              id: 'accent',
              label: 'Accent',
              control: 'color',
              defaultSource: { file: 'src/theme.ts', before: 'const accent = ', after: ';' },
            }],
          },
          values: { accent: '#ff8800' },
        }, {
          owner: draft.name,
          element: {
            id: 'layout',
            label: 'Layout',
            boundary: { surfaceId: 'settings', path: ['layout'] },
            source: { file: 'src/layout.ts' },
            variables: [{
              kind: 'variable',
              id: 'density',
              label: 'Density',
              control: 'number',
              defaultSource: { file: 'src/layout.ts', before: 'const density = ', after: ';' },
            }],
          },
          values: { density: 2 },
        }],
        variables: [],
      },
    })

    const saved = await studio.elementsSaveSource({ draftId: draft.id, styles: [] })

    expect(saved).toEqual({ files: ['src/theme.ts', 'src/layout.ts'] })
    await expect(readFile(join(root, 'src/theme.ts'), 'utf8')).resolves.toBe(
      "const accent = '#ff8800';\nexport { accent };\n",
    )
    await expect(readFile(join(root, 'src/layout.ts'), 'utf8')).resolves.toBe(
      "const density = 2;\nexport { density };\n",
    )
  })

  it('analyzes multiple automatic Patch matches before explicitly writing the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'draft-plugin', packageManager: 'npm@11', dsh: { client: { platform: 'web' }, harmony: { patches: [] } },
    })}\n`)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/client.tsx'), 'export function apply(): void {}\n')
    const draft = record(root)
    const studio = backend(draft)
    const payload = {
      draftId: draft.id,
      kind: 'replace-string',
      targets: [{ package: 'target-plugin', file: 'lib/client.js' }],
      text: 'Original',
      replacement: 'Changed',
      clientFile: 'src/client.tsx',
      boundary: { surfaceId: 'home', path: ['hero'] },
      selector: '&',
      elementId: 'hero',
      elementLabel: 'Hero',
    }

    const analyzed = await studio.patchesAnalyzeAutomatic(payload)
    expect(analyzed).toMatchObject({
      canApply: true,
      targets: [{ package: 'target-plugin', file: 'lib/client.js', matches: [{ line: 1 }, { line: 2 }] }],
      provider: { patchIds: [expect.any(String)] },
    })
    await expect(readFile(join(root, 'package.json'), 'utf8')).resolves.not.toContain('patch.auto-')

    const created = await studio.patchesCreateAutomatic(payload)
    expect(created).toMatchObject({ files: [
      expect.stringMatching(/^patch\.auto-/), expect.stringMatching(/^src\/client\.dsh-studio-auto-/), 'src/client.tsx', 'package.json',
    ] })
    await expect(readFile(join(root, 'package.json'), 'utf8')).resolves.toContain('patch.auto-')
  })

  it('exports a Draft only through its explicit folder action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = { ...record(root), destinationDirectory: join(root, 'saved-plugin') }
    const studio = backend(draft)

    const exported = await studio.draftsExport({ draftId: draft.id })

    expect(exported).toMatchObject({
      destinationDirectory: draft.destinationDirectory,
      exportedAt: '2026-08-17T00:00:00.000Z',
    })
  })

  it('requires a Draft id for Draft-scoped methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const response = backend(record(root)).projectState({} as { draftId: string })
    await expect(response).rejects.toThrow('draftId is required')
  })

  it('keeps the active Agent session attached to its Draft view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const studio = backend(draft)
    await studio.draftsStart({ draftId: draft.id })
    await studio.projectActivate({ draftId: draft.id, graphRev: 'graph-1' })

    const created = await studio.agentCreate({ draftId: draft.id })
    const listed = await studio.draftsList()

    expect(created).toMatchObject({ sessionId: expect.any(String), source: 'created' })
    expect(listed).toMatchObject([{ agent: created }])
  })

  it('attaches an existing idle session and leaves Studio mode without stopping the Draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-studio-backend-'))
    temporaryDirectories.push(root)
    const draft = record(root)
    const cleanup = vi.fn()
    const agent = {
      status: 'idle',
      session: { header: { agentPreset: 'ordinary' } },
    } as Record<string, unknown>
    const agentCtx = {
      agent,
      inject: vi.fn((_dependencies: string[], callback: (ctx: unknown) => unknown) => {
        const dispose = callback(agentCtx)
        return {
          dispose: vi.fn(async () => { if (typeof dispose === 'function') dispose() }),
          then: (resolve: (value?: unknown) => unknown) => Promise.resolve(resolve()),
        }
      }),
      tools: {
        schemas: vi.fn(() => []),
        restrict: vi.fn(() => cleanup),
        register: vi.fn(() => cleanup),
      },
      systemPrompt: { section: vi.fn(() => cleanup), context: vi.fn(() => cleanup) },
      skills: { register: vi.fn(() => cleanup) },
    }
    agent.ctx = agentCtx
    const agents = {
      get: vi.fn(() => agent),
      resume: vi.fn(),
    } as unknown as AgentRegistry
    const studio = backend(draft, undefined, undefined, agents)
    await studio.draftsStart({ draftId: draft.id })
    await studio.projectActivate({ draftId: draft.id, graphRev: 'graph-1' })

    const attached = await studio.agentAttach({
      draftId: draft.id,
      sessionId: 'c33dc5b3-5bcd-4168-bd6b-c86ad54412b1',
    })
    const left = await studio.agentLeave({ draftId: draft.id })

    expect(attached).toMatchObject({
      sessionId: 'c33dc5b3-5bcd-4168-bd6b-c86ad54412b1', agentPreset: 'ordinary', source: 'existing',
    })
    expect(left).toMatchObject({ runtime: { state: 'running' } })
    expect(left).not.toHaveProperty('agent')
    expect(cleanup).toHaveBeenCalledTimes(12)
    expect(agents.resume).not.toHaveBeenCalled()
  })
})
