import type {
  ModelCatalogModel,
  ModelSelection,
  SessionModels,
  SessionProjectionsBlock,
} from './session-types'

export interface AgentContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface AgentContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export interface AgentProjectionCell {
  seq: number
  value: unknown
}

export type AgentProjectionStore = Record<string, AgentProjectionCell>

export interface AgentContextOccupancy {
  usedTokens: number
  contextWindow: number
  percent: number
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function mergeAgentProjectionBaseline(
  store: AgentProjectionStore,
  block: SessionProjectionsBlock | undefined,
): AgentProjectionStore {
  if (block === undefined) return store
  let next = store
  for (const [key, value] of Object.entries(block.values)) {
    const current = store[key]
    if (current !== undefined && current.seq > block.asOfSeq) continue
    if (next === store) next = { ...store }
    next[key] = { seq: block.asOfSeq, value }
  }
  return next
}

export function mergeAgentProjectionFrame(
  store: AgentProjectionStore,
  key: string,
  value: unknown,
  seq: number,
): AgentProjectionStore {
  const current = store[key]
  if (current !== undefined && current.seq > seq) return store
  return { ...store, [key]: { seq, value } }
}

export function readAgentContextPressure(store: AgentProjectionStore): AgentContextPressure | undefined {
  const value = store.contextPressure?.value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const pressureTokens = finiteNonNegative(record.pressureTokens)
  const projectedTokens = finiteNonNegative(record.projectedTokens)
  const contextWindow = finiteNonNegative(record.contextWindow)
  if (pressureTokens === undefined && projectedTokens === undefined && contextWindow === undefined) return undefined
  return {
    ...(pressureTokens === undefined ? {} : { pressureTokens }),
    ...(projectedTokens === undefined ? {} : { projectedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

export function readAgentContextBreakdown(store: AgentProjectionStore): AgentContextBreakdown | undefined {
  const value = store.contextBreakdown?.value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const systemTokens = finiteNonNegative(record.systemTokens)
  const toolsTokens = finiteNonNegative(record.toolsTokens)
  const messageTokens = finiteNonNegative(record.messageTokens)
  if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) return undefined
  return { systemTokens, toolsTokens, messageTokens }
}

export function agentContextOccupancy(pressure: AgentContextPressure | undefined): AgentContextOccupancy | undefined {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (usedTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return {
    usedTokens,
    contextWindow,
    percent: Math.min(100, Math.max(0, Math.round(usedTokens / contextWindow * 100))),
  }
}

export function agentModelValue(selection: Pick<ModelSelection, 'provider' | 'model'>): string {
  return JSON.stringify([selection.provider, selection.model])
}

export function agentModelSelection(models: SessionModels | undefined, value: string): ModelSelection | undefined {
  let pair: unknown
  try {
    pair = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string')) return undefined
  const [provider, model] = pair as [string, string]
  const entry = models?.groups.find(group => group.id === provider)?.models.find(candidate => candidate.id === model)
  if (entry === undefined) return undefined
  return {
    provider,
    model,
    ...(entry.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: entry.reasoning.defaultEffort }),
  }
}

export function selectedAgentCatalogModel(models: SessionModels | undefined): ModelCatalogModel | undefined {
  if (models === undefined) return undefined
  return models.groups.find(group => group.id === models.current.provider)?.models
    .find(model => model.id === models.current.model)
}
