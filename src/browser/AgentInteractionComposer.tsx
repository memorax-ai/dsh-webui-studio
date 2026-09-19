import { useId, useState } from 'react'
import type { ClientResponse } from './session-types'
import { Button } from './ui'
import type { StudioTranslate } from './i18n'
import {
  agentPlanReview,
  approvalInteractionResponse,
  cancelQuestionInteractionResponse,
  parseRecommendedLabel,
  questionInteractionResponse,
  type AgentPendingInteraction,
  type AgentQuestionAnswer,
} from './agent-interactions'

interface AgentInteractionComposerProps {
  interaction: AgentPendingInteraction
  pendingCount: number
  approvalArguments?: string
  t: StudioTranslate
  onRespond(response: ClientResponse): Promise<void>
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function prettyArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function PendingCount({ count, t }: { count: number; t: StudioTranslate }): JSX.Element | null {
  return count > 1 ? <span className="agent-interaction-count">{t('agentInteractionPendingCount', { count })}</span> : null
}

function ApprovalComposer({ interaction, pendingCount, approvalArguments, t, onRespond }: AgentInteractionComposerProps & {
  interaction: Extract<AgentPendingInteraction, { kind: 'approval' }>
}): JSX.Element {
  const [pendingAction, setPendingAction] = useState<'allow' | 'reject'>()
  const [error, setError] = useState<string>()
  const decide = (outcome: 'allowed-once' | 'rejected'): void => {
    setPendingAction(outcome === 'allowed-once' ? 'allow' : 'reject')
    setError(undefined)
    void onRespond(approvalInteractionResponse(interaction, outcome)).catch(cause => {
      setPendingAction(undefined)
      setError(errorText(cause))
    })
  }

  return <section className="agent-interaction agent-approval" aria-labelledby={`agent-approval-${interaction.rpcId}`}>
    <header>
      <h3 id={`agent-approval-${interaction.rpcId}`}>{t('agentApprovalTitle')}</h3>
      <PendingCount count={pendingCount} t={t} />
    </header>
    <dl>
      <div><dt>{t('agentApprovalTool')}</dt><dd><code>{interaction.request.toolName}</code></dd></div>
      <div><dt>{t('agentApprovalReason')}</dt><dd>{interaction.request.reason?.trim() || t('agentApprovalReasonFallback')}</dd></div>
    </dl>
    {approvalArguments !== undefined && approvalArguments !== '' && <section className="agent-approval-input">
      <span>{t('agentApprovalInput')}</span><pre>{prettyArguments(approvalArguments)}</pre>
    </section>}
    <footer>
      <span className="agent-interaction-error" role="alert">{error}</span>
      <div>
        <Button loading={pendingAction === 'reject'} loadingLabel={t('agentResponding')} disabled={pendingAction !== undefined}
          onClick={() => decide('rejected')}>{t('agentReject')}</Button>
        <Button variant="primary" loading={pendingAction === 'allow'} loadingLabel={t('agentResponding')}
          disabled={pendingAction !== undefined}
          onClick={() => decide('allowed-once')}>{t('agentAllowOnce')}</Button>
      </div>
    </footer>
  </section>
}

interface QuestionDraft {
  selected: string[]
  custom: string
  skipped: boolean
}

function answered(draft: QuestionDraft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== ''
}

function QuestionComposer({ interaction, pendingCount, t, onRespond }: AgentInteractionComposerProps & {
  interaction: Extract<AgentPendingInteraction, { kind: 'question' }>
}): JSX.Element {
  const questions = interaction.request.questions
  const fieldName = useId()
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() => Object.fromEntries(
    questions.map(question => [question.id, { selected: [], custom: '', skipped: false }]),
  ))
  const [pendingAction, setPendingAction] = useState<'cancel' | 'submit'>()
  const [error, setError] = useState<string>()
  const question = questions[index]

  if (question === undefined) {
    return <section className="agent-interaction agent-question">
      <header><h3>{t('agentQuestionTitle')}</h3><PendingCount count={pendingCount} t={t} /></header>
      <p>{t('agentQuestionEmpty')}</p>
      <footer><span /><Button loading={pendingAction === 'cancel'} loadingLabel={t('agentResponding')} onClick={() => {
        setPendingAction('cancel')
        void onRespond(cancelQuestionInteractionResponse(interaction)).catch(cause => {
          setPendingAction(undefined)
          setError(errorText(cause))
        })
      }}>{t('agentQuestionCancel')}</Button></footer>
      <span className="agent-interaction-error" role="alert">{error}</span>
    </section>
  }

  const draft = drafts[question.id] ?? { selected: [], custom: '', skipped: false }
  const setDraft = (next: QuestionDraft): void => setDrafts(current => ({ ...current, [question.id]: next }))
  const options = question.options ?? []
  const ready = questions.every(item => answered(drafts[item.id] ?? { selected: [], custom: '', skipped: false }))

  const select = (label: string): void => {
    if (question.multiSelect === true) {
      const selected = draft.selected.includes(label)
        ? draft.selected.filter(item => item !== label)
        : [...draft.selected, label]
      setDraft({ ...draft, selected, skipped: false })
    } else {
      setDraft({ selected: [label], custom: '', skipped: false })
    }
  }
  const skip = (): void => {
    setDraft({ selected: [], custom: '', skipped: true })
    if (index < questions.length - 1) setIndex(index + 1)
  }
  const submit = (response: ClientResponse, action: 'cancel' | 'submit'): void => {
    setPendingAction(action)
    setError(undefined)
    void onRespond(response).catch(cause => {
      setPendingAction(undefined)
      setError(errorText(cause))
    })
  }
  const answer: AgentQuestionAnswer = {
    answers: questions.map(item => {
      const value = drafts[item.id] ?? { selected: [], custom: '', skipped: true }
      return {
        id: item.id,
        selected: value.selected,
        ...(value.custom.trim() === '' ? {} : { custom: value.custom.trim() }),
      }
    }),
  }

  return <section className="agent-interaction agent-question" aria-labelledby={`${fieldName}-question`}>
    <header>
      <h3>{t('agentQuestionTitle')}</h3>
      <div><span>{t('agentQuestionProgress', { current: index + 1, total: questions.length })}</span>
        <PendingCount count={pendingCount} t={t} /></div>
    </header>
    <fieldset disabled={pendingAction !== undefined}>
      <legend id={`${fieldName}-question`}>{question.question}</legend>
      {question.header !== undefined && <span className="agent-question-group">{question.header}</span>}
      {question.detail !== undefined && <p className="agent-question-detail">{question.detail}</p>}
      {options.length > 0 && <div className="agent-question-options">{options.map(option => {
        const display = parseRecommendedLabel(option.label)
        return <label key={option.label} data-selected={draft.selected.includes(option.label) || undefined}>
          <input type={question.multiSelect === true ? 'checkbox' : 'radio'} name={`${fieldName}-${question.id}`}
            checked={draft.selected.includes(option.label)} onChange={() => select(option.label)} />
          <span><strong>{display.label}</strong>{display.recommended && <small>{t('agentQuestionRecommended')}</small>}
            {option.description !== undefined && <em>{option.description}</em>}</span>
        </label>
      })}</div>}
      <label className="agent-question-custom">
        <span>{t('agentQuestionCustom')}</span>
        <textarea rows={2} value={draft.custom} placeholder={t('agentQuestionCustomPlaceholder')}
          onChange={event => setDraft({
            selected: question.multiSelect === true ? draft.selected : [],
            custom: event.target.value,
            skipped: false,
          })} />
      </label>
    </fieldset>
    <footer>
      <span className="agent-interaction-error" role="alert">{error}</span>
      <div>
        <Button variant="ghost" loading={pendingAction === 'cancel'} loadingLabel={t('agentResponding')}
          disabled={pendingAction !== undefined} onClick={() => submit(cancelQuestionInteractionResponse(interaction), 'cancel')}>
          {t('agentQuestionCancel')}
        </Button>
        {index > 0 && <Button disabled={pendingAction !== undefined} onClick={() => setIndex(index - 1)}>{t('agentQuestionPrevious')}</Button>}
        <Button disabled={pendingAction !== undefined} onClick={skip}>{t('agentQuestionSkip')}</Button>
        {index < questions.length - 1
          ? <Button variant="primary" disabled={pendingAction !== undefined || !answered(draft)} onClick={() => setIndex(index + 1)}>{t('agentQuestionNext')}</Button>
          : <Button variant="primary" loading={pendingAction === 'submit'} loadingLabel={t('agentResponding')}
              disabled={pendingAction !== undefined || !ready}
              onClick={() => submit(questionInteractionResponse(interaction, answer), 'submit')}>{t('agentQuestionSubmit')}</Button>}
      </div>
    </footer>
  </section>
}

function PlanReviewComposer({ interaction, pendingCount, t, onRespond }: AgentInteractionComposerProps & {
  interaction: Extract<AgentPendingInteraction, { kind: 'question' }>
}): JSX.Element | null {
  const review = agentPlanReview(interaction)
  const [pendingAction, setPendingAction] = useState<'discuss' | 'decline' | 'approve'>()
  const [error, setError] = useState<string>()
  if (review === undefined) return null

  const submit = (response: ClientResponse, action: 'discuss' | 'decline' | 'approve'): void => {
    setPendingAction(action)
    setError(undefined)
    void onRespond(response).catch(cause => {
      setPendingAction(undefined)
      setError(errorText(cause))
    })
  }
  const decide = (label: string, action: 'decline' | 'approve'): void => submit(questionInteractionResponse(interaction, {
    answers: [{ id: review.id, selected: [label] }],
  }), action)

  return <section className="agent-interaction agent-plan-review" aria-label={review.question}>
    <header><h3>{t('agentPlanReviewTitle')}</h3><PendingCount count={pendingCount} t={t} /></header>
    <div className="agent-plan-review-body">{review.plan}</div>
    <footer>
      <span className="agent-interaction-error" role="alert">{error}</span>
      <div>
        <Button variant="ghost" loading={pendingAction === 'discuss'} loadingLabel={t('agentResponding')}
          disabled={pendingAction !== undefined} onClick={() => submit(cancelQuestionInteractionResponse(interaction), 'discuss')}>
          {t('agentPlanDiscuss')}
        </Button>
        {review.decline !== undefined && <Button loading={pendingAction === 'decline'} loadingLabel={t('agentResponding')}
          disabled={pendingAction !== undefined} title={review.decline.description}
          onClick={() => decide(review.decline!.label, 'decline')}>{t('agentPlanRefuse')}</Button>}
        <Button variant="primary" loading={pendingAction === 'approve'} loadingLabel={t('agentResponding')}
          disabled={pendingAction !== undefined} title={review.approve.description}
          onClick={() => decide(review.approve.label, 'approve')}>{t('agentPlanApprove')}</Button>
      </div>
    </footer>
  </section>
}

export function AgentInteractionComposer(props: AgentInteractionComposerProps): JSX.Element {
  if (props.interaction.kind === 'approval') return <ApprovalComposer {...props} interaction={props.interaction} />
  const review = agentPlanReview(props.interaction)
  return review === undefined
    ? <QuestionComposer {...props} interaction={props.interaction} />
    : <PlanReviewComposer {...props} interaction={props.interaction} />
}
