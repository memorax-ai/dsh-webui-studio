import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { StudioCreateDraftInput, StudioDraftRecord } from '../contracts.js'

const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024

export interface StudioCommandRunner {
  run(
    command: string,
    args: string[],
    cwd?: string,
    onOutput?: (chunk: string) => void,
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>
}

export const studioCommands: StudioCommandRunner = {
  run(command, args, cwd, onOutput, signal, env) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal })
      let output = ''
      const read = (chunk: Buffer | string): void => {
        const text = chunk.toString()
        output = `${output}${text}`.slice(-COMMAND_OUTPUT_LIMIT)
        onOutput?.(text)
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`Command exited with ${code === null ? signal ?? 'a signal' : `code ${code}`}\n${output.trimEnd()}`))
      })
    })
  },
}

function templateManifest(name: string): string {
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    scripts: { build: 'npm run build:client && npm run build:host', 'build:client': 'tsdown --config-loader unrun', 'build:host': 'tsc -p tsconfig.host.json' },
    dsh: { client: { immediately: true, inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' }, harmony: { patches: [] } },
    dependencies: { 'dsh-harmony-react': '^0.3.0' },
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.7', react: '^18.3.1' },
    devDependencies: {
      '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.7', '@tsdown/css': '0.22.14', '@types/react': '~18.3.1', react: '^18.3.1',
      tsdown: '0.22.14', typescript: '^6.0.3', unrun: '0.3.1',
    },
  }, null, 2)}\n`
}

function templateClient(): string {
  return `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export function apply(_ctx: ClientContext): void {}
`
}

function templateTsdown(name: string): string {
  return `import { defineConfig } from 'tsdown'

const moduleHeader = \`window.__ModuleLoader__.load({
  id: ${JSON.stringify(name)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;\`
const moduleFooter = \`return module.exports;
  },
});\`

export default defineConfig({
  entry: { client: 'src/client.tsx' }, tsconfig: 'tsconfig.client.json', format: 'cjs', platform: 'browser', target: 'es2023',
  deps: { alwaysBundle: ['dsh-harmony-react/studio'], neverBundle: ['react', 'react/jsx-runtime'], onlyBundle: ['dsh-harmony-react'] },
  outDir: 'lib', clean: true, fixedExtension: false, outExtensions: () => ({ js: '.js' }), hash: false, sourcemap: true, dts: false,
  banner: { js: moduleHeader }, footer: { js: moduleFooter },
})
`
}

interface PluginManifest {
  name?: unknown
  exports?: unknown
  scripts?: { build?: unknown }
  dsh?: { client?: { platform?: unknown } }
}

async function pluginManifest(root: string): Promise<PluginManifest & { name: string }> {
  let manifest: PluginManifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PluginManifest
  } catch (error) {
    throw new Error(`Plugin folder must contain a readable package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name)) {
    throw new Error('Plugin package.json must declare a valid npm package name')
  }
  if (manifest.dsh?.client?.platform !== 'web') {
    throw new Error('Plugin package.json must declare dsh.client.platform as "web"')
  }
  if (typeof manifest.exports !== 'object' || manifest.exports === null
    || !Object.hasOwn(manifest.exports, '.') || !Object.hasOwn(manifest.exports, './client')) {
    throw new Error('Plugin package.json exports must include "." and "./client"')
  }
  if (typeof manifest.scripts?.build !== 'string' || manifest.scripts.build.trim() === '') {
    throw new Error('Plugin package.json must declare a non-empty scripts.build')
  }
  return manifest as PluginManifest & { name: string }
}

async function copyPluginDirectory(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`Plugin snapshot does not include symbolic links: ${source}`)
  if (info.isDirectory()) {
    try {
      const targetInfo = await lstat(target)
      if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
        throw new Error(`Plugin destination must contain only regular files and directories: ${target}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(target, { mode: info.mode, recursive: true })
    }
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await copyPluginDirectory(join(source, entry.name), join(target, entry.name))
    }
    return
  }
  if (!info.isFile()) throw new Error(`Plugin snapshot only supports regular files and directories: ${source}`)
  try {
    const targetInfo = await lstat(target)
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error(`Plugin destination must contain only regular files and directories: ${target}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await copyFile(source, target)
  await chmod(target, info.mode)
}

const PRESERVED_EXPORT_ENTRIES = ['.git', 'node_modules'] as const

async function replacePluginDirectory(source: string, target: string, targetExists: boolean): Promise<void> {
  const parent = dirname(target)
  const suffix = randomUUID()
  const staging = join(parent, `.${basename(target)}.${suffix}.dsh-studio.tmp`)
  const backup = join(parent, `.${basename(target)}.${suffix}.dsh-studio.backup`)
  let movedTarget = false
  let committed = false
  try {
    await copyPluginDirectory(source, staging)
    if (targetExists) {
      for (const entry of PRESERVED_EXPORT_ENTRIES) {
        const info = await pathInfo(join(target, entry))
        if (info?.isSymbolicLink()) throw new Error(`Local plugin folder contains an unsafe symbolic link: ${entry}`)
      }
      await rename(target, backup)
      movedTarget = true
      for (const entry of PRESERVED_EXPORT_ENTRIES) {
        if (await pathInfo(join(backup, entry)) !== undefined) {
          await rename(join(backup, entry), join(staging, entry))
        }
      }
    }
    await rename(staging, target)
    committed = true
    if (movedTarget) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (movedTarget && !committed) {
      for (const entry of PRESERVED_EXPORT_ENTRIES) {
        if (await pathInfo(join(staging, entry)) !== undefined) {
          await rename(join(staging, entry), join(backup, entry))
        }
      }
      if (await pathInfo(target) === undefined) await rename(backup, target)
    }
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function pathInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function validateDestinationDirectory(input: unknown, studioRoot: string): Promise<string | undefined> {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || input.trim() === '') throw new Error('Local plugin folder is required')
  const requested = input.trim()
  if (!isAbsolute(requested)) throw new Error('Local plugin folder must be an absolute path')
  const requestedPath = resolve(requested)
  let canonicalParent: string
  try {
    canonicalParent = await realpath(dirname(requestedPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The parent of the local plugin folder must already exist')
    throw error
  }
  const target = join(canonicalParent, basename(requestedPath))
  if (inside(await realpath(studioRoot), target)) throw new Error('Local plugin folder must be outside the Studio data directory')
  const info = await pathInfo(target)
  if (info?.isSymbolicLink() || (info !== undefined && !info.isDirectory())) {
    throw new Error('Local plugin folder must be a directory and cannot be a symbolic link')
  }
  if (info !== undefined && (await readdir(target)).length > 0) {
    throw new Error('Local plugin folder must be new or empty')
  }
  return target
}

async function validateProfileDirectory(mode: StudioCreateDraftInput['profileMode'], input: unknown): Promise<string | undefined> {
  if (mode === 'main-home') {
    if (input !== undefined) throw new Error('Only custom Draft profiles can specify a profile folder')
    return undefined
  }
  if (typeof input !== 'string' || input.trim() === '') throw new Error('Custom profile folder is required')
  if (!isAbsolute(input.trim())) throw new Error('Custom profile folder must be an absolute path')
  try {
    const directory = await realpath(input.trim())
    if (!(await lstat(directory)).isDirectory()) throw new Error('Custom profile path must be a directory')
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error('package.json must contain an object')
    return directory
  } catch (error) {
    throw new Error(`Custom profile folder must contain a readable package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function initializeRepository(root: string, name: string, commands: StudioCommandRunner): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), templateManifest(name))
  await writeFile(join(root, 'src/index.ts'), `export const name = ${JSON.stringify(name)}\nexport function apply(): void {}\n`)
  await writeFile(join(root, 'src/client.tsx'), templateClient())
  await writeFile(join(root, 'tsdown.config.ts'), templateTsdown(name))
  await writeFile(join(root, 'tsconfig.client.json'), `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, types: ['react'] }, include: ['src/client.tsx', 'src/**/*.js'] }, null, 2)}\n`)
  await writeFile(join(root, 'tsconfig.host.json'), `${JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, declaration: true, outDir: 'lib', rootDir: 'src', skipLibCheck: true }, include: ['src/index.ts'] }, null, 2)}\n`)
  await writeFile(join(root, '.gitignore'), 'lib/\nnode_modules/\n')
  await writeFile(join(root, 'README.md'), `# ${name}\n\nCreated by dsh-webui-studio.\n`)
  await commands.run('git', ['init', '--initial-branch=main'], root)
  await commands.run('git', ['config', 'core.autocrlf', 'false'], root)
  await commands.run('git', ['add', '.'], root)
  await commands.run('git', ['-c', 'user.name=dsh-webui-studio', '-c', 'user.email=studio@localhost', 'commit', '-m', 'Initial Draft'], root)
}

function nextNewPluginLabel(records: readonly StudioDraftRecord[]): string {
  const labels = new Set(records.map(record => record.label))
  for (let index = records.filter(record => record.source.kind === 'new').length + 1; ; index += 1) {
    const label = `新插件_${index}`
    if (!labels.has(label)) return label
  }
}

export class StudioDraftRegistry {
  readonly root: string
  readonly recordsDir: string
  readonly repositoriesDir: string
  readonly worktreesDir: string
  readonly runtimesDir: string
  private readonly recordMutations = new Map<string, Promise<void>>()

  constructor(
    dshHome: string,
    private readonly commands: StudioCommandRunner = studioCommands,
  ) {
    this.root = join(dshHome, 'studio')
    this.recordsDir = join(this.root, 'drafts')
    this.repositoriesDir = join(this.root, 'repositories')
    this.worktreesDir = join(this.root, 'worktrees')
    this.runtimesDir = join(this.root, 'runtimes')
  }

  async list(): Promise<StudioDraftRecord[]> {
    await mkdir(this.recordsDir, { recursive: true })
    const files = (await readdir(this.recordsDir)).filter(file => file.endsWith('.json')).sort()
    return Promise.all(files.map(async file => JSON.parse(await readFile(join(this.recordsDir, file), 'utf8')) as StudioDraftRecord))
  }

  async get(id: string): Promise<StudioDraftRecord> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid Draft id')
    return JSON.parse(await readFile(join(this.recordsDir, `${id}.json`), 'utf8')) as StudioDraftRecord
  }

  async create(input: StudioCreateDraftInput): Promise<StudioDraftRecord> {
    const profileDirectory = await validateProfileDirectory(input.profileMode, input.profileDirectory)
    const id = randomUUID()
    const repositoryDir = join(this.repositoriesDir, id)
    const worktreeDir = join(this.worktreesDir, id)
    const runtimeHome = join(this.runtimesDir, id, 'dsh-home')
    await Promise.all([
      mkdir(this.recordsDir, { recursive: true }),
      mkdir(this.repositoriesDir, { recursive: true }),
      mkdir(this.worktreesDir, { recursive: true }),
      mkdir(dirname(runtimeHome), { recursive: true }),
    ])

    try {
      let name: string
      let label: string
      let source: StudioCreateDraftInput['source']
      let destinationDirectory: string | undefined
      if (input.source.kind === 'new') {
        const packageName = input.source.packageName
        if (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName)) throw new Error('New Draft package name is invalid')
        name = packageName
        label = nextNewPluginLabel(await this.list())
        source = { kind: 'new', packageName }
        destinationDirectory = await validateDestinationDirectory(input.destinationDirectory, this.root)
        await mkdir(repositoryDir)
        await initializeRepository(repositoryDir, packageName, this.commands)
        await this.commands.run('git', ['worktree', 'add', '-b', `dsh-studio/${id}`, worktreeDir, 'HEAD'], repositoryDir)
      } else {
        if (input.destinationDirectory !== undefined) throw new Error('Only new plugins can have a local destination folder')
        if (typeof input.source.directory !== 'string' || input.source.directory.trim() === '') {
          throw new Error('Existing plugin folder is required')
        }
        const directory = input.source.directory.trim()
        if (!isAbsolute(directory)) throw new Error('Existing plugin folder must be an absolute path')
        const canonicalSource = await realpath(directory)
        if (!(await lstat(canonicalSource)).isDirectory()) throw new Error('Existing plugin path must be a directory')
        const manifest = await pluginManifest(canonicalSource)
        name = manifest.name
        label = basename(canonicalSource)
        source = { kind: 'existing', directory: canonicalSource }
        await mkdir(repositoryDir)
        await copyPluginDirectory(canonicalSource, repositoryDir)
        await this.commands.run('git', ['init', '--initial-branch=main'], repositoryDir)
        await this.commands.run('git', ['config', 'core.autocrlf', 'false'], repositoryDir)
        await this.commands.run('git', ['add', '.'], repositoryDir)
        await this.commands.run('git', [
          '-c', 'user.name=dsh-webui-studio', '-c', 'user.email=studio@localhost',
          'commit', '-m', 'Import plugin snapshot',
        ], repositoryDir)
        await this.commands.run('git', ['worktree', 'add', '-b', `dsh-studio/${id}`, worktreeDir, 'HEAD'], repositoryDir)
      }

      const canonicalWorktree = await realpath(worktreeDir)
      const root = canonicalWorktree
      const record: StudioDraftRecord = {
        id,
        name,
        label,
        source,
        ...(destinationDirectory === undefined ? {} : { destinationDirectory }),
        repositoryDir: await realpath(repositoryDir),
        worktreeDir: canonicalWorktree,
        root,
        runtimeHome,
        profileMode: input.profileMode,
        ...(profileDirectory === undefined ? {} : { profileDirectory }),
        createdAt: new Date().toISOString(),
      }
      await writeFile(join(this.recordsDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
      return record
    } catch (error) {
      const cleanup = await Promise.allSettled([
        rm(worktreeDir, { recursive: true, force: true }),
        rm(repositoryDir, { recursive: true, force: true }),
        rm(dirname(runtimeHome), { recursive: true, force: true }),
      ])
      const cleanupErrors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'Draft creation failed and cleanup was incomplete')
      throw error
    }
  }

  async rename(id: string, label: string): Promise<StudioDraftRecord> {
    const nextLabel = label.trim()
    if (nextLabel === '' || nextLabel.length > 120) throw new Error('Draft name must contain 1 to 120 characters')
    return this.mutate(id, record => ({ ...record, label: nextLabel }))
  }

  async export(id: string): Promise<StudioDraftRecord> {
    return this.mutate(id, async record => {
      const sourceManifest = JSON.parse(await readFile(join(record.root, 'package.json'), 'utf8')) as { name?: unknown }
      if (sourceManifest.name !== record.name) {
        throw new Error(`Draft package.json name must remain ${JSON.stringify(record.name)}`)
      }
      const target = record.destinationDirectory
      if (target === undefined) throw new Error('This Draft does not have a local plugin folder')
      const info = await pathInfo(target)
      if (record.exportedAt === undefined) {
        if (info?.isSymbolicLink() || (info !== undefined && !info.isDirectory())) {
          throw new Error('Local plugin folder must be a directory and cannot be a symbolic link')
        }
        if (info !== undefined && (await readdir(target)).length > 0) {
          throw new Error('Local plugin folder is no longer empty; choose another folder')
        }
      } else {
        if (info?.isSymbolicLink() || info === undefined || !info.isDirectory()) {
          throw new Error('The saved local plugin folder is missing or is no longer a regular directory')
        }
        const manifest = await pluginManifest(target)
        if (manifest.name !== record.name) throw new Error('The local plugin folder now belongs to a different package')
      }
      await replacePluginDirectory(record.root, target, info !== undefined)
      return { ...record, exportedAt: new Date().toISOString() }
    })
  }

  private async mutate(id: string, update: (record: StudioDraftRecord) => StudioDraftRecord | Promise<StudioDraftRecord>): Promise<StudioDraftRecord> {
    const previous = this.recordMutations.get(id)?.catch(() => undefined) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    const queued = previous.then(() => turn)
    this.recordMutations.set(id, queued)
    await previous
    try {
      const next = await update(await this.get(id))
      await this.replace(next)
      return next
    } finally {
      release()
      if (this.recordMutations.get(id) === queued) this.recordMutations.delete(id)
    }
  }

  private async replace(record: StudioDraftRecord): Promise<void> {
    const file = join(this.recordsDir, `${record.id}.json`)
    const temporary = join(this.recordsDir, `.${record.id}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, file)
  }
}

export function dshHomeFromProfile(profileDir: string): string {
  if (basename(dirname(profileDir)) !== 'profiles') throw new Error('Harmony profile is not under a DSH_HOME/profiles directory')
  return dirname(dirname(profileDir))
}
