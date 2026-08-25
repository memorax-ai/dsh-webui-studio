import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  StudioDraftView,
  StudioHarmonyInspection,
  StudioHarmonyProfile,
  StudioHarmonyProfileUpdateResult,
} from '../contracts'
import { useStudioLocale } from './i18n'
import { studioErrorMessage } from './error-message'
import {
  isProfilePluginEnabled,
  moveProfilePlugin,
  providerRuntimeStatus,
  sameStringList,
  setProfilePluginEnabled,
} from './profile-order'
import { HarmonyPatchOrder } from './HarmonyPatchOrder'
import { Badge, Button, EmptyState, IconButton, Input, Notice } from './ui'
import { callStudio } from './rpc'

type ManagementView = 'plugins' | 'patches'

function GripIcon({ pinned = false }: { pinned?: boolean }): JSX.Element {
  return pinned ? <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" /></svg>
    : <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="5" cy="4" r="1" /><circle cx="11" cy="4" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="11" cy="8" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" /></svg>
}

function CloseIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8" /></svg>
}

export function PluginManagement({ selectedDraft, view }: {
  selectedDraft: StudioDraftView
  view?: ManagementView
}): JSX.Element {
  const { t } = useStudioLocale()
  const patchDialogRef = useRef<HTMLDialogElement>(null)
  const loadRequest = useRef(0)
  const [profile, setProfile] = useState<StudioHarmonyProfile>()
  const [inspection, setInspection] = useState<StudioHarmonyInspection>({ patches: [], targets: [] })
  const [order, setOrder] = useState<string[]>([])
  const [patchOrder, setPatchOrder] = useState<string[]>([])
  const [disabled, setDisabled] = useState<string[]>([])
  const [pluginQuery, setPluginQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState<{ kind: 'plugin'; key: string }>()
  const [selectedProvider, setSelectedProvider] = useState<string>()
  const [patchDialogOpen, setPatchDialogOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [appliedGeneration, setAppliedGeneration] = useState<number>()
  const running = selectedDraft.runtime.state === 'running'
  const plugins = useMemo(() => new Map(profile?.plugins.map(plugin => [plugin.name, plugin]) ?? []), [profile])
  const patches = useMemo(() => new Map(inspection.patches.map(patch => [patch.key, patch])), [inspection])
  const ownerPatchKeys = (owner: string): string[] => patchOrder.filter(key => patches.get(key)?.owner === owner)
  const compatibilityWarnings = profile?.compatibility.filter(item => item.kind !== 'integration') ?? []
  const dirty = profile !== undefined && (!sameStringList(order, profile.order)
    || !sameStringList(patchOrder, profile.patchOrder) || !sameStringList(disabled, profile.disabled))

  const visiblePlugins = useMemo(() => {
    const query = pluginQuery.trim().toLocaleLowerCase()
    if (query === '') return order
    return order.filter(name => {
      const plugin = plugins.get(name)
      return `${name}\n${plugin?.description ?? ''}\n${plugin?.version ?? ''}`.toLocaleLowerCase().includes(query)
    })
  }, [order, pluginQuery, plugins])
  const draftPatches = useMemo(() => inspection.patches.filter(patch => patch.owner === selectedDraft.name),
    [inspection.patches, selectedDraft.name])

  const setLoaded = (nextProfile: StudioHarmonyProfile, nextInspection: StudioHarmonyInspection): void => {
    setProfile(nextProfile)
    setInspection(nextInspection)
    setOrder(nextProfile.order)
    const known = new Set(nextProfile.patchOrder)
    setPatchOrder([...nextProfile.patchOrder, ...nextInspection.patches.map(item => item.key).filter(key => !known.has(key))])
    setDisabled(nextProfile.disabled)
  }

  const load = async (): Promise<void> => {
    const request = ++loadRequest.current
    if (selectedDraft.runtime.state !== 'running') {
      setProfile(undefined)
      setInspection({ patches: [], targets: [] })
      setLoading(false)
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const payload = { draftId: selectedDraft.id }
      const [nextProfile, nextInspection] = await Promise.all([
        callStudio<StudioHarmonyProfile>('studio.drafts.harmony.profile', payload),
        callStudio<StudioHarmonyInspection>('studio.drafts.harmony.inspect', payload),
      ])
      if (loadRequest.current !== request) return
      setLoaded(nextProfile, nextInspection)
      setSelectedProvider(current => current !== undefined && nextProfile.order.includes(current) ? current : undefined)
      setAppliedGeneration(undefined)
    } catch (cause) {
      if (loadRequest.current !== request) return
      setProfile(undefined)
      setError(studioErrorMessage(cause, t))
    } finally {
      if (loadRequest.current === request) setLoading(false)
    }
  }

  useEffect(() => {
    setSelectedProvider(undefined)
    setPatchDialogOpen(false)
    void load()
    return () => { loadRequest.current += 1 }
  }, [selectedDraft?.id, selectedDraft?.runtime.state])

  useEffect(() => {
    const dialog = patchDialogRef.current
    if (dialog === null) return
    if (patchDialogOpen && !dialog.open) dialog.showModal()
    if (!patchDialogOpen && dialog.open) dialog.close()
  }, [patchDialogOpen])

  const apply = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const result = await callStudio<StudioHarmonyProfileUpdateResult>('studio.drafts.harmony.updateProfile', {
        draftId: selectedDraft.id, order, patchOrder, disabled,
      })
      const nextInspection = await callStudio<StudioHarmonyInspection>('studio.drafts.harmony.inspect', { draftId: selectedDraft.id })
      setLoaded(result.profile, nextInspection)
      setAppliedGeneration(result.generation)
    } catch (cause) {
      setError(studioErrorMessage(cause, t))
    } finally {
      setSaving(false)
    }
  }

  const enterPlugin = (event: DragEvent<HTMLElement>, name: string): void => {
    event.preventDefault()
    if (dragging?.kind !== 'plugin' || dragging.key === name) return
    setOrder(current => moveProfilePlugin(current, dragging.key, current.indexOf(name)))
  }
  const movePluginByKey = (event: KeyboardEvent<HTMLElement>, name: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedProvider(name)
      return
    }
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    setOrder(current => moveProfilePlugin(current, name, current.indexOf(name) + (event.key === 'ArrowUp' ? -1 : 1)))
  }

  const profileActions = profile !== undefined && <footer className="profile-management-actions"><span aria-live="polite">
    {dirty ? t('profileUnsaved') : appliedGeneration === undefined ? t('profileNoChanges')
      : t('profileApplied', { generation: appliedGeneration })}</span>
    <Button size="small" variant="primary" loading={saving} loadingLabel={t('profileApplying')} disabled={!dirty}
      onClick={() => void apply()}>{t('profileApply')}</Button></footer>

  const unavailable = !running
    ? <EmptyState title={t('profileDraftNotRunning')} description={t('profileDraftNotRunningDescription')} />
    : loading ? <p className="profile-management-status">{t('profileLoading')}</p>
      : profile === undefined ? <EmptyState title={t('profileLoadError')} description={error}
          action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} /> : undefined

  return <>
    <section id="left-sidebar-panel-plugins" role="tabpanel" hidden={view !== 'plugins'}
      aria-labelledby="left-sidebar-tab-plugins" className="left-sidebar-page plugin-management-page">
      {view === 'plugins' && <div className="plugin-management-content profile-management">
        <header className="profile-management-heading">
          <div><strong>{t('pluginManagementTitle')}</strong><p>{t('pluginManagementDescription')}</p></div>
          <Button size="small" variant="ghost" disabled={!running || loading || saving || dirty}
            onClick={() => void load()}>{t('profileRefresh')}</Button>
        </header>
        {unavailable ?? <>
          <Input className="plugin-management-search" type="search" value={pluginQuery}
            onChange={event => setPluginQuery(event.target.value)} aria-label={t('pluginManagementSearch')}
            placeholder={t('pluginManagementSearch')} />
          <div className="profile-management-scroll">
            {(profile?.orderViolations.length ?? 0) > 0
              && <Notice tone="warning">{t('profileOrderWarning', { count: profile?.orderViolations.length ?? 0 })}</Notice>}
            {compatibilityWarnings.length > 0
              && <Notice tone="warning">{t('profileConflictWarning', { count: compatibilityWarnings.length })}</Notice>}
            <div className="plugin-management-list-heading"><strong>{t('profileProviderOrder')}</strong>
              <span>{visiblePlugins.length === order.length ? order.length
                : `${visiblePlugins.length}/${order.length}`}</span></div>
            {visiblePlugins.length === 0 ? <p className="profile-management-status">{pluginQuery === ''
                ? t('pluginManagementEmpty') : t('pluginManagementNoResults')}</p>
              : <div className="profile-plugin-list profile-provider-list" role="listbox" aria-label={t('profileProviderOrder')}
                  onDragOver={event => event.preventDefault()} onDrop={() => setDragging(undefined)}>
                  {visiblePlugins.map(name => {
                    const index = order.indexOf(name)
                    const plugin = plugins.get(name)
                    const fixed = name === 'dsh-harmony' || name === 'the-binding-of-dsh'
                    const enabled = isProfilePluginEnabled(disabled, name)
                    const runtime = providerRuntimeStatus(profile?.runtimePlugins ?? [], name)
                    const runtimeLabel = runtime.total === 0 ? t('profileLoaderUnavailable')
                      : runtime.enabled === 0 ? t('profileLoaderDisabled')
                        : runtime.enabled === runtime.total ? t('profileLoaderEnabled')
                          : t('profileLoaderPartial', runtime)
                    const keys = ownerPatchKeys(name)
                    return <article role="option" aria-selected={selectedProvider === name} key={name} className="profile-plugin-row"
                      data-selected={selectedProvider === name || undefined} data-disabled={!enabled || undefined}
                      data-dragging={dragging?.kind === 'plugin' && dragging.key === name || undefined}
                      draggable={!fixed && !saving} tabIndex={0} aria-label={t('profileMovePlugin', { name })}
                      onClick={() => setSelectedProvider(name)} onKeyDown={event => movePluginByKey(event, name)}
                      onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; setDragging({ kind: 'plugin', key: name }) }}
                      onDragEnter={event => enterPlugin(event, name)} onDragEnd={() => setDragging(undefined)}>
                      <span className="profile-plugin-grip"><GripIcon pinned={fixed} /></span>
                      <span className="profile-plugin-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="profile-plugin-identity"><strong title={name}>{name}</strong><span>
                        {plugin?.version ? `v${plugin.version}` : t('profileVersionUnknown')} · {t('profilePatchCount', { count: keys.length })} · {runtimeLabel}
                      </span></span>
                      {fixed ? <Badge>{t('profilePinned')}</Badge> : <button type="button" className="profile-plugin-toggle"
                        role="switch" aria-checked={enabled} disabled={saving}
                        aria-label={enabled ? t('profileDisablePlugin') : t('profileEnablePlugin')}
                        onClick={event => {
                          event.stopPropagation()
                          setDisabled(current => setProfilePluginEnabled(current, name, !enabled))
                        }}>
                        <span aria-hidden="true" /><b>{enabled ? t('profileEnabled') : t('profileDisabled')}</b></button>}
                    </article>
                  })}
                </div>}
            {selectedProvider !== undefined && <article className="profile-provider-detail">
              <strong>{selectedProvider}</strong>
              <p>{plugins.get(selectedProvider)?.description || t('profileProviderNoDescription')}</p>
              <span>{t('profilePatchCount', { count: ownerPatchKeys(selectedProvider).length })}</span>
            </article>}
            {error !== undefined && <Notice tone="danger">{error}</Notice>}
          </div>
          {profileActions}
        </>}
      </div>}
    </section>

    <section id="left-sidebar-panel-patches" role="tabpanel" hidden={view !== 'patches'}
      aria-labelledby="left-sidebar-tab-patches" className="left-sidebar-page plugin-management-page">
      {view === 'patches' && <div className="plugin-management-content profile-management">
        <header className="profile-management-heading">
          <div><strong>{t('patchManagementDraftPatches')}</strong><p>{t('patchManagementDraftDescription')}</p></div>
          <Button size="small" variant="ghost" disabled={!running || loading || saving || dirty}
            onClick={() => void load()}>{t('profileRefresh')}</Button>
        </header>
        {unavailable ?? <>
          <div className="profile-management-scroll">
            {draftPatches.length === 0
              ? <EmptyState title={t('patchManagementDraftEmpty')} />
              : <div className="profile-plugin-list profile-patch-list draft-patch-list" role="list"
                  aria-label={t('patchManagementDraftPatches')}>
                  {draftPatches.map((patch, index) => <article key={patch.key} role="listitem"
                    className="profile-patch-row draft-patch-row" title={patch.error}>
                    <span className="profile-plugin-index">{index + 1}</span>
                    <span className="profile-patch-identity"><strong title={patch.key}>{patch.id}</strong><span>
                      {patch.kind} · {t('patchManagementMatches', { count: patch.matches })}
                    </span></span>
                    <span className="profile-patch-controls">
                      <Badge tone={patch.state === 'failed' ? 'danger' : patch.state === 'pending' ? 'warning'
                        : patch.state === 'bound' ? 'success' : 'neutral'}>{t(patch.state === 'failed' ? 'profilePatchStatusError'
                          : patch.state === 'pending' ? 'profilePatchStatusWarning' : patch.state === 'bound'
                            ? 'profilePatchStatusNormal' : 'profilePatchStatusDisabled')}</Badge>
                    </span>
                  </article>)}
                </div>}
            {error !== undefined && <Notice tone="danger">{error}</Notice>}
          </div>
          <Button className="patch-order-open" variant="primary" onClick={() => setPatchDialogOpen(true)}>
            {t('patchManagementOpenOrder')}
          </Button>
        </>}
      </div>}
    </section>

    <dialog ref={patchDialogRef} className="studio-patch-order-dialog studio-ui-root"
      aria-labelledby="studio-patch-order-title" onCancel={event => {
        event.preventDefault()
        setPatchDialogOpen(false)
      }} onClose={() => setPatchDialogOpen(false)}>
      <header className="settings-dialog-header">
        <div><h2 id="studio-patch-order-title">{t('profilePatchOrder')}</h2><p>{t('patchManagementOrderDescription')}</p></div>
        <IconButton size="small" variant="ghost" label={t('patchManagementCloseOrder')}
          onClick={() => setPatchDialogOpen(false)}><CloseIcon /></IconButton>
      </header>
      <div className="patch-order-dialog-body">
        {profile !== undefined && <HarmonyPatchOrder profile={profile} inspection={inspection} order={patchOrder}
          disabled={disabled} saving={saving} onOrderChange={setPatchOrder} onDisabledChange={setDisabled}
          onApply={() => void apply()} onUndo={() => {
            setPatchOrder(profile.patchOrder)
            setDisabled(profile.disabled)
          }} />}
        {error !== undefined && <Notice tone="danger">{error}</Notice>}
      </div>
    </dialog>
  </>
}
