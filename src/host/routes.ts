import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { STUDIO_PATH } from '../contracts.js'

export interface StudioAssets {
  script: Buffer
  style: Buffer
  bridge: Buffer
  icon: Buffer
  iconMono: Buffer
}

function remoteIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '::1' || address === '127.0.0.1' || address?.startsWith('127.') === true
    || address?.startsWith('::ffff:127.') === true
}

export function isTrustedStudioRequest(request: IncomingMessage): boolean {
  if (!remoteIsLoopback(request)) return false
  const fetchSite = request.headers['sec-fetch-site']
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none'
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function sendAsset(request: IncomingMessage, response: ServerResponse, contentType: string, body: Buffer): void {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-length': body.length,
    'content-type': contentType,
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

function documentHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="referrer" content="no-referrer" />
    <title>DeepSeek WebUI Studio</title>
    <link rel="stylesheet" href="${STUDIO_PATH}/assets/studio.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${STUDIO_PATH}/assets/studio.js"></script>
  </body>
</html>`
}

function harmonySetupHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>DeepSeek WebUI Studio</title>
    <style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden}</style>
  </head>
  <body>
    <iframe src="/" title="Install Harmony for DeepSeek WebUI Studio"></iframe>
    <script>
      const waitForHarmony = async () => {
        try {
          const status = await fetch('/dsh-harmony/runtime').then(response => response.json())
          if (status.state === 'active') return location.reload()
        } catch {}
        setTimeout(waitForHarmony, 750)
      }
      waitForHarmony()
    </script>
  </body>
</html>`
}

function rejectUntrusted(request: IncomingMessage, response: ServerResponse): boolean {
  if (isTrustedStudioRequest(request)) return false
  sendJson(response, 403, { error: 'Studio is available from the local machine only.' })
  return true
}

export function createStudioRoutes(assets: StudioAssets, ready: () => boolean = () => true): WebRoute[] {
  const page = Buffer.from(documentHtml())
  const setupPage = Buffer.from(harmonySetupHtml())
  return [
    {
      kind: 'exact',
      path: STUDIO_PATH,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (new URL(request.url ?? '/', 'http://localhost').pathname !== STUDIO_PATH) {
          return sendJson(response, 404, { error: 'not found' })
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'text/html; charset=utf-8', ready() ? page : setupPage)
      },
    },
    {
      kind: 'exact',
      path: `${STUDIO_PATH}/bridge.js`,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'text/javascript; charset=utf-8', assets.bridge)
      },
    },
    {
      kind: 'exact',
      path: `${STUDIO_PATH}/assets/studio.js`,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'text/javascript; charset=utf-8', assets.script)
      },
    },
    {
      kind: 'exact',
      path: `${STUDIO_PATH}/assets/studio.css`,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'text/css; charset=utf-8', assets.style)
      },
    },
    {
      kind: 'exact',
      path: `${STUDIO_PATH}/assets/harmony-icon.png`,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'image/png', assets.icon)
      },
    },
    {
      kind: 'exact',
      path: `${STUDIO_PATH}/assets/harmony-icon-mono.png`,
      handler(request, response) {
        if (rejectUntrusted(request, response)) return
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' })
        sendAsset(request, response, 'image/png', assets.iconMono)
      },
    },
  ]
}
