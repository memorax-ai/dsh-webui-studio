import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudioBackend } from './backend.js'
import { createStudioMcpRoute, STUDIO_MCP_PATH } from './mcp.js'

const close: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(close.splice(0).map(dispose => dispose()))
})

describe('Studio MCP', () => {
  it('exposes the current instance inspection tools over Streamable HTTP', async () => {
    const backend = {
      currentContext: vi.fn(async () => ({ target: 'current-instance', readOnly: true })),
      currentPreviewStatus: vi.fn(() => ({ connected: true, mode: 'inspect' })),
      currentProjectState: vi.fn(() => ({ name: 'current-webui', root: '/profile', state: 'active', graphRev: '4' })),
      currentHarmonyProfile: vi.fn(async () => ({ revision: 4, order: ['dsh-harmony'] })),
      currentHarmonyInspect: vi.fn(async input => ({ input, patches: [], targets: [] })),
      currentReadDependencySource: vi.fn(async input => `source:${input.package}/${input.file}`),
    } as unknown as StudioBackend
    const route = createStudioMcpRoute(backend)
    const http = createServer((request, response) => { void route.handler(request, response) })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    close.push(() => new Promise((resolve, reject) => http.close(error => error === undefined ? resolve() : reject(error))))

    const port = (http.address() as AddressInfo).port
    const client = new Client({ name: 'studio-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${STUDIO_MCP_PATH}`)))
    close.push(() => client.close())

    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'studio_get_context',
      'studio_get_selection',
      'studio_get_harmony_profile',
      'studio_inspect_harmony_target',
      'studio_read_dependency_source',
      'studio_preview_status',
    ])
    expect(listed.tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true)

    const context = await client.callTool({ name: 'studio_get_context', arguments: {} })
    const inspection = await client.callTool({
      name: 'studio_inspect_harmony_target',
      arguments: { package: 'client-package', file: 'lib/client.js' },
    })
    expect(context.content).toEqual([{ type: 'text', text: JSON.stringify({ target: 'current-instance', readOnly: true }, null, 2) }])
    expect(inspection.content).toEqual([{ type: 'text', text: expect.stringContaining('client-package') }])
    expect(backend.currentHarmonyInspect).toHaveBeenCalledWith({ package: 'client-package', file: 'lib/client.js' })
  })
})
