import type { SessionModels, SessionProjectionsBlock } from './session-types'
import { describe, expect, it } from 'vitest'
import {
  agentContextOccupancy,
  agentModelSelection,
  agentModelValue,
  mergeAgentProjectionBaseline,
  mergeAgentProjectionFrame,
  readAgentContextBreakdown,
  readAgentContextPressure,
  selectedAgentCatalogModel,
} from './agent-session-controls'

const models: SessionModels = {
  current: { provider: 'deepseek', model: 'chat' },
  routable: true,
  failures: [],
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [{
      id: 'chat',
      name: 'DeepSeek Chat',
      reasoning: {
        defaultEffort: 'medium',
        efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
      },
    }],
  }],
}

describe('Agent native session controls', () => {
  it('keeps the newest projection for each key', () => {
    const latest = mergeAgentProjectionFrame({}, 'contextPressure', { projectedTokens: 200 }, 12)
    const baseline: SessionProjectionsBlock = {
      asOfSeq: 10,
      values: { contextPressure: { projectedTokens: 100, contextWindow: 1_000 } } as never,
    }
    expect(mergeAgentProjectionBaseline(latest, baseline)).toBe(latest)
    expect(mergeAgentProjectionFrame(latest, 'contextPressure', { projectedTokens: 50 }, 11)).toBe(latest)
  })

  it('reads safe context projections and calculates bounded occupancy', () => {
    let store = mergeAgentProjectionFrame({}, 'contextPressure', { pressureTokens: 24_000, projectedTokens: 25_200, contextWindow: 100_000 }, 3)
    store = mergeAgentProjectionFrame(store, 'contextBreakdown', { systemTokens: 100, toolsTokens: 200, messageTokens: 300 }, 3)
    expect(readAgentContextPressure(store)).toEqual({ pressureTokens: 24_000, projectedTokens: 25_200, contextWindow: 100_000 })
    expect(readAgentContextBreakdown(store)).toEqual({ systemTokens: 100, toolsTokens: 200, messageTokens: 300 })
    expect(agentContextOccupancy(readAgentContextPressure(store))).toEqual({
      usedTokens: 25_200,
      contextWindow: 100_000,
      percent: 25,
    })
    expect(agentContextOccupancy({ projectedTokens: 120, contextWindow: 100 })?.percent).toBe(100)
    expect(agentContextOccupancy({ pressureTokens: 12, contextWindow: 100 })?.percent).toBe(12)
  })

  it('selects advertised models with their native default effort', () => {
    const value = agentModelValue({ provider: 'deepseek', model: 'chat' })
    expect(agentModelSelection(models, value)).toEqual({ provider: 'deepseek', model: 'chat', reasoningEffort: 'medium' })
    expect(agentModelSelection(models, 'not-json')).toBeUndefined()
    expect(selectedAgentCatalogModel(models)?.name).toBe('DeepSeek Chat')
  })
})
