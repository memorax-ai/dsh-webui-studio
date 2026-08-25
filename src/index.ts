import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/cordis-plugin-loader'
import '@deepseek-ai/dsh-client-modules'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-host-apiproxy'
import '@deepseek-ai/dsh-host-webserver'
import '@deepseek-ai/dsh-skill'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-tools'
import 'dsh-harmony'
import { STUDIO_PATH } from './contracts.js'
import { StudioBackend } from './host/backend.js'
import { dshHomeFromProfile, StudioDraftRegistry, studioCommands } from './host/drafts.js'
import { createStudioMcpRoute } from './host/mcp.js'
import { applyPreviewWorker } from './host/preview-worker.js'
import { createStudioRoutes } from './host/routes.js'
import { STUDIO_LOCAL, StudioService } from './host/studio-service.js'
import { StudioWorkspaceStore } from './host/workspace.js'

export const name = 'harmony-studio'
export const inject = ['webServer']

const runtimeInject = ['harmony', 'agents', 'tools', 'skills', 'systemPrompt', 'webServer', 'subprocess', 'loader', 'clientModules', 'typert']

export function apply(ctx: Context): void {
  if (ctx.webServer.host !== '127.0.0.1') {
    ctx.logger.warn('harmony-studio: Studio is disabled because dsh web is not bound to 127.0.0.1')
    return
  }
  const assets = {
    script: readFileSync(new URL('../dist/studio.js', import.meta.url)),
    style: readFileSync(new URL('../dist/studio.css', import.meta.url)),
    bridge: readFileSync(new URL('../dist/bridge.js', import.meta.url)),
    icon: readFileSync(new URL('../assets/harmony-icon.png', import.meta.url)),
    iconMono: readFileSync(new URL('../assets/harmony-icon-mono.png', import.meta.url)),
  }
  const previewRoot = process.env.DSH_STUDIO_PREVIEW_DRAFT_ROOT
  if (previewRoot !== undefined) {
    ctx.inject(runtimeInject, previewCtx => {
      const parentOrigin = process.env.DSH_STUDIO_PREVIEW_PARENT_ORIGIN
      const bridgeCapability = process.env.DSH_STUDIO_PREVIEW_BRIDGE_CAPABILITY
      const packageDirsSource = process.env.DSH_STUDIO_PREVIEW_PACKAGE_DIRS
      if (parentOrigin === undefined || bridgeCapability === undefined || packageDirsSource === undefined) {
        throw new Error('harmony-studio: Preview worker environment is incomplete')
      }
      const packageDirs = JSON.parse(packageDirsSource) as unknown
      if (!Array.isArray(packageDirs) || !packageDirs.every(item => typeof item === 'string')) {
        throw new Error('harmony-studio: Preview package directories are invalid')
      }
      applyPreviewWorker(previewCtx, previewCtx.harmony, {
        root: previewRoot,
        packageDirs,
        parentOrigin,
        bridgeCapability,
        bridge: assets.bridge,
      })
    })
    return
  }

  let runtimeReady = false
  ctx.effect(() => {
    const dispose = createStudioRoutes(assets, () => runtimeReady).map(route => ctx.webServer.register(route))
    return () => {
      for (const stop of dispose.reverse()) stop()
    }
  }, 'harmony-studio: static routes')

  ctx.inject(runtimeInject, runtimeCtx => runtimeCtx.effect(() => {
    const host = `127.0.0.1:${runtimeCtx.webServer.port}`
    const dshHome = dshHomeFromProfile(runtimeCtx.harmony.profile().dir)
    const currentBridgeCapability = randomBytes(24).toString('base64url')
    const backend = new StudioBackend(
      runtimeCtx.harmony,
      runtimeCtx.agents,
      runtimeCtx.subprocess,
      new StudioDraftRegistry(dshHome),
      new StudioWorkspaceStore(dshHome),
      studioCommands,
      `http://${host}`,
      currentBridgeCapability,
    )
    new StudioService(runtimeCtx, backend)
    const dispose = [
      runtimeCtx.typert.register(STUDIO_LOCAL),
      runtimeCtx.webServer.register(createStudioMcpRoute(backend)),
      runtimeCtx.webServer.tapIndex(html => {
        const script = `<script>window.__DSH_STUDIO_PREVIEW__=${JSON.stringify({
          parentOrigin: `http://${host}`,
          capability: currentBridgeCapability,
        })}</script><script src="${STUDIO_PATH}/bridge.js"></script>`
        const head = html.indexOf('<head>')
        return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
      }),
    ]
    runtimeReady = true
    return async () => {
      runtimeReady = false
      for (const stop of dispose.reverse()) stop()
      await backend.dispose()
    }
  }, 'harmony-studio: runtime routes'))
}

export { StudioBackend } from './host/backend.js'
export { StudioBuildError, StudioBuildRunner, resolveBuildArgv } from './host/build.js'
export type { StudioBuildOutput } from './host/build.js'
export { StudioDraftRegistry, dshHomeFromProfile } from './host/drafts.js'
export { inspectReadiness, StudioPackRunner } from './host/readiness.js'
export { createStudioMcpRoute, STUDIO_MCP_PATH } from './host/mcp.js'
export { StudioPreviewSupervisor } from './host/preview.js'
export { createStudioRoutes, isTrustedStudioRequest } from './host/routes.js'
export { StudioWorkspaceStore } from './host/workspace.js'
