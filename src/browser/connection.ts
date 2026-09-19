import { BrowserPeerClient } from 'the-binding-of-dsh/browser-peer'
import { STUDIO_REMOTE, type StudioRemote } from '../studio-remote'
import SESSION_REMOTE from '@deepseek-ai/dsh-api-session-controller/remote'

export const studioFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)

export const studioConnection = new BrowserPeerClient({
  contribution: {
    ...STUDIO_REMOTE,
    descriptors: [...STUDIO_REMOTE.descriptors, ...SESSION_REMOTE.descriptors.filter(descriptor => !('mode' in descriptor) || descriptor.mode !== 'stream')],
  },
  fetch: studioFetch,
})

export async function connectStudio(signal?: AbortSignal): Promise<StudioRemote> {
  await studioConnection.connect(signal)
  return (studioConnection.remote as unknown as { studio: StudioRemote }).studio
}
