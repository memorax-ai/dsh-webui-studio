import type { StudioRuntimePluginEntry } from '../contracts.js'

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function providerRuntimeStatus(
  entries: readonly StudioRuntimePluginEntry[],
  provider: string,
): { enabled: number; total: number } {
  const matches = entries.filter(entry => entry.moduleName === provider || entry.moduleName.startsWith(`${provider}/`))
  return { enabled: matches.filter(entry => entry.enabled).length, total: matches.length }
}

export function moveProfilePlugin(order: readonly string[], name: string, targetIndex: number): string[] {
  const from = order.indexOf(name)
  const pinned = new Set(['dsh-harmony', 'the-binding-of-dsh'])
  if (from === -1 || pinned.has(name)) return [...order]
  const barriers = order.flatMap((item, index) => pinned.has(item) ? [index] : [])
  const lower = (barriers.filter(index => index < from).at(-1) ?? -1) + 1
  const upper = (barriers.find(index => index > from) ?? order.length) - 1
  const target = Math.max(lower, Math.min(upper, targetIndex))
  if (from === target) return [...order]
  const next = [...order]
  next.splice(from, 1)
  next.splice(target, 0, name)
  return next
}

export function isProfilePluginEnabled(disabled: readonly string[], name: string): boolean {
  return !disabled.includes(`${name}/*`)
}

export function setProfilePluginEnabled(disabled: readonly string[], name: string, enabled: boolean): string[] {
  const prefix = `${name}/`
  const retained = disabled.filter(key => !key.startsWith(prefix))
  return enabled ? retained : [...retained, `${name}/*`]
}

export function moveProfilePatch(order: readonly string[], key: string, targetIndex: number): string[] {
  const from = order.indexOf(key)
  if (from === -1) return [...order]
  const target = Math.max(0, Math.min(order.length - 1, targetIndex))
  if (from === target) return [...order]
  const next = [...order]
  next.splice(from, 1)
  next.splice(target, 0, key)
  return next
}

export function isProfilePatchEnabled(disabled: readonly string[], owner: string, key: string): boolean {
  return !disabled.includes(`${owner}/*`) && !disabled.includes(key)
}

export function setProfilePatchEnabled(
  disabled: readonly string[],
  owner: string,
  key: string,
  enabled: boolean,
  ownerPatchKeys: readonly string[],
): string[] {
  const wildcard = `${owner}/*`
  if (!enabled) return disabled.includes(wildcard) || disabled.includes(key) ? [...disabled] : [...disabled, key]
  if (!disabled.includes(wildcard)) return disabled.filter(item => item !== key)
  const retained = disabled.filter(item => item !== wildcard && !ownerPatchKeys.includes(item))
  return [...retained, ...ownerPatchKeys.filter(item => item !== key)]
}
