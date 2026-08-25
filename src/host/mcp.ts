import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod/v4'
import { STUDIO_PATH } from '../contracts.js'
import type { StudioBackend } from './backend.js'
import { isTrustedStudioRequest } from './routes.js'

export const STUDIO_MCP_PATH = `${STUDIO_PATH}/mcp`

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function createServer(backend: StudioBackend): McpServer {
  const server = new McpServer({ name: 'dsh-webui-studio', version: '0.2.0' })

  server.registerTool('studio_get_context', {
    description: 'Get one bounded read-only context bundle for the current DSH WebUI instance: live selection, Harmony profile, Preview status, and related Harmony targets.',
    annotations: readOnlyAnnotations,
  }, async () => result(await backend.currentContext()))

  server.registerTool('studio_get_selection', {
    description: 'Get the DOM element currently selected in Studio, including its safe React owner summary and source candidate.',
    annotations: readOnlyAnnotations,
  }, async () => result({ selection: backend.currentPreviewStatus().selection ?? null }))

  server.registerTool('studio_get_harmony_profile', {
    description: 'Read the current WebUI Harmony profile, including installed plugins, provider and Patch order, disabled providers, compatibility findings, and revision.',
    annotations: readOnlyAnnotations,
  }, async () => result(await backend.currentHarmonyProfile()))

  server.registerTool('studio_inspect_harmony_target', {
    description: 'Inspect the current Harmony original, ordered Patch steps, and final source for an optional target package and file.',
    inputSchema: {
      package: z.string().min(1).optional().describe('Optional target npm package.'),
      file: z.string().min(1).optional().describe('Optional package-relative target file.'),
    },
    annotations: readOnlyAnnotations,
  }, async input => result(await backend.currentHarmonyInspect(input)))

  server.registerTool('studio_read_dependency_source', {
    description: 'Read one UTF-8 source file from a dependency installed in the current WebUI profile. Use package-relative paths obtained from Studio evidence.',
    inputSchema: {
      package: z.string().min(1).describe('Installed npm package name.'),
      file: z.string().min(1).describe('Package-relative source path.'),
    },
    annotations: readOnlyAnnotations,
  }, async input => result({
    ...input,
    content: await backend.currentReadDependencySource(input),
  }))

  server.registerTool('studio_preview_status', {
    description: 'Read the current DSH WebUI project state and latest Studio Preview connection, graph, mode, and selection status.',
    annotations: readOnlyAnnotations,
  }, async () => result({ project: backend.currentProjectState(), preview: backend.currentPreviewStatus() }))

  return server
}

function sendProtocolError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function handleMcpRequest(backend: StudioBackend, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isTrustedStudioRequest(request)) {
    sendProtocolError(response, 403, 'Studio MCP is available from the local machine only.')
    return
  }
  if (new URL(request.url ?? '/', 'http://localhost').pathname !== STUDIO_MCP_PATH) {
    sendProtocolError(response, 404, 'Not found.')
    return
  }
  if (request.method !== 'POST') {
    sendProtocolError(response, 405, 'Method not allowed.')
    return
  }

  const server = createServer(backend)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  const close = () => { void server.close() }
  response.once('close', close)
  try {
    await server.connect(transport)
    await transport.handleRequest(request, response)
  } catch (error) {
    response.off('close', close)
    await server.close()
    if (!response.headersSent) {
      sendProtocolError(response, 500, error instanceof Error ? error.message : String(error))
    }
  }
}

export function createStudioMcpRoute(backend: StudioBackend): WebRoute {
  return {
    kind: 'exact',
    path: STUDIO_MCP_PATH,
    handler: (request, response) => handleMcpRequest(backend, request, response),
  }
}
