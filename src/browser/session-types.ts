/** Studio-owned presentation types; Gateway envelopes stay inside the transport. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { ModelSelection, ModelCatalog, ModelCatalogModel, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
export type { ModelSelection, ModelCatalogModel, SessionSummary, ToolCallView, ToolResultView }

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: ModelCatalog['groups']
  failures: ModelCatalog['failures']
}
export interface SessionProjectionsBlock { asOfSeq: number; values: Record<string, unknown> }
export interface HistoryEntry {
  event: SessionEvent
  view?: { for: 'call'; view: ToolCallView } | { for: 'result'; view: ToolResultView }
}
export interface RpcResponse<T> { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } } }
export interface ClientResponse extends RpcResponse<unknown> { type: 'client-response'; rpcId: string }
export const RpcId = (value: string): string => value
export interface ApprovalResponsePayload { sessionId: string; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
export interface QuestionResponsePayload { sessionId: string; answer: AskUserQuestionAnswer }
export type MuxFrame =
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: string }
  | { type: 'session/subscribed'; sessionId: string }
export type HostFrame = { type: 'host/session-removed'; sessionId: string }
