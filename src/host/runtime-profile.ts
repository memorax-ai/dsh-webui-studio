import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { StudioDraftRecord } from '../contracts.js'
import { resolveBuildArgv, resolvePackageManager } from './build.js'
import type { StudioCommandRunner } from './drafts.js'

const PROFILE_FILES = ['cordis.patch.yml', 'cordis.yml', 'harmony.json', 'pnpm-workspace.yaml'] as const
const require = createRequire(import.meta.url)
const PNPM_ENTRY = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
const BINDING_PACKAGE_ROOT = process.env.DSH_STUDIO_BINDING_ROOT ?? dirname(require.resolve('the-binding-of-dsh/package.json'))

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
}

interface DraftManifest {
  name?: unknown
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}

export function bundledPnpmCommand(args: readonly string[]): [string, string[]] {
  return [process.execPath, [PNPM_ENTRY, ...args]]
}

export function packageManagerCommand(manager: string, args: readonly string[]): [string, string[]] {
  if (manager === 'pnpm') return bundledPnpmCommand(args)
  if (process.platform === 'win32') return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', manager, ...args]]
  return [manager, [...args]]
}

function terminalToken(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

export function terminalCommandLine(cwd: string, command: string, args: readonly string[]): string {
  return `${cwd}\n$ ${[command, ...args].map(terminalToken).join(' ')}\n`
}

function hasDependencies(manifest: DraftManifest): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .some(dependencies => dependencies !== undefined && Object.keys(dependencies).length > 0)
}

export async function assertDraftPackageIdentity(draft: StudioDraftRecord): Promise<DraftManifest> {
  const manifest = JSON.parse(await readFile(join(draft.root, 'package.json'), 'utf8')) as DraftManifest
  if (manifest.name !== draft.name) {
    throw new Error(`Draft package.json name must remain ${JSON.stringify(draft.name)}`)
  }
  return manifest
}

export async function installDraftDependencies(
  draft: StudioDraftRecord,
  commands: StudioCommandRunner,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const manifest = await assertDraftPackageIdentity(draft)
  if (!hasDependencies(manifest)) return
  const manager = resolvePackageManager(draft.root, manifest)
  const [command, args] = packageManagerCommand(manager, manager === 'pnpm' ? ['install', '--prefer-offline'] : ['install'])
  onOutput?.(terminalCommandLine(draft.root, command, args))
  try {
    await commands.run(command, args, draft.root, onOutput, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]
    onOutput?.(`[studio] ${message}\n`)
    throw new Error('Draft dependency installation failed. Check the startup terminal for details.')
  }
}

export async function buildDraft(
  draft: StudioDraftRecord,
  commands: StudioCommandRunner,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const [manager, ...args] = resolveBuildArgv(draft.root)
  const [command, commandArgs] = packageManagerCommand(manager, args)
  onOutput?.(terminalCommandLine(draft.root, command, commandArgs))
  try {
    await commands.run(command, commandArgs, draft.root, onOutput, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]
    onOutput?.(`[studio] ${message}\n`)
    throw new Error('Initial Draft build failed. Check the startup terminal for details.')
  }
}

function absoluteLink(spec: string, profileDir: string): string {
  if (!spec.startsWith('link:')) return spec
  const target = spec.slice('link:'.length)
  return `link:${isAbsolute(target) ? target : resolve(profileDir, target)}`
}

export async function materializeDraftProfile(
  draft: StudioDraftRecord,
  mainProfileDir: string,
  studioPackageRoot: string,
  harmonyPackageRoot: string,
  commands: StudioCommandRunner,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  let sourceProfileDir = mainProfileDir
  if (draft.profileMode === 'custom') {
    if (draft.profileDirectory === undefined) throw new Error('Custom Draft profile folder is missing')
    sourceProfileDir = draft.profileDirectory
  }
  const profileDir = join(draft.runtimeHome, 'profiles', 'web')
  await rm(profileDir, { recursive: true, force: true })
  await mkdir(profileDir, { recursive: true })
  const manifest = JSON.parse(await readFile(join(sourceProfileDir, 'package.json'), 'utf8')) as ProfileManifest
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => [name, absoluteLink(spec, sourceProfileDir)]),
  )
  dependencies[draft.name] = `link:${draft.root}`
  dependencies['dsh-webui-studio'] = `link:${studioPackageRoot}`
  dependencies['dsh-harmony'] = `link:${harmonyPackageRoot}`
  dependencies['the-binding-of-dsh'] = `link:${BINDING_PACKAGE_ROOT}`
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`)
  for (const file of PROFILE_FILES) {
    try {
      await cp(join(sourceProfileDir, file), join(profileDir, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const [command, args] = bundledPnpmCommand(['install', '--prefer-offline'])
  onOutput?.(terminalCommandLine(profileDir, command, args))
  try {
    await commands.run(command, args, profileDir, onOutput, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const message = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]
    onOutput?.(`[studio] ${message}\n`)
    throw new Error('Profile dependency installation failed. Check the startup terminal for details.')
  }
  return profileDir
}
