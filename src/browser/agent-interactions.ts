import {
  RpcId,
  type ApprovalResponsePayload,
  type ClientResponse,
  type HostFrame,
  type MuxFrame,
  type QuestionResponsePayload,
} from './session-types'
import type { StudioServerRequest } from '../contracts'

type ApprovalRequested = Extract<MuxFrame, { type: 'approval/requested' }>
type QuestionRequested = Extract<MuxFrame, { type: 'question/requested' }>

export type AgentPendingInteraction =
  | { kind: 'approval'; rpcId: string; request: ApprovalRequested }
  | { kind: 'question'; rpcId: string; request: QuestionRequested }

export type AgentInteractionStore = Record<string, AgentPendingInteraction[]>
export type AgentQuestionAnswer = QuestionResponsePayload['answer']

function withoutSession(store: AgentInteractionStore, sessionId: string): AgentInteractionStore {
  if (store[sessionId] === undefined) return store
  const next = { ...store }
  delete next[sessionId]
  return next
}

function replaceSession(
  store: AgentInteractionStore,
  sessionId: string,
  interactions: AgentPendingInteraction[],
): AgentInteractionStore {
  return interactions.length === 0 ? withoutSession(store, sessionId) : { ...store, [sessionId]: interactions }
}

export function updateAgentInteractions(
  store: AgentInteractionStore,
  envelope: StudioServerRequest<Record<string, unknown>>,
): AgentInteractionStore {
  const frame = envelope.payload as MuxFrame | HostFrame
  const sessionId = 'sessionId' in frame && typeof frame.sessionId === 'string' ? frame.sessionId : undefined
  if (sessionId === undefined) return store

  if (frame.type === 'session/subscribed' || frame.type === 'host/session-removed') {
    return withoutSession(store, sessionId)
  }
  if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
    const interaction: AgentPendingInteraction = frame.type === 'approval/requested'
      ? { kind: 'approval', rpcId: envelope.rpcId, request: frame }
      : { kind: 'question', rpcId: envelope.rpcId, request: frame }
    const current = store[sessionId] ?? []
    const index = current.findIndex(item => item.rpcId === envelope.rpcId)
    const next = index < 0
      ? [...current, interaction]
      : current.map((item, itemIndex) => itemIndex === index ? interaction : item)
    return { ...store, [sessionId]: next }
  }
  if (frame.type === 'approval/resolved') {
    return replaceSession(store, sessionId, (store[sessionId] ?? []).filter(item => (
      item.kind !== 'approval' || item.request.approvalId !== frame.approvalId
    )))
  }
  if (frame.type === 'question/resolved') {
    return replaceSession(store, sessionId, (store[sessionId] ?? []).filter(item => (
      item.kind !== 'question' || item.rpcId !== frame.questionRpcId
    )))
  }
  return store
}

export function approvalInteractionResponse(
  interaction: Extract<AgentPendingInteraction, { kind: 'approval' }>,
  outcome: ApprovalResponsePayload['outcome'],
): ClientResponse {
  const value: ApprovalResponsePayload = {
    sessionId: interaction.request.sessionId,
    approvalId: interaction.request.approvalId,
    outcome,
  }
  return { type: 'client-response', rpcId: RpcId(interaction.rpcId), result: { ok: true, value } }
}

export function questionInteractionResponse(
  interaction: Extract<AgentPendingInteraction, { kind: 'question' }>,
  answer: AgentQuestionAnswer,
): ClientResponse {
  const value: QuestionResponsePayload = { sessionId: interaction.request.sessionId, answer }
  return { type: 'client-response', rpcId: RpcId(interaction.rpcId), result: { ok: true, value } }
}

export function cancelQuestionInteractionResponse(
  interaction: Extract<AgentPendingInteraction, { kind: 'question' }>,
): ClientResponse {
  return {
    type: 'client-response',
    rpcId: RpcId(interaction.rpcId),
    result: {
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    },
  }
}

export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const match = /^(.*)\s+\(Recommended\)$/.exec(label)
  return match === null ? { label, recommended: false } : { label: match[1]!, recommended: true }
}

export interface AgentPlanReview {
  id: string
  question: string
  plan: string
  approve: { label: string; description?: string }
  decline?: { label: string; description?: string }
}

export function agentPlanReview(
  interaction: Extract<AgentPendingInteraction, { kind: 'question' }>,
): AgentPlanReview | undefined {
  if (interaction.request.questions.length !== 1) return undefined
  const question = interaction.request.questions[0]!
  if (question.intent?.kind !== 'plan-review' || question.detail === undefined || question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find(option => option.label === question.intent?.approve)
  if (approve === undefined) return undefined
  const decline = options.find(option => option.label !== approve.label)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  }
}
