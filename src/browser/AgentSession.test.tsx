import type { SessionModels } from './session-types'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentSession } from './AgentSession'
import { translate } from './i18n'

const models: SessionModels = {
  current: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
  routable: true,
  failures: [],
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [{
      id: 'chat',
      name: 'DeepSeek Chat',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    }],
  }],
}

describe('Studio Agent session controls', () => {
  it('renders native model, effort, and context state in the composer', () => {
    const html = renderToStaticMarkup(<AgentSession
      entries={[]}
      streaming={{ reasoning: '', text: '' }}
      queue={[]}
      prompt=""
      sessionActive
      sending={false}
      models={models}
      modelsLoading={false}
      modelSelecting={false}
      contextPressure={{ projectedTokens: 25_000, contextWindow: 100_000 }}
      contextBreakdown={{ systemTokens: 1_000, toolsTokens: 2_000, messageTokens: 3_000 }}
      loadingOlder={false}
      hasOlder={false}
      empty={<div>Empty</div>}
      interaction={undefined}
      t={(key, values) => translate('en', key, values)}
      onPromptChange={() => undefined}
      onSelectModel={() => undefined}
      onSubmit={() => undefined}
      onLoadOlder={() => undefined}
    />)

    expect(html).toContain('aria-label="Model"')
    expect(html).toContain('DeepSeek Chat')
    expect(html).toContain('aria-label="Reasoning effort"')
    expect(html).toContain('aria-label="25% of context used"')
  })

  it('lets a pending interaction take over the composer', () => {
    const html = renderToStaticMarkup(<AgentSession
      entries={[]}
      streaming={{ reasoning: '', text: '' }}
      queue={[]}
      prompt="draft message"
      sessionActive
      sending={false}
      models={models}
      modelsLoading={false}
      modelSelecting={false}
      loadingOlder={false}
      hasOlder={false}
      interaction={<section>Approval required</section>}
      t={(key, values) => translate('en', key, values)}
      onPromptChange={() => undefined}
      onSelectModel={() => undefined}
      onSubmit={() => undefined}
      onLoadOlder={() => undefined}
    />)

    expect(html).toContain('Approval required')
    expect(html).not.toContain('Message Studio Agent')
    expect(html).not.toContain('draft message')
  })
})
