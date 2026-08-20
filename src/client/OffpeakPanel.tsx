/** 错峰省钱面板：待执行任务、历史账单、节省金额。 */

import { useEffect, useMemo, useState } from 'react'
import {
  cancelTask,
  formatClock,
  loadOverview,
  money,
  type PanelOverview,
  type PanelTask,
} from './api.ts'
import css from './panel.module.css'
import type { zh } from './locales.ts'
import refreshBlackRaw from './assets/refresh.svg?raw'
import refreshWhiteRaw from './assets/refresh_white.svg?raw'

const refreshBlack = `data:image/svg+xml;base64,${btoa(refreshBlackRaw)}`
const refreshWhite = `data:image/svg+xml;base64,${btoa(refreshWhiteRaw)}`

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

function TaskList({ tasks, t, onCancel }: {
  tasks: PanelTask[]
  t: (key: keyof typeof zh) => string
  onCancel: (id: string) => void
}): React.ReactNode {
  if (tasks.length === 0) {
    return <div className={css.empty}>{t('queueEmpty')}</div>
  }
  return (
    <ul className={css.taskList}>
      {tasks.map((task) => (
        <li key={task.id} className={css.taskRow}>
          <div className={css.taskMain}>
            <span className={css.taskTitle} title={task.prompt}>{task.title}</span>
            <span className={`${css.status} ${statusClass(task.status)}`}>{statusLabel(task.status, t)}</span>
          </div>
          <div className={css.taskMeta}>
            <span className={css.muted}>{priorityLabel(task.priority, t)} · {formatClock(task.created_at)}</span>
            {(task.status === 'pending' || task.status === 'paused') && (
              <button className={css.button} onClick={() => { onCancel(task.id) }}>
                {t('taskCancel')}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
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
          <div key={task.id} className={css.runningRow}>
            <div className={css.runningHead}>
              <span className={css.taskTitle} title={task.prompt}>{task.title}</span>
              <span className={css.mono}>
                {task.executed_at !== null ? `${t('elapsed')} ${formatElapsed(task.executed_at, now)}` : '—'}
              </span>
              <button className={css.button} onClick={() => { onCancel(task.id) }}>
                {t('taskCancel')}
              </button>
            </div>
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

export function OffpeakPanel({ t }: OffpeakPanelProps): React.ReactNode {
  const [state, setState] = useState<PanelOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  const queue = state.pending

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <span className={`${css.badge} ${state.phase === 'peak' ? css.badgePeak : css.badgeOffpeak}`}>
          {state.phase === 'peak' ? t('phasePeak') : t('phaseOffpeak')}
        </span>
        {state.nextOffPeak !== null && (
          <span className={css.muted} style={{ fontSize: 12 }}>
            {t('nextOffpeak')}: {state.nextOffPeak}
          </span>
        )}
        <span className={css.spacer} />
        <button
          className={css.button}
          disabled={loading}
          title={t('refresh')}
          onClick={() => { void load() }}
        >
          <span className={css.refreshWrap}>
            <img className={css.refreshImg} src={refreshBlack} alt="" draggable={false} />
            <img className={`${css.refreshImg} ${css.refreshDark}`} src={refreshWhite} alt="" draggable={false} />
          </span>
        </button>
      </div>

      {error !== null && <div className={css.error} role="alert">{error}</div>}

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
        <TaskList tasks={queue} t={t} onCancel={(id) => { void cancel(id) }} />
      </div>
    </div>
  )
}
