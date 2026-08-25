import { describe, expect, it } from 'vitest'
import { isProfilePatchEnabled, isProfilePluginEnabled, moveProfilePatch, moveProfilePlugin, providerRuntimeStatus, setProfilePatchEnabled, setProfilePluginEnabled } from './profile-order.js'

describe('Harmony profile editing', () => {
  it('moves plugins without crossing the Harmony control-plane barriers', () => {
    const order = ['dsh-harmony', 'plugin-a', 'the-binding-of-dsh', 'plugin-b', 'plugin-c']

    expect(moveProfilePlugin(order, 'plugin-c', 0)).toEqual([
      'dsh-harmony', 'plugin-a', 'the-binding-of-dsh', 'plugin-c', 'plugin-b',
    ])
    expect(moveProfilePlugin(order, 'plugin-a', 4)).toEqual(order)
    expect(moveProfilePlugin(order, 'dsh-harmony', 2)).toEqual(order)
    expect(moveProfilePlugin(order, 'the-binding-of-dsh', 4)).toEqual(order)
    expect(order).toEqual(['dsh-harmony', 'plugin-a', 'the-binding-of-dsh', 'plugin-b', 'plugin-c'])
  })

  it('toggles a provider as one unit without changing other disabled patches', () => {
    const disabled = ['plugin-a/first', 'plugin-a/second', '@scope/plugin/only', 'plugin-b/keep']

    const disabledProvider = setProfilePluginEnabled(disabled, 'plugin-a', false)
    expect(disabledProvider).toEqual(['@scope/plugin/only', 'plugin-b/keep', 'plugin-a/*'])
    expect(isProfilePluginEnabled(disabledProvider, 'plugin-a')).toBe(false)
    expect(setProfilePluginEnabled(disabledProvider, 'plugin-a', true)).toEqual([
      '@scope/plugin/only',
      'plugin-b/keep',
    ])
  })

  it('reorders and toggles individual patches, including one patch under a disabled provider', () => {
    expect(moveProfilePatch(['a/one', 'b/two'], 'b/two', 0)).toEqual(['b/two', 'a/one'])
    expect(isProfilePatchEnabled(['a/*'], 'a', 'a/one')).toBe(false)
    expect(setProfilePatchEnabled(['a/*'], 'a', 'a/one', true, ['a/one', 'a/two'])).toEqual(['a/two'])
    expect(setProfilePatchEnabled([], 'a', 'a/one', false, ['a/one', 'a/two'])).toEqual(['a/one'])
  })

  it('summarizes Loader entries separately from the Harmony provider switch', () => {
    const entries = [
      { entryId: 'include:hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: false },
      { entryId: 'runtime:hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true },
      { entryId: 'include:subpath', moduleName: '@deepseek-ai/cordis-plugin-hmr/client', enabled: true },
      { entryId: 'include:timer', moduleName: '@deepseek-ai/cordis-plugin-timer', enabled: true },
    ]

    expect(providerRuntimeStatus(entries, '@deepseek-ai/cordis-plugin-hmr')).toEqual({ enabled: 2, total: 3 })
    expect(providerRuntimeStatus(entries, '@deepseek-ai/cordis-plugin-timer')).toEqual({ enabled: 1, total: 1 })
    expect(providerRuntimeStatus(entries, '@deepseek-ai/dsh-agent')).toEqual({ enabled: 0, total: 0 })
  })
})
