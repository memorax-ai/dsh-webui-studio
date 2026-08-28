import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { STUDIO_PATH } from '../contracts.js'
import { createStudioRoutes, isTrustedStudioRequest } from './routes.js'

function request(remoteAddress: string, fetchSite?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite },
  } as IncomingMessage
}

describe('isTrustedStudioRequest', () => {
  it('accepts local same-origin requests', () => {
    expect(isTrustedStudioRequest(request('127.0.0.1', 'same-origin'))).toBe(true)
    expect(isTrustedStudioRequest(request('::1'))).toBe(true)
    expect(isTrustedStudioRequest(request('::ffff:127.0.0.1', 'none'))).toBe(true)
  })

  it('rejects remote and cross-site requests', () => {
    expect(isTrustedStudioRequest(request('192.168.1.8', 'same-origin'))).toBe(false)
    expect(isTrustedStudioRequest(request('127.0.0.1', 'cross-site'))).toBe(false)
  })
})

describe('Studio routes', () => {
  function routes(): WebRoute[] {
    return createStudioRoutes({
      script: Buffer.from('studio-script'), style: Buffer.from('studio-style'), bridge: Buffer.from('studio-bridge'),
      icon: Buffer.from('studio-icon'), iconMono: Buffer.from('studio-icon-mono'),
    })
  }

  async function invoke(route: WebRoute, input: {
    method?: string
    url?: string
    headers?: Record<string, string>
    body?: string
    remoteAddress?: string
  } = {}): Promise<{ status: number; headers: Record<string, string | number>; body: string }> {
    const stream = Readable.from(input.body === undefined ? [] : [input.body])
    const req = Object.assign(stream, {
      method: input.method ?? 'GET',
      url: input.url ?? route.path,
      headers: input.headers ?? {},
      socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
    }) as unknown as IncomingMessage
    const result = { status: 0, headers: {} as Record<string, string | number>, body: '' }
    const res = {
      writeHead(status: number, headers: Record<string, string | number>) {
        result.status = status
        result.headers = headers
        return this
      },
      end(body?: string | Buffer) {
        result.body = body === undefined ? '' : body.toString()
        return this
      },
    } as unknown as ServerResponse
    await route.handler(req, res)
    return result
  }

  it('serves the standalone page and bridge without embedding a custom API credential', async () => {
    const registered = routes()
    expect(registered.some(route => route.path.endsWith('/bridge.js'))).toBe(true)
    expect(registered.some(route => route.path.endsWith('/harmony-icon.png'))).toBe(true)
    expect(registered.some(route => route.path.endsWith('/harmony-icon-mono.png'))).toBe(true)
    expect(registered.some(route => route.path.endsWith('/events.mux'))).toBe(false)

    const page = await invoke(registered.find(route => route.path === STUDIO_PATH)!)
    const bridge = await invoke(registered.find(route => route.path.endsWith('/bridge.js'))!)
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('__DSH_STUDIO__')
    expect(page.body).toContain('<html lang="en">')
    expect(page.body).toContain('<title>DeepSeek WebUI Studio</title>')
    expect(page.body).toContain('<meta name="referrer" content="no-referrer"')
    expect(bridge.body).toBe('studio-bridge')
  })

  it('keeps the Studio URL on the official Harmony installer until the runtime is active', async () => {
    const assets = {
      script: Buffer.from('studio-script'), style: Buffer.from('studio-style'), bridge: Buffer.from('studio-bridge'),
      icon: Buffer.from('studio-icon'), iconMono: Buffer.from('studio-icon-mono'),
    }
    const registered = createStudioRoutes(assets, () => false)
    const page = await invoke(registered.find(route => route.path === STUDIO_PATH)!)

    expect(page.status).toBe(200)
    expect(page.body).toContain('<iframe src="/"')
    expect(page.body).toContain("status.state === 'active'")
    expect(page.body).toContain('location.reload()')
  })
})
