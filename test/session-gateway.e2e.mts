import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserPeerClient } from 'the-binding-of-dsh/browser-peer'
import SESSION_REMOTE from '@deepseek-ai/dsh-api-session-controller/remote'
import { StudioSessionApi } from '../src/browser/session-api.ts'
import { STUDIO_REMOTE } from '../lib/studio-remote.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const binding = dirname(fileURLToPath(import.meta.resolve('the-binding-of-dsh/package.json')))
const require = createRequire(join(binding, 'package.json'))
const WebSocket = require('ws')
const upstream = resolve(process.argv[2])
const harmony = resolve(process.argv[3])
const home = mkdtempSync(join(tmpdir(), 'studio-gateway-'))
const profile = join(home, 'profiles/web')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
for (const [name, path] of [['the-binding-of-dsh', binding], ['dsh-webui-studio', root]]) {
  symlinkSync(path, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
}
writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true,
  dependencies: { 'the-binding-of-dsh': '*', 'dsh-webui-studio': '*' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'the-binding-of-dsh', 'dsh-webui-studio'] } },
}))
const child = spawn(process.execPath, [harmony, 'web', '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_HARMONY_DSH_ENTRY: join(upstream, 'node_modules/@deepseek-ai/dsh/lib/bin.js') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const exited = once(child, 'exit')
let output = '', stop, peer
const timeout = setTimeout(() => child.kill(), 60_000)
try {
  const launch = await new Promise((resolve, reject) => {
    const read = chunk => { output += chunk; const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) resolve(match[1]) }
    child.stdout.on('data', read); child.stderr.on('data', read)
    child.once('exit', () => reject(new Error(output.replace(/token=[^\s]+/g, 'token=REDACTED'))))
  })
  const origin = new URL(launch).origin
  const login = await fetch(launch, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const authenticatedFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie } })
  assert.equal((await authenticatedFetch(origin + '/studio')).status, 200)
  peer = new BrowserPeerClient({ baseUrl: origin, fetch: authenticatedFetch,
    createWebSocket: (url, protocol) => new WebSocket(url, protocol, { headers: { cookie } }),
    contribution: { ...STUDIO_REMOTE, descriptors: [...STUDIO_REMOTE.descriptors, ...SESSION_REMOTE.descriptors.filter(item => item.mode !== 'stream')] },
  })
  const api = new StudioSessionApi(peer)
  const events = []
  stop = api.start(event => events.push(event.payload))
  await peer.connect()
  const profileResponse = await peer.remote.studio.currentGet()
  assert.equal(profileResponse.ok, true, JSON.stringify(profileResponse))
  const created = await peer.remote.session.create({ cwd: home })
  assert.equal(created.ok, true, JSON.stringify(created))
  const sessionId = created.value.sessionId
  api.watchSession(sessionId)
  const wait = async predicate => {
    const deadline = Date.now() + 10_000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert(predicate(), JSON.stringify(events))
  }
  await wait(() => events.some(event => event.type === 'session/snapshot'))
  assert.equal((await api.sessions.list({})).result.ok, true)
  assert.equal((await api.sessions.history({ sessionId })).result.ok, true)
  assert.equal((await api.sessions.models({ sessionId })).result.ok, true)
  assert.equal((await api.sessions.rename({ sessionId, title: 'Gateway compatibility' })).result.ok, true)
  await wait(() => events.some(event => event.type === 'session/event'))
  const event = events.find(event => event.type === 'session/event').event
  assert.equal((await api.sessions.history({ sessionId, beforeSeq: event.seq })).result.ok, true)
  assert(!events.some(event => event.type === 'stream/error'), JSON.stringify(events))
  console.log(JSON.stringify({ upstream, studio: 200, rpc: true, snapshot: true, control: events.some(event => event.type === 'session/projection'), journal: true, history: true, models: true }))
} finally {
  stop?.()
  await peer?.close()
  child.kill()
  await exited
  clearTimeout(timeout)
  rmSync(home, { recursive: true, force: true })
}

