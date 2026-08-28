import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { StudioSourceResolver } from './source-resolution.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; draft: string; profile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-source-'))
  roots.push(root)
  const draft = join(root, 'draft')
  const profile = join(root, 'profile')
  await Promise.all([
    mkdir(join(draft, 'src'), { recursive: true }),
    mkdir(join(profile, 'node_modules', 'package-a', 'src'), { recursive: true }),
    mkdir(join(profile, 'node_modules', 'package-b', 'src'), { recursive: true }),
    mkdir(join(profile, 'node_modules', 'package-c', 'lib'), { recursive: true }),
  ])
  await writeFile(join(draft, 'package.json'), JSON.stringify({ name: 'draft-plugin' }))
  await writeFile(join(draft, 'src', 'Button.tsx'), 'export const Button = () => null\n')
  for (const name of ['package-a', 'package-b']) {
    await writeFile(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(join(profile, 'node_modules', name, 'src', 'Button.tsx'), 'export const Button = () => null\n')
  }
  await writeFile(join(profile, 'node_modules', 'package-c', 'package.json'), JSON.stringify({
    name: 'package-c', version: '2.0.0', exports: { './client': { default: './lib/client.js' } },
  }))
  await writeFile(join(profile, 'node_modules', 'package-c', 'lib', 'client.js'), 'export const bundle = true\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'package-a': '1.0.0', 'package-b': '1.0.0' },
  }))
  return { root, draft, profile }
}

test('resolves an exact Draft TSX path', async () => {
  const { draft, profile } = await fixture()
  await expect(new StudioSourceResolver(draft, profile).resolve({
    file: join(draft, 'src', 'Button.tsx'), line: 4, column: 2,
  })).resolves.toEqual({
    package: 'draft-plugin', file: 'src/Button.tsx', line: 4, column: 2, kind: 'draft', confidence: 'exact',
  })
  await expect(new StudioSourceResolver(draft, profile).resolve({
    file: `/@fs${join(draft, 'src', 'Button.tsx')}?t=123#component`,
  })).resolves.toMatchObject({
    package: 'draft-plugin', file: 'src/Button.tsx', kind: 'draft', confidence: 'exact',
  })
})

test('uses a webpack package hint without guessing across identical filenames', async () => {
  const { draft, profile } = await fixture()
  const resolver = new StudioSourceResolver(draft, profile)
  await expect(resolver.resolve({ file: 'webpack://package-a/./src/Button.tsx' })).resolves.toEqual({
    package: 'package-a', file: 'src/Button.tsx', kind: 'dependency', confidence: 'candidate',
  })
  await expect(resolver.resolve({ file: 'webpack:///./src/Button.tsx' })).resolves.toEqual({
    file: 'webpack:///./src/Button.tsx', kind: 'generated', confidence: 'candidate',
  })
})

test('resolves an exact dependency build and degrades without source maps', async () => {
  const { draft, profile } = await fixture()
  const built = join(profile, 'node_modules', 'package-a', 'lib', 'client.js')
  await mkdir(join(profile, 'node_modules', 'package-a', 'lib'))
  await writeFile(built, 'export {}\n')
  const resolver = new StudioSourceResolver(draft, profile)
  await expect(resolver.resolve({ file: built })).resolves.toMatchObject({
    package: 'package-a', file: 'lib/client.js', kind: 'dependency', confidence: 'exact',
  })
  await expect(resolver.resolve({ file: 'http://127.0.0.1:4000/assets/webui.js' })).resolves.toEqual({
    file: 'http://127.0.0.1:4000/assets/webui.js', kind: 'generated', confidence: 'candidate',
  })
})

test('resolves installed transitive packages and reads only installed dependency files', async () => {
  const { root, draft, profile } = await fixture()
  const dshPackages = join(root, 'dsh-node-modules')
  const conversation = join(dshPackages, '@deepseek-ai', 'conversation', 'lib')
  const shadowedProfilePackage = join(dshPackages, 'package-c', 'lib')
  await Promise.all([mkdir(conversation, { recursive: true }), mkdir(shadowedProfilePackage, { recursive: true })])
  await writeFile(join(conversation, '..', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/conversation', version: '3.0.0', exports: { './client': './lib/client.js' },
  }))
  await writeFile(join(conversation, 'client.js'), 'export const Conversation = true\n')
  await writeFile(join(shadowedProfilePackage, '..', 'package.json'), JSON.stringify({
    name: 'package-c', version: '9.0.0', exports: { './client': './lib/client.js' },
  }))
  await writeFile(join(shadowedProfilePackage, 'client.js'), 'export const shadowed = true\n')
  const resolver = new StudioSourceResolver(draft, profile, [dshPackages])
  await expect(resolver.resolve({ file: join(profile, 'node_modules', 'package-c', 'lib', 'client.js') })).resolves.toMatchObject({
    package: 'package-c', file: 'lib/client.js', kind: 'dependency', confidence: 'exact',
  })
  await expect(resolver.resolve({ file: '/plugins/package-c/client.js?rev=1', line: 12, column: 4 })).resolves.toEqual({
    package: 'package-c', file: 'lib/client.js', line: 12, column: 4, kind: 'dependency', confidence: 'exact',
  })
  await expect(resolver.resolve({ file: '/plugins/@deepseek-ai/conversation/client.js', line: 18 })).resolves.toEqual({
    package: '@deepseek-ai/conversation', file: 'lib/client.js', line: 18, kind: 'dependency', confidence: 'exact',
  })
  await expect(resolver.readDependency('package-c', 'lib/client.js')).resolves.toBe('export const bundle = true\n')
  await expect(resolver.readDependencyTarget('package-c', 'lib/client.js')).resolves.toEqual({
    package: 'package-c', file: 'lib/client.js', version: '2.0.0', source: 'export const bundle = true\n',
  })
  await expect(resolver.readDependency('draft-plugin', 'src/Button.tsx')).rejects.toThrow('not uniquely installed')
  await expect(resolver.readDependency('package-a', '../outside.tsx')).rejects.toThrow('invalid')
})

test.skipIf(process.platform === 'win32')('rejects a symlink that escapes an installed package root', async () => {
  const { root, draft, profile } = await fixture()
  const outside = join(root, 'outside.tsx')
  await writeFile(outside, 'secret\n')
  const link = join(profile, 'node_modules', 'package-a', 'src', 'escape.tsx')
  await symlink(outside, link)
  await expect(new StudioSourceResolver(draft, profile).resolve({ file: link })).resolves.toEqual({
    file: link, kind: 'unknown', confidence: 'candidate',
  })
  await expect(new StudioSourceResolver(draft, profile).readDependency('package-a', 'src/escape.tsx'))
    .rejects.toThrow('escapes its installed package root')
})

test('rejects missing, binary, and oversized dependency sources', async () => {
  const { draft, profile } = await fixture()
  const root = join(profile, 'node_modules', 'package-a', 'src')
  await writeFile(join(root, 'binary.dat'), Buffer.from([1, 0, 2]))
  await writeFile(join(root, 'large.ts'), Buffer.alloc(1024 * 1024 + 1, 65))
  const resolver = new StudioSourceResolver(draft, profile)

  await expect(resolver.readDependency('missing-package', 'src/index.ts')).rejects.toThrow('not uniquely installed')
  await expect(resolver.readDependency('package-a', 'src/binary.dat')).rejects.toThrow('binary')
  await expect(resolver.readDependency('package-a', 'src/large.ts')).rejects.toThrow('1 MiB')
})
