import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NodePeerClient } from 'the-binding-of-dsh'

import type {
  StudioBuildResult,
  StudioDraftView,
  StudioHarmonyInspection,
  StudioHarmonyProfile,
  StudioHarmonyProfileUpdateResult,
  StudioProjectFile,
  StudioProjectState,
  StudioWorkspaceState,
} from '../src/contracts.js'
import { invokeStudioRemote, STUDIO_REMOTE, type StudioRemote } from '../lib/studio-remote.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const studioPath = '/studio'
const dshBin = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'))
const harmonyBin = process.env.DSH_HARMONY_BIN_ENTRY ?? fileURLToPath(import.meta.resolve('dsh-harmony/bin'))
const harmonyPackageSpec = process.env.DSH_HARMONY_PACKAGE_SPEC
const bindingPackageSpec = process.env.DSH_BINDING_PACKAGE_SPEC
const npmCli = process.env.npm_execpath
if (npmCli === undefined) throw new Error('npm_execpath is required to run the Studio integration test')
const root = mkdtempSync(join(tmpdir(), 'dsh-harmony-studio-'))
const home = join(root, 'home')
const draftRoot = join(root, 'draft-plugin')
const draftDependencyRoot = join(root, 'draft-dependency')
mkdirSync(draftRoot)
mkdirSync(draftDependencyRoot)
writeFileSync(join(draftDependencyRoot, 'package.json'), JSON.stringify({
  name: 'studio-build-helper',
  version: '0.0.0',
  type: 'module',
  exports: './index.js',
}))
writeFileSync(join(draftDependencyRoot, 'index.js'), 'export const marker = "installed Draft dependency"\n')
writeFileSync(join(draftRoot, 'package.json'), JSON.stringify({
  name: 'studio-draft',
  version: '0.0.0',
  type: 'module',
  packageManager: 'npm@11.6.2',
  main: './index.js',
  exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
  scripts: { build: 'node build.mjs' },
  dependencies: { 'studio-build-helper': `file:${draftDependencyRoot}` },
  dsh: {
    client: { platform: 'web', immediately: true },
    harmony: { patches: ['./preview.patch.cjs'] },
  },
}))
const draftIndexSource = 'import { marker } from "studio-build-helper"\nexport function apply() { return marker }\n'
writeFileSync(join(draftRoot, 'index.js'), draftIndexSource)
writeFileSync(join(draftRoot, 'preview.patch.cjs'), `
module.exports = {
  id: 'preview-runtime',
  target: { package: 'studio-draft', file: 'index.js' },
  select: 'FunctionDeclaration[name.name="apply"] ReturnStatement',
  expect: 1,
  apply({ node, edit }) { edit.overwrite(node.getStart(), node.getEnd(), 'return "patched Preview"') },
}
`)
writeFileSync(join(draftRoot, 'client.js'), `
window.__ModuleLoader__.load({ id: 'studio-draft', factory: () => ({}) })
`)
writeFileSync(join(draftRoot, 'build.mjs'), `
import { writeFileSync } from 'node:fs'
import { marker } from 'studio-build-helper'
if (marker !== 'installed Draft dependency') throw new Error('Draft dependency was not installed')
writeFileSync(new URL('./client.js', import.meta.url), \`
window.__ModuleLoader__.load({ id: 'studio-draft', factory: () => ({ build: 1 }) })
\`)
console.log('studio draft built')
`)
const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
delete env.npm_config_dry_run
delete env.NPM_CONFIG_DRY_RUN
const add = (packageSpec: string) => spawnSync(process.execPath, [
  dshBin, 'plugin', '--profile', 'web', 'add', packageSpec,
], { cwd: root, env, encoding: 'utf8' })

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

async function waitForPage(url: string, timeoutMs = 15_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function clientGraphBoot(html: string): { index: number; revision?: string } {
  const match = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*\{"rev":"([a-f0-9]+)"/.exec(html)
  return { index: match?.index ?? -1, revision: match?.[1] }
}

let child: ChildProcess | undefined
let peer: NodePeerClient | undefined
let mcp: Client | undefined
try {
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', root], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout || packed.error?.message)
  const tarballs = readdirSync(root).filter((entry) => entry.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `npm pack created unexpected artifacts: ${tarballs.join(', ')}`)
  const studioTarball = join(root, tarballs[0]!)
  let installed = add(studioTarball)
  // Harmony's postinstall is global-only, so explicitly reject it when a fresh pnpm policy asks for approval.
  if (installed.status !== 0 && `${installed.stdout}\n${installed.stderr}`.includes('ERR_PNPM_IGNORED_BUILDS')) {
    const workspacePath = join(home, 'profiles', 'web', 'pnpm-workspace.yaml')
    writeFileSync(workspacePath, readFileSync(workspacePath, 'utf8').replace('dsh-harmony: set this to true or false', 'dsh-harmony: false'))
    installed = add(studioTarball)
  }
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
  const localPackages = [harmonyPackageSpec, bindingPackageSpec].filter((spec): spec is string => spec !== undefined)
  if (localPackages.length > 0) {
    const installedLocalPackages = spawnSync(process.execPath, [npmCli, 'install', '--ignore-scripts', ...localPackages], {
      cwd: join(home, 'profiles', 'web'),
      env,
      encoding: 'utf8',
    })
    assert.equal(installedLocalPackages.status, 0, `${installedLocalPackages.stdout}\n${installedLocalPackages.stderr}`)
    const profileManifestPath = join(home, 'profiles', 'web', 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as { dependencies: Record<string, string> }
    if (harmonyPackageSpec !== undefined) profileManifest.dependencies['dsh-harmony'] = `file:${harmonyPackageSpec}`
    if (bindingPackageSpec !== undefined) profileManifest.dependencies['the-binding-of-dsh'] = `file:${bindingPackageSpec}`
    writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`)
  }

  const dump = spawnSync(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  assert.equal(dump.status, 0, dump.stderr)
  assert.match(dump.stdout, /id: harmony-studio-runtime/)
  assert.match(dump.stdout, /name: dsh-harmony/)
  assert.match(dump.stdout, /^\s*name: dsh-webui-studio$/m)

  const harmonyDump = spawnSync(process.execPath, [harmonyBin, '--profile', 'web', '--dump-config'], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  assert.equal(harmonyDump.status, 0, harmonyDump.stderr)
  assert.match(harmonyDump.stdout, /id: harmony-studio-runtime/)
  assert.match(harmonyDump.stdout, /disabled: true/)

  const setupPort = await availablePort()
  const setupChild = spawn(process.execPath, [dshBin, 'web', '--port', String(setupPort), '--no-open'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = setupChild
  let setupOutput = ''
  setupChild.stdout.on('data', chunk => { setupOutput += chunk.toString() })
  setupChild.stderr.on('data', chunk => { setupOutput += chunk.toString() })
  const setupOrigin = `http://127.0.0.1:${setupPort}`
  const setupPage = await waitForPage(`${setupOrigin}${studioPath}`).catch(error => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${setupOutput}`)
  })
  assert.match(await setupPage.text(), /<iframe src="\/"/)
  assert.match(await fetch(setupOrigin).then(response => response.text()), /"id":"dsh-harmony"/)
  const inactiveRuntime = await fetch(`${setupOrigin}/dsh-harmony/runtime`).then(response => response.json()) as { state?: string }
  assert.equal(inactiveRuntime.state, 'missing')
  setupChild.kill()
  await new Promise<void>(resolve => setupChild.once('exit', () => resolve()))
  child = undefined

  const hostChild = spawn(process.execPath, [harmonyBin, 'web', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = hostChild
  let output = ''
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Studio Host timed out:\n${output}`)), 15_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match === null) return
      clearTimeout(timer)
      resolve(match[1])
    }
    hostChild.stdout.on('data', read)
    hostChild.stderr.on('data', read)
    hostChild.once('exit', (code: number | null) => {
      clearTimeout(timer)
      reject(new Error(`Studio Host exited ${code}:\n${output}`))
    })
  })

  const studioPage = await fetch(`${origin}${studioPath}`)
  assert.equal(studioPage.status, 200)
  const studioHtml = await studioPage.text()
  assert.match(studioHtml, /DeepSeek WebUI Studio/)
  assert.doesNotMatch(studioHtml, /__DSH_STUDIO__/)

  const bridge = await fetch(`${origin}${studioPath}/bridge.js`)
  assert.equal(bridge.status, 200)
  const bridgeScript = await bridge.text()
  assert.match(bridgeScript, /dsh-studio-bridge/)
  assert.doesNotMatch(bridgeScript, /dsh-studio-connect/)
  const studioScript = await fetch(`${origin}${studioPath}/assets/studio.js`)
  assert.equal(studioScript.status, 200)
  assert.doesNotMatch(await studioScript.text(), /process\.env\.NODE_ENV/)
  for (const icon of ['harmony-icon.png', 'harmony-icon-mono.png']) {
    const response = await fetch(`${origin}${studioPath}/assets/${icon}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  }

  mcp = new Client({ name: 'studio-integration', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}${studioPath}/mcp`)))
  const externalTools = await mcp.listTools()
  assert.deepEqual(externalTools.tools.map(tool => tool.name), [
    'studio_get_context',
    'studio_get_selection',
    'studio_get_harmony_profile',
    'studio_inspect_harmony_target',
    'studio_read_dependency_source',
    'studio_preview_status',
  ])
  assert.ok(externalTools.tools.every(tool => tool.annotations?.readOnlyHint === true))
  const externalProfile = await mcp.callTool({ name: 'studio_get_harmony_profile', arguments: {} })
  assert.match(JSON.stringify(externalProfile.content), /dsh-harmony/)

  peer = new NodePeerClient({ baseUrl: origin, contribution: STUDIO_REMOTE })
  await peer.connect()
  const studioRemote = (peer.remote as unknown as { studio: StudioRemote }).studio
  const call = async <T>(method: string, payload: unknown): Promise<T> => {
    const invocation = invokeStudioRemote(studioRemote, method, payload)
    assert.ok(invocation, `Studio method ${method} is not mapped`)
    const result = await invocation
    if (!result.ok) assert.fail(`${JSON.stringify(result)}\n${output}`)
    return result.value as T
  }

  assert.deepEqual(await call<StudioWorkspaceState>('studio.workspace.get', {}), { openDraftIds: [] })

  const destination = join(root, 'saved-new-plugin')
  const stagedNewPlugin = await call<StudioDraftView>('studio.drafts.create', {
    source: { kind: 'new', packageName: 'saved-new-plugin' },
    profileMode: 'main-home',
    destinationDirectory: destination,
  })
  assert.equal(existsSync(destination), false, 'Creating a Draft must not materialize its local destination')
  const exportedNewPlugin = await call<StudioDraftView>('studio.drafts.export', { draftId: stagedNewPlugin.id })
  assert.ok(exportedNewPlugin.exportedAt)
  assert.equal(JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).name, 'saved-new-plugin')

  const created = await call<StudioDraftView>('studio.drafts.create', {
    source: { kind: 'existing', directory: draftRoot },
    profileMode: 'main-home',
  })
  assert.notEqual(created.root, draftRoot)
  assert.equal(created.label, 'draft-plugin')
  assert.ok(created.worktreeDir.includes(join('studio', 'worktrees')))
  assert.deepEqual(await call<StudioWorkspaceState>('studio.workspace.update', {
    openDraftIds: [created.id],
    selectedDraftId: created.id,
  }), { openDraftIds: [created.id], selectedDraftId: created.id })
  assert.deepEqual(await call<StudioWorkspaceState>('studio.workspace.get', {}), {
    openDraftIds: [created.id],
    selectedDraftId: created.id,
  })
  const renamed = await call<StudioDraftView>('studio.drafts.rename', { draftId: created.id, label: 'Toolbar experiment' })
  assert.equal(renamed.label, 'Toolbar experiment')
  assert.equal(renamed.name, 'studio-draft')
  const started = await call<StudioDraftView>('studio.drafts.start', { draftId: created.id })
  const opened = started.project
  assert.ok(opened)
  assert.equal(opened.state, 'preview-pending')
  const draftProfile = await call<StudioHarmonyProfile>('studio.drafts.harmony.profile', { draftId: created.id })
  assert.equal(draftProfile.order[0], 'dsh-harmony')
  assert.ok(draftProfile.order.includes(created.name))
  assert.ok(Array.isArray(draftProfile.patchOrder))
  const draftProfileInspection = await call<StudioHarmonyInspection>('studio.drafts.harmony.inspect', { draftId: created.id })
  assert.ok(draftProfileInspection.patches.every(patch => draftProfile.patchOrder.includes(patch.key)))
  const draftDisabled = [...draftProfile.disabled, `${created.name}/*`]
  const disabledProfile = await call<StudioHarmonyProfileUpdateResult>('studio.drafts.harmony.updateProfile', {
    draftId: created.id,
    order: draftProfile.order,
    patchOrder: draftProfile.patchOrder,
    disabled: draftDisabled,
  })
  assert.equal(disabledProfile.reload.state, 'succeeded')
  assert.deepEqual(disabledProfile.profile.disabled, draftDisabled)
  const restoredProfile = await call<StudioHarmonyProfileUpdateResult>('studio.drafts.harmony.updateProfile', {
    draftId: created.id,
    order: draftProfile.order,
    patchOrder: draftProfile.patchOrder,
    disabled: draftProfile.disabled,
  })
  assert.equal(restoredProfile.reload.state, 'succeeded')
  const { revision: restoredRevision, ...restoredProfileState } = restoredProfile.profile
  const { revision: initialRevision, ...initialProfileState } = draftProfile
  assert.ok(restoredRevision > initialRevision)
  assert.deepEqual(restoredProfileState, initialProfileState)
  const initialInspection = await call<StudioHarmonyInspection>('studio.harmony.inspect', { draftId: created.id })
  assert.equal(initialInspection.patches.find(patch => patch.key === 'studio-draft/preview-runtime')?.state, 'bound')
  const initialPatchedTarget = initialInspection.targets.find(target => target.package === 'studio-draft' && target.file === 'index.js')
  assert.ok(initialPatchedTarget)
  assert.match(initialPatchedTarget.final, /return "patched Preview"/)
  assert.equal(started.runtime.state, 'running')
  assert.ok(started.runtime.log.includes(`${join(created.runtimeHome, 'profiles', 'web')}\n$ `), 'Install command prompt did not include its profile directory')
  assert.ok(started.runtime.log.includes(' install --prefer-offline\n'), 'Install command prompt did not include the executed command')
  assert.ok(started.runtime.log.includes(`${created.worktreeDir}\n$ `), 'Preview command prompt did not include its worktree')
  assert.ok(started.runtime.log.includes(`DSH_HOME=${created.runtimeHome}`), 'Preview command prompt did not include its DSH_HOME')
  assert.match(started.runtime.log, /\bweb --port \d+ --no-open\b/)
  assert.match(started.runtime.log, /dsh web:\s+http:\/\/127\.0\.0\.1:\d+/)
  const previewUrl = started.runtime.previewUrl
  assert.ok(previewUrl)
  const previewOrigin = new URL(previewUrl).origin
  assert.notEqual(previewOrigin, origin)
  const secondCreated = await call<StudioDraftView>('studio.drafts.create', {
    source: { kind: 'existing', directory: draftRoot },
    profileMode: 'custom',
    profileDirectory: join(home, 'profiles', 'web'),
  })
  assert.equal(secondCreated.profileDirectory, realpathSync.native(join(home, 'profiles', 'web')))
  const secondStarted = await call<StudioDraftView>('studio.drafts.start', { draftId: secondCreated.id })
  const secondPreviewUrl = secondStarted.runtime.previewUrl
  assert.ok(secondPreviewUrl)
  assert.notEqual(secondCreated.worktreeDir, created.worktreeDir)
  assert.notEqual(secondCreated.runtimeHome, created.runtimeHome)
  assert.notEqual(new URL(secondPreviewUrl).origin, previewOrigin)
  assert.equal((await fetch(secondPreviewUrl)).status, 200)
  assert.doesNotMatch(await fetch(origin).then(response => response.text()), /"id":"studio-draft"/)
  const preview = await fetch(previewUrl)
  const html = await preview.text()
  const bridgeIndex = html.indexOf(`${studioPath}/bridge.js`)
  const boot = clientGraphBoot(html)
  assert.notEqual(bridgeIndex, -1, 'Preview bridge was not injected into the official WebUI')
  assert.notEqual(boot.index, -1, `official WebUI boot manifest was not found:\n${html.slice(0, 8_000)}`)
  assert.ok(bridgeIndex < boot.index, 'Preview bridge must run before the WebUI boot manifest')
  assert.match(html, /"id":"studio-draft"/)
  const previewGraphRev = boot.revision
  assert.ok(previewGraphRev, 'Preview did not expose its Client graph revision')

  const scoped = { draftId: created.id }
  const files = await call<StudioProjectFile[]>('studio.project.files', scoped)
  assert.ok(files.some(file => file.path === 'index.js'))
  const source = await call<{ content: string }>('studio.project.readFile', { ...scoped, path: 'index.js' })
  assert.equal(source.content, draftIndexSource)
  await call('studio.project.writeFile', { ...scoped, path: 'index.js', content: 'export function apply() { return "studio" }\n' })
  const saved = await call<{ content: string }>('studio.project.readFile', { ...scoped, path: 'index.js' })
  assert.equal(saved.content, 'export function apply() { return "studio" }\n')
  assert.equal(readFileSync(join(draftRoot, 'index.js'), 'utf8'), draftIndexSource)

  const active = await call<StudioProjectState>('studio.project.activate', { ...scoped, graphRev: previewGraphRev })
  assert.equal(active.state, 'active')

  const patchFile = await call<{ content: string }>('studio.project.readFile', { ...scoped, path: 'preview.patch.cjs' })
  assert.match(patchFile.content, /patched Preview/)
  await call('studio.project.writeFile', {
    ...scoped,
    path: 'preview.patch.cjs',
    content: patchFile.content.replace('patched Preview', 'patched Build'),
  })

  const built = await call<StudioBuildResult>('studio.project.build', scoped)
  assert.equal(built.project.state, 'preview-pending')
  assert.match(built.build.stdout, /studio draft built/)
  const rebuiltInspection = await call<StudioHarmonyInspection>('studio.harmony.inspect', scoped)
  assert.equal(rebuiltInspection.patches.find(patch => patch.key === 'studio-draft/preview-runtime')?.state, 'bound')
  const rebuiltPatchedTarget = rebuiltInspection.targets.find(target => target.package === 'studio-draft' && target.file === 'index.js')
  assert.ok(rebuiltPatchedTarget)
  assert.match(rebuiltPatchedTarget.final, /return "patched Build"/)
  assert.doesNotMatch(rebuiltPatchedTarget.final, /patched Preview/)
  const rebuiltPreview = await fetch(previewUrl)
  assert.equal(new URL(rebuiltPreview.url).origin, previewOrigin)
  const rebuiltHtml = await rebuiltPreview.text()
  const rebuiltGraphRev = clientGraphBoot(rebuiltHtml).revision
  assert.ok(rebuiltGraphRev, 'Rebuilt Preview did not expose its Client graph revision')
  const confirmed = await call<StudioProjectState>('studio.project.activate', { ...scoped, graphRev: rebuiltGraphRev })
  assert.equal(confirmed.state, 'active')

  const stopped = await call<StudioDraftView>('studio.drafts.stop', scoped)
  assert.equal(stopped.runtime.state, 'stopped')
  const restarted = await call<StudioDraftView>('studio.drafts.start', scoped)
  assert.equal(restarted.runtime.state, 'running')
  assert.ok(restarted.runtime.previewUrl)
  assert.notEqual(restarted.runtime.bridgeCapability, started.runtime.bridgeCapability)
  const restopped = await call<StudioDraftView>('studio.drafts.stop', scoped)
  assert.equal(restopped.runtime.state, 'stopped')
  const secondStopped = await call<StudioDraftView>('studio.drafts.stop', { draftId: secondCreated.id })
  assert.equal(secondStopped.runtime.state, 'stopped')
  assert.deepEqual(await call<StudioWorkspaceState>('studio.workspace.update', { openDraftIds: [] }), { openDraftIds: [] })
  assert.deepEqual(await call<StudioWorkspaceState>('studio.workspace.get', {}), { openDraftIds: [] })
} finally {
  await mcp?.close()
  await peer?.close()
  const runningChild = child
  if (runningChild?.exitCode === null) {
    runningChild.kill()
    await new Promise<void>(resolve => runningChild.once('exit', () => resolve()))
  }
  rmSync(root, { recursive: true })
}
