import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { applyProjectPatch, listProjectFiles, readProjectFile, writeProjectFile } from './project-files.js'

const roots: string[] = []

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-files-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })))
})

test('lists, reads, and atomically updates Draft files', async () => {
  const root = await project()
  expect(await listProjectFiles(root)).toEqual([{ path: 'src/index.ts', size: 23 }])
  expect(await readProjectFile(root, 'src/index.ts')).toBe('export const value = 1\n')

  await writeProjectFile(root, 'src/index.ts', 'export const value = 2\n')
  expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const value = 2\n')
})

test('creates files only below an existing confined parent', async () => {
  const root = await project()
  await writeProjectFile(root, 'src/new.ts', 'new file\n')
  expect(await readProjectFile(root, 'src/new.ts')).toBe('new file\n')
  await expect(writeProjectFile(root, 'missing/new.ts', '')).rejects.toThrow()
  await expect(writeProjectFile(root, '../outside.ts', '')).rejects.toThrow('invalid segment')
  await expect(readProjectFile(root, 'src\\index.ts')).rejects.toThrow('relative project path')
  await expect(readProjectFile(root, 'C:/outside.ts')).rejects.toThrow()
})

test.skipIf(process.platform === 'win32')('rejects symlink escapes and does not traverse symlinks while listing', async () => {
  const root = await project()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-studio-outside-'))
  roots.push(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt'))

  await expect(readProjectFile(root, 'src/escape.txt')).rejects.toThrow('escapes')
  await expect(writeProjectFile(root, 'src/escape.txt', 'changed')).rejects.toThrow('symbolic links')
  expect(await listProjectFiles(root)).not.toContainEqual(expect.objectContaining({ path: 'src/escape.txt' }))
})

test('applies one exact replacement and rejects ambiguous patches', async () => {
  const root = await project()
  await expect(applyProjectPatch(root, 'src/index.ts', 'value = 1', 'value = 2')).resolves.toBe('updated')
  await writeProjectFile(root, 'src/index.ts', 'same same')
  await expect(applyProjectPatch(root, 'src/index.ts', 'same', 'next')).rejects.toThrow('not unique')
})
