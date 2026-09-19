import type { RpcResponse } from './session-types'
import type { StudioServerRequest } from '../contracts'
import { studioConnection } from './connection'
import { StudioRpcError } from './rpc'
import { StudioSessionApi } from './session-api'

export const studioApi = new StudioSessionApi(studioConnection)

export function apiValue<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new StudioRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
  return response.result.value
}

export type StudioEventListener = (event: StudioServerRequest<Record<string, unknown>>) => void
export function subscribeStudioEvents(listener: StudioEventListener, onState?: (connected: boolean) => void): () => void {
  return studioApi.start(listener, onState)
}
