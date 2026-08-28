import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StudioDraftRegistry, studioCommands } from './drafts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('StudioDraftRegistry', () => {
  it('streams command output and preserves it when a command fails', async () => {
    const output: string[] = []
    await expect(studioCommands.run(process.execPath, ['-e', `
      process.stdout.write('installing\\n')
      process.stderr.write('dependency rejected\\n')
      process.exit(3)
    `], undefined, chunk => output.push(chunk))).rejects.toThrow(/dependency rejected/)
    expect(output.join('')).toContain('installing\n')
    expect(output.join('')).toContain('dependency rejected\n')
  })

  it('creates and persists a new plugin in a managed Git worktree', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const registry = new StudioDraftRegistry(home)

    const draft = await registry.create({
      source: { kind: 'new', packageName: 'dsh-test-draft' },
      profileMode: 'main-home',
    })

    expect(draft.root).toBe(draft.worktreeDir)
    expect(draft.label).toBe('新插件_1')
    expect(draft.worktreeDir).toContain(join(await realpath(home), 'studio', 'worktrees'))
    expect(JSON.parse(await readFile(join(draft.root, 'package.json'), 'utf8'))).toMatchObject({
      name: 'dsh-test-draft',
      scripts: { 'build:client': 'tsdown --config-loader unrun' },
      dependencies: { 'dsh-harmony-react': '^0.3.0' },
      devDependencies: { '@tsdown/css': '0.22.14', tsdown: '0.22.14' },
      dsh: { client: { platform: 'web', immediately: true } },
    })
    await expect(readFile(join(draft.root, 'src/client.tsx'), 'utf8')).resolves.toContain('export function apply')
    await expect(readFile(join(draft.root, 'tsdown.config.ts'), 'utf8')).resolves.toContain('id: "dsh-test-draft"')
    await expect(registry.list()).resolves.toEqual([draft])
    await expect(registry.get(draft.id)).resolves.toEqual(draft)
  })

  it('defers a new plugin destination until an explicit export', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const destination = join(home, 'saved-plugin')
    const registry = new StudioDraftRegistry(home)

    const draft = await registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: destination,
    })

    expect(draft.destinationDirectory).toBe(join(await realpath(home), 'saved-plugin'))
    expect(draft.exportedAt).toBeUndefined()
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(draft.root, 'README.md'), '# First save\n')
    const exported = await registry.export(draft.id)
    expect(exported.exportedAt).toEqual(expect.any(String))
    expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# First save\n')
    await expect(lstat(join(destination, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(draft.root, 'README.md'), '# Saved again\n')
    await writeFile(join(draft.root, 'obsolete.txt'), 'remove me\n')
    await registry.export(draft.id)
    expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# Saved again\n')
    await mkdir(join(destination, '.git'))
    await mkdir(join(destination, 'node_modules'))
    await writeFile(join(destination, '.git', 'config'), 'preserve git\n')
    await writeFile(join(destination, 'node_modules', 'cache'), 'preserve dependencies\n')
    await rm(join(draft.root, 'obsolete.txt'))
    await registry.export(draft.id)
    await expect(lstat(join(destination, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(destination, '.git', 'config'), 'utf8')).toBe('preserve git\n')
    expect(await readFile(join(destination, 'node_modules', 'cache'), 'utf8')).toBe('preserve dependencies\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the previous export intact when staging the next snapshot fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-studio-export-outside-'))
    roots.push(home, outside)
    const destination = join(home, 'saved-plugin')
    const registry = new StudioDraftRegistry(home)
    const draft = await registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: destination,
    })
    await writeFile(join(draft.root, 'README.md'), '# Stable\n')
    await registry.export(draft.id)
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(draft.root, 'unsafe-link'))

    await expect(registry.export(draft.id)).rejects.toThrow('does not include symbolic links')
    expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# Stable\n')
    await expect(lstat(join(destination, 'unsafe-link'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes rename and export without losing persistent fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const registry = new StudioDraftRegistry(home)
    const draft = await registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: join(home, 'saved-plugin'),
    })

    await Promise.all([registry.export(draft.id), registry.rename(draft.id, 'Renamed Draft')])

    await expect(registry.get(draft.id)).resolves.toMatchObject({
      label: 'Renamed Draft',
      exportedAt: expect.any(String),
    })
  })

  it('rejects exporting a Draft whose package identity was edited', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const registry = new StudioDraftRegistry(home)
    const draft = await registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: join(home, 'saved-plugin'),
    })
    const manifest = JSON.parse(await readFile(join(draft.root, 'package.json'), 'utf8'))
    await writeFile(join(draft.root, 'package.json'), JSON.stringify({ ...manifest, name: 'renamed-plugin' }))

    await expect(registry.export(draft.id)).rejects.toThrow('name must remain "saved-plugin"')
  })

  it('rejects an unsafe destination without modifying it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const destination = join(home, 'existing-plugin')
    roots.push(home)
    await mkdir(destination)
    await writeFile(join(destination, 'keep.txt'), 'keep\n')
    const registry = new StudioDraftRegistry(home)

    await expect(registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: destination,
    })).rejects.toThrow('new or empty')
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep\n')

    await expect(registry.create({
      source: { kind: 'new', packageName: 'saved-plugin' },
      profileMode: 'main-home',
      destinationDirectory: 'relative/plugin',
    })).rejects.toThrow('absolute path')
  })

  it('imports an existing WebUI plugin as an isolated snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const source = await mkdtemp(join(tmpdir(), 'installed-webui-plugin-'))
    roots.push(home, source)
    await mkdir(join(source, 'src'))
    await mkdir(join(source, 'node_modules'))
    await mkdir(join(source, '.git'))
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'installed-webui-plugin',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      scripts: { build: 'tsc' },
      dsh: { client: { platform: 'web' } },
    }))
    await writeFile(join(source, 'src', 'client.ts'), 'export const source = true\n')
    await writeFile(join(source, 'node_modules', 'ignored.txt'), 'ignored\n')
    await writeFile(join(source, '.git', 'ignored.txt'), 'ignored\n')
    const registry = new StudioDraftRegistry(home)

    const draft = await registry.create({
      source: { kind: 'existing', directory: source },
      profileMode: 'main-home',
    })

    expect(draft.name).toBe('installed-webui-plugin')
    expect(draft.label).toBe(basename(source))
    expect(draft.root).not.toBe(source)
    expect(await readFile(join(draft.root, 'src', 'client.ts'), 'utf8')).toBe('export const source = true\n')
    await expect(readFile(join(draft.root, 'node_modules', 'ignored.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(draft.root, '.git', 'ignored.txt'), 'utf8')).rejects.toThrow()
    await writeFile(join(draft.root, 'src', 'client.ts'), 'export const draft = true\n')
    expect(await readFile(join(source, 'src', 'client.ts'), 'utf8')).toBe('export const source = true\n')
  })

  it('rejects folders that are not buildable WebUI plugins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const source = await mkdtemp(join(tmpdir(), 'not-a-webui-plugin-'))
    roots.push(home, source)
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'not-a-webui-plugin' }))
    const registry = new StudioDraftRegistry(home)

    await expect(registry.create({
      source: { kind: 'existing', directory: source },
      profileMode: 'main-home',
    })).rejects.toThrow('dsh.client.platform')
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links instead of importing files outside the plugin folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const source = await mkdtemp(join(tmpdir(), 'webui-plugin-with-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'outside-webui-plugin-'))
    roots.push(home, source, outside)
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'webui-plugin-with-link',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      scripts: { build: 'tsc' },
      dsh: { client: { platform: 'web' } },
    }))
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(source, 'secret.txt'))
    const registry = new StudioDraftRegistry(home)

    await expect(registry.create({
      source: { kind: 'existing', directory: source },
      profileMode: 'main-home',
    })).rejects.toThrow('does not include symbolic links')
  })

  it('persists a renamed Draft and advances generated names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const registry = new StudioDraftRegistry(home)
    const first = await registry.create({ source: { kind: 'new', packageName: 'first-plugin' }, profileMode: 'main-home' })
    const renamed = await registry.rename(first.id, '  Header experiment  ')
    const second = await registry.create({ source: { kind: 'new', packageName: 'second-plugin' }, profileMode: 'main-home' })

    expect(renamed.label).toBe('Header experiment')
    await expect(registry.get(first.id)).resolves.toMatchObject({ label: 'Header experiment' })
    expect(second.label).toBe('新插件_2')
  }, 15_000)

  it('persists the canonical source folder for a custom profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const profile = await mkdtemp(join(tmpdir(), 'dsh-studio-profile-'))
    roots.push(home, profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'custom-web-profile' }))
    const registry = new StudioDraftRegistry(home)

    const draft = await registry.create({
      source: { kind: 'new', packageName: 'dsh-test-draft' },
      profileMode: 'custom',
      profileDirectory: profile,
    })

    expect(draft.profileMode).toBe('custom')
    expect(draft.profileDirectory).toBe(await realpath(profile))
    await expect(registry.get(draft.id)).resolves.toEqual(draft)
  })

  it('rejects an invalid custom profile before creating managed artifacts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    const profile = await mkdtemp(join(tmpdir(), 'dsh-studio-profile-'))
    roots.push(home, profile)
    const registry = new StudioDraftRegistry(home)

    await expect(registry.create({
      source: { kind: 'new', packageName: 'dsh-test-draft' },
      profileMode: 'custom',
      profileDirectory: 'relative/profile',
    })).rejects.toThrow('absolute path')
    await expect(registry.create({
      source: { kind: 'new', packageName: 'dsh-test-draft' },
      profileMode: 'custom',
      profileDirectory: profile,
    })).rejects.toThrow('readable package.json')
    await expect(lstat(join(home, 'studio'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans managed artifacts when Draft creation fails before the record commits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-studio-registry-'))
    roots.push(home)
    const registry = new StudioDraftRegistry(home, {
      async run(_command, args) {
        if (args[0] === 'worktree') throw new Error('worktree creation failed')
      },
    })

    await expect(registry.create({
      source: { kind: 'new', packageName: 'failed-plugin' },
      profileMode: 'main-home',
    })).rejects.toThrow('worktree creation failed')

    expect(await readdir(registry.repositoriesDir)).toEqual([])
    expect(await readdir(registry.worktreesDir)).toEqual([])
    expect(await readdir(registry.runtimesDir)).toEqual([])
    expect(await registry.list()).toEqual([])
  })
})
