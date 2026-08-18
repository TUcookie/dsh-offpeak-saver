/** 错峰省钱面板：待执行任务、历史账单、节省金额。 */

import { useEffect, useMemo, useState } from 'react'
import {
  cancelTask,
  formatClock,
  loadOverview,
  money,
  submitTask,
  type PanelOverview,
  type PanelTask,
} from './api.ts'
import css from './panel.module.css'
import type { zh } from './locales.ts'

export type OffpeakPanelProps = {
  t: (key: keyof typeof zh) => string
}

function priorityLabel(priority: number, t: (key: keyof typeof zh) => string): string {
  if (priority === 0) return t('priorityRealtime')
  if (priority === 2) return t('priorityBackground')
  return t('priorityOffpeak')
}

function statusLabel(status: string, t: (key: keyof typeof zh) => string): string {
  switch (status) {
    case 'pending': return t('statusPending')
    case 'running': return t('statusRunning')
    case 'paused': return t('statusPaused')
    case 'completed': return t('statusCompleted')
    case 'failed': return t('statusFailed')
    case 'cancelled': return t('statusCancelled')
    default: return status
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'pending': return css.statusPending
    case 'running': return css.statusRunning
    case 'paused': return css.statusPaused
    case 'completed': return css.statusCompleted
    case 'failed': return css.statusFailed
    default: return css.statusCancelled
  }
}

function TaskTable({ tasks, t, onCancel }: {
  tasks: PanelTask[]
  t: (key: keyof typeof zh) => string
  onCancel: (id: string) => void
}): React.ReactNode {
  if (tasks.length === 0) {
    return <div className={css.empty}>{t('queueEmpty')}</div>
  }
  return (
    <table className={css.table}>
      <thead>
        <tr>
          <th>{t('taskTitle')}</th>
          <th>{t('taskStatus')}</th>
          <th>{t('taskPriority')}</th>
          <th>{t('taskCreated')}</th>
          <th>{t('taskAction')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id}>
            <td className={css.truncate} title={task.prompt}>{task.title}</td>
            <td><span className={`${css.status} ${statusClass(task.status)}`}>{statusLabel(task.status, t)}</span></td>
            <td>{priorityLabel(task.priority, t)}</td>
            <td className={css.mono}>{formatClock(task.created_at)}</td>
            <td>
              {task.status === 'pending' || task.status === 'paused'
                ? (
                  <button
                    className={css.button}
                    onClick={() => { onCancel(task.id) }}
                  >
                    {t('taskCancel')}
                  </button>
                )
                : <span className={css.muted}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function formatElapsed(fromIso: string, now: number): string {
  const start = new Date(fromIso).getTime()
  const secs = Math.max(0, Math.floor((now - start) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${secs % 60}s`
}

interface TaskStreamText {
  text: string
  reasoning: string
}

function RunningSection({ tasks, t, now, streams, onCancel }: {
  tasks: PanelTask[]
  t: (key: keyof typeof zh) => string
  now: number
  streams: Record<string, TaskStreamText>
  onCancel: (id: string) => void
}): React.ReactNode {
  if (tasks.length === 0) return null
  return (
    <div className={`${css.section} ${css.runningSection}`}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('runningTitle')}（{tasks.length}）</h3>
        <span className={css.liveDot} />
        <span className={css.liveLabel}>{t('live')}</span>
      </div>
      {tasks.map((task) => {
        const stream = streams[task.id]
        const hasStream = stream !== undefined && (stream.text !== '' || stream.reasoning !== '')
        return (
          <div key={task.id} className={css.streamRow}>
            <table className={css.table}>
              <tbody>
                <tr>
                  <td className={css.truncate} title={task.prompt}>{task.title}</td>
                  <td className={css.mono}>
                    {task.executed_at !== null ? `${t('startedAt')} ${formatClock(task.executed_at)}` : '—'}
                  </td>
                  <td className={css.mono}>
                    {task.executed_at !== null ? `${t('elapsed')} ${formatElapsed(task.executed_at, now)}` : '—'}
                  </td>
                  <td>
                    <button className={css.button} onClick={() => { onCancel(task.id) }}>
                      {t('taskCancel')}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div className={css.streamBox}>
              {!hasStream
                ? <span className={css.streamEmpty}>{t('streamWaiting')}</span>
                : (
                  <>
                    {stream !== undefined && stream.reasoning !== '' && (
                      <div className={css.streamReasoning}>{stream.reasoning}</div>
                    )}
                    {stream !== undefined && stream.text !== '' && (
                      <div className={css.streamText}>{stream.text}</div>
                    )}
                  </>
                )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RecentTable({ tasks, t }: { tasks: PanelTask[]; t: (key: keyof typeof zh) => string }): React.ReactNode {
  if (tasks.length === 0) {
    return <div className={css.empty}>{t('recentEmpty')}</div>
  }
  return (
    <table className={css.table}>
      <thead>
        <tr>
          <th>{t('taskTitle')}</th>
          <th>{t('taskStatus')}</th>
          <th>{t('taskTokens')}</th>
          <th>{t('taskSavings')}</th>
          <th>{t('taskCreated')}</th>
          <th>{t('execTime')}</th>
          <th>{t('taskResultPath')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id}>
            <td className={css.truncate} title={task.prompt}>{task.title}</td>
            <td><span className={`${css.status} ${statusClass(task.status)}`}>{statusLabel(task.status, t)}</span></td>
            <td className={css.mono}>
              {task.status === 'completed'
                ? `${task.input_tokens.toLocaleString()} → ${task.output_tokens.toLocaleString()}`
                : '—'}
            </td>
            <td className={css.savings}>
              {task.status === 'completed' ? `¥${task.savings.toFixed(4)}` : '—'}
            </td>
            <td className={css.mono}>{formatClock(task.created_at)}</td>
            <td className={css.mono}>
              {task.executed_at !== null && task.completed_at !== null
                ? `${formatClock(task.executed_at)} → ${formatClock(task.completed_at)}`
                : '—'}
            </td>
            <td className={`${css.mono} ${css.truncate}`}>{task.result_path ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SubmitForm({ t, onSubmitted }: {
  t: (key: keyof typeof zh) => string
  onSubmitted: () => Promise<void>
}): React.ReactNode {
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<'realtime' | 'offpeak' | 'background'>('offpeak')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<'ok' | 'error'>('ok')

  const doSubmit = async (): Promise<void> => {
    if (prompt.trim() === '') {
      setFeedback(t('submitEmpty'))
      setFeedbackKind('error')
      return
    }
    setSubmitting(true)
    setFeedback(null)
    try {
      const result = await submitTask({ prompt: prompt.trim(), title: title.trim() || undefined, priority })
      setFeedback(`${t('submitSuccess')}：${result.message}`)
      setFeedbackKind('ok')
      setPrompt('')
      setTitle('')
      await onSubmitted()
    } catch (error) {
      setFeedback(`${t('submitError')}：${error instanceof Error ? error.message : String(error)}`)
      setFeedbackKind('error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={`${css.section} ${css.submitSection}`}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('submitTitle')}</h3>
      </div>
      <div className={css.submitBody}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('submitPrompt')}</span>
          <textarea
            className={css.textarea}
            value={prompt}
            placeholder={t('submitPromptPlaceholder')}
            rows={3}
            onChange={(event) => { setPrompt(event.target.value) }}
          />
        </label>
        <div className={css.submitRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('submitTitleLabel')}</span>
            <input
              className={css.input}
              value={title}
              onChange={(event) => { setTitle(event.target.value) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('submitPriority')}</span>
            <select
              className={css.input}
              value={priority}
              onChange={(event) => { setPriority(event.target.value as typeof priority) }}
            >
              <option value="offpeak">{t('submitPriorityOffpeak')}</option>
              <option value="realtime">{t('submitPriorityRealtime')}</option>
              <option value="background">{t('submitPriorityBackground')}</option>
            </select>
          </label>
          <button
            className={css.button}
            disabled={submitting}
            onClick={() => { void doSubmit() }}
          >
            {submitting ? t('submitting') : t('submitButton')}
          </button>
        </div>
        {feedback !== null && (
          <p className={feedbackKind === 'ok' ? css.feedbackOk : css.feedbackError} role="status">
            {feedback}
          </p>
        )}
      </div>
    </div>
  )
}

export function OffpeakPanel({ t }: OffpeakPanelProps): React.ReactNode {
  const [state, setState] = useState<PanelOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [cancelling, setCancelling] = useState<Set<string>>(new Set())
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [streamTexts, setStreamTexts] = useState<Record<string, TaskStreamText>>({})

  const load = useMemo(() => async (): Promise<void> => {
    setError(null)
    try {
      const overview = await loadOverview()
      setState(overview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const cancel = useMemo(() => async (taskId: string): Promise<void> => {
    setCancelling((prev) => new Set(prev).add(taskId))
    try {
      await cancelTask(taskId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }, [load])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 30_000)
    return () => clearInterval(timer)
  }, [load])

  // 正在执行的任务：每秒刷新“已执行时长”
  useEffect(() => {
    if (state === null || state.running.length === 0) return
    const timer = setInterval(() => { setNowTick(Date.now()) }, 1000)
    return () => clearInterval(timer)
  }, [state])

  // SSE：任务状态一变化立刻刷新面板，不用等 30 秒轮询
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource('/offpeak-saver/events')
    es.addEventListener('message', (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as {
          type?: string
          taskId?: string
          kind?: 'text' | 'reasoning'
          text?: string
        }
        if (event.type === 'task-stream' && event.taskId !== undefined && typeof event.text === 'string') {
          setStreamTexts((prev) => {
            const current = prev[event.taskId!] ?? { text: '', reasoning: '' }
            const key = event.kind === 'reasoning' ? 'reasoning' : 'text'
            const next = `${current[key]}${event.text}`.slice(-4000)
            return { ...prev, [event.taskId!]: { ...current, [key]: next } }
          })
          return
        }
        void load()
      } catch {
        void load()
      }
    })
    return () => { es.close() }
  }, [load])

  // 任务离开 running 列表后清理流式缓存，避免残留
  useEffect(() => {
    if (state === null) return
    const runningIds = new Set(state.running.map((task) => task.id))
    setStreamTexts((prev) => {
      const stale = Object.keys(prev).filter((id) => !runningIds.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
  }, [state])

  if (loading && state === null) {
    return <div className={css.panel}><div className={css.empty}>{t('loading')}</div></div>
  }

  if (state === null) {
    return (
      <div className={css.panel}>
        <div className={css.error} role="alert">
          {t('error')}: {error ?? ''}
        </div>
        <button className={css.button} onClick={() => { void load() }}>{t('retry')}</button>
      </div>
    )
  }

  const report = state.reports[period]
  const queue = state.pending

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.subtitle}>{t('subtitle')}</p>
        </div>
        <span className={`${css.badge} ${state.phase === 'peak' ? css.badgePeak : css.badgeOffpeak}`}>
          {state.phase === 'peak' ? t('phasePeak') : t('phaseOffpeak')}
        </span>
        {state.nextOffPeak !== null && (
          <span className={css.muted} style={{ fontSize: 12 }}>
            {t('nextOffpeak')}: {state.nextOffPeak}
          </span>
        )}
        <span className={css.spacer} />
        <button className={css.button} disabled={loading} onClick={() => { void load() }}>
          {loading ? t('loading') : t('refresh')}
        </button>
      </div>

      {error !== null && <div className={css.error} role="alert">{error}</div>}

      <SubmitForm t={t} onSubmitted={load} />

      <div className={css.cards}>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statTodaySavings')}</div>
          <div className={css.cardValue} style={{ color: '#3fb950' }}>
            {money(state.reports.day.savings, state.reports.day.currency)}
          </div>
        </div>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statWeekSavings')}</div>
          <div className={css.cardValue} style={{ color: '#3fb950' }}>
            {money(state.reports.week.savings, state.reports.week.currency)}
          </div>
        </div>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statMonthSavings')}</div>
          <div className={css.cardValue} style={{ color: '#3fb950' }}>
            {money(state.reports.month.savings, state.reports.month.currency)}
          </div>
        </div>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statExecutions')}</div>
          <div className={css.cardValue}>{state.reports.day.executions}</div>
        </div>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statFreeTokens')}</div>
          <div className={css.cardValue}>{state.reports.day.equivalent_free_tokens.toLocaleString()}</div>
        </div>
        <div className={css.card}>
          <div className={css.cardLabel}>{t('statPending')}</div>
          <div className={css.cardValue}>{queue.length}</div>
        </div>
      </div>

      <RunningSection
        tasks={state.running}
        t={t}
        now={nowTick}
        streams={streamTexts}
        onCancel={(id) => { void cancel(id) }}
      />

      <div className={css.section}>
        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('queueTitle')}（{queue.length}）</h3>
        </div>
        <TaskTable tasks={queue} t={t} onCancel={(id) => { void cancel(id) }} />
      </div>

      <div className={css.section}>
        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('recentTitle')}</h3>
          <div className={css.tabs}>
            {(['day', 'week', 'month'] as const).map((key) => (
              <button
                key={key}
                className={`${css.tab} ${period === key ? css.tabActive : ''}`}
                onClick={() => { setPeriod(key) }}
              >
                {t(`report${key[0].toUpperCase()}${key.slice(1)}` as keyof typeof zh)}
              </button>
            ))}
          </div>
        </div>
        <div className={css.cards} style={{ padding: '10px 14px' }}>
          <div className={css.card}>
            <div className={css.cardLabel}>{t('reportExecutions')}</div>
            <div className={css.cardValue}>{report.executions}</div>
          </div>
          <div className={css.card}>
            <div className={css.cardLabel}>{t('reportActual')}</div>
            <div className={css.cardValue}>{money(report.cost_actual, report.currency)}</div>
          </div>
          <div className={css.card}>
            <div className={css.cardLabel}>{t('reportBaseline')}</div>
            <div className={css.cardValue}>{money(report.cost_baseline, report.currency)}</div>
          </div>
          <div className={css.card}>
            <div className={css.cardLabel}>{t('reportSavings')}</div>
            <div className={css.cardValue} style={{ color: '#3fb950' }}>{money(report.savings, report.currency)}</div>
          </div>
          <div className={css.card}>
            <div className={css.cardLabel}>{t('reportFreeTokens')}</div>
            <div className={css.cardValue}>{report.equivalent_free_tokens.toLocaleString()}</div>
          </div>
        </div>
        <RecentTable tasks={state.recent} t={t} />
      </div>
    </div>
  )
}
