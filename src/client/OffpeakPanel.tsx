/** 错峰省钱面板：待执行任务、历史账单、节省金额。 */

import { useEffect, useMemo, useState } from 'react'
import {
  cancelTask,
  formatClock,
  loadOverview,
  money,
  moveQueuedTask,
  setMaxConcurrency,
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

function queuePositionLabel(position: number, t: (key: keyof typeof zh) => string): string {
  return t('queuePosition').replace('{position}', String(position))
}

function TaskList({ tasks, t, onCancel, onMove, moving }: {
  tasks: PanelTask[]
  t: (key: keyof typeof zh) => string
  onCancel: (id: string) => void
  onMove: (id: string, direction: 'up' | 'down') => void
  moving: Set<string>
}): React.ReactNode {
  if (tasks.length === 0) {
    return <div className={css.empty}>{t('queueEmpty')}</div>
  }
  return (
    <ul className={css.taskList}>
      {tasks.map((task) => {
        const peers = tasks.filter((candidate) => candidate.priority === task.priority)
        const position = peers.findIndex((candidate) => candidate.id === task.id)
        const isMoving = moving.has(task.id)
        return (
        <li key={task.id} className={css.taskRow}>
          <div className={css.taskMain}>
            <span className={css.queuePosition}>{queuePositionLabel(position + 1, t)}</span>
            <span className={css.taskTitle} title={task.prompt}>{task.title}</span>
            <span className={`${css.status} ${statusClass(task.status)}`}>{statusLabel(task.status, t)}</span>
          </div>
          <div className={css.taskMeta}>
            <span className={css.muted}>{priorityLabel(task.priority, t)} · {formatClock(task.created_at)}</span>
            {task.status === 'pending' && (
              <span className={css.queueControls}>
                <button
                  className={css.moveButton}
                  disabled={position === 0 || isMoving}
                  aria-label={t('queueMoveUp')}
                  title={t('queueMoveUp')}
                  onClick={() => { onMove(task.id, 'up') }}
                >{t('queueMoveUp')}</button>
                <button
                  className={css.moveButton}
                  disabled={position === peers.length - 1 || isMoving}
                  aria-label={t('queueMoveDown')}
                  title={t('queueMoveDown')}
                  onClick={() => { onMove(task.id, 'down') }}
                >{t('queueMoveDown')}</button>
              </span>
            )}
            {(task.status === 'pending' || task.status === 'paused') && (
              <button className={css.button} onClick={() => { onCancel(task.id) }}>
                {t('taskCancel')}
              </button>
            )}
          </div>
        </li>
        )
      })}
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

function MetricCard({ label, value, tone = 'default' }: {
  label: string
  value: string | number
  tone?: 'default' | 'success' | 'accent'
}): React.ReactNode {
  return (
    <div className={`${css.metricCard} ${tone === 'success' ? css.metricSuccess : tone === 'accent' ? css.metricAccent : ''}`}>
      <div className={css.metricLabel}>{label}</div>
      <div className={css.metricValue}>{value}</div>
    </div>
  )
}

export function OffpeakPanel({ t }: OffpeakPanelProps): React.ReactNode {
  const [state, setState] = useState<PanelOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState<Set<string>>(new Set())
  const [updatingConcurrency, setUpdatingConcurrency] = useState(false)
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

  const move = useMemo(() => async (taskId: string, direction: 'up' | 'down'): Promise<void> => {
    setMoving((previous) => new Set(previous).add(taskId))
    try {
      await moveQueuedTask(taskId, direction)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMoving((previous) => {
        const next = new Set(previous)
        next.delete(taskId)
        return next
      })
    }
  }, [load])

  const updateConcurrency = useMemo(() => async (maxConcurrency: number): Promise<void> => {
    if (state === null || maxConcurrency === state.concurrency.configured) return
    setUpdatingConcurrency(true)
    try {
      const concurrency = await setMaxConcurrency(maxConcurrency)
      setState((previous) => previous === null ? null : { ...previous, concurrency })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdatingConcurrency(false)
    }
  }, [state])

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
      <section className={`${css.hero} ${state.phase === 'peak' ? css.heroPeak : css.heroOffpeak}`}>
        <div className={css.heroTop}>
          <div className={css.heroStatus}>
            <div>
              <div className={css.eyebrow}>{t('nav')}</div>
              <div className={css.heroTitle}>{t('dashboardStatus')}</div>
            </div>
            <span className={`${css.badge} ${state.phase === 'peak' ? css.badgePeak : css.badgeOffpeak}`}>
              <span className={css.statusDot} />
              {state.phase === 'peak' ? t('phasePeak') : t('phaseOffpeak')}
            </span>
          </div>
          <button
            className={`${css.button} ${css.iconButton}`}
            disabled={loading}
            title={t('refresh')}
            aria-label={t('refresh')}
            onClick={() => { void load() }}
          >
            <span className={css.refreshWrap}>
              <img className={css.refreshImg} src={refreshBlack} alt="" draggable={false} />
              <img className={`${css.refreshImg} ${css.refreshDark}`} src={refreshWhite} alt="" draggable={false} />
            </span>
          </button>
        </div>
        <div className={css.heroBody}>
          <p className={css.heroDescription}>
            {state.phase === 'peak' ? t('statusPeakDescription') : t('statusOffpeakDescription')}
          </p>
          <div className={css.heroPlan}>
            <div className={css.planItem}>
              <span>{t('nextRun')}</span>
              <strong>{state.nextOffPeak ?? t('runningInOrder')}</strong>
            </div>
            <div className={css.planItem}>
              <span>{t('queueCount')}</span>
              <strong>{queue.length} {t('statPending')}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className={css.controlCard}>
        <div className={css.controlCopy}>
          <span className={css.controlTitle}>{t('concurrency')}</span>
          <span className={css.controlHint}>{t('concurrencyHint')} {state.concurrency.effective}/{state.concurrency.configured}</span>
        </div>
        <label className={css.concurrency}>
          <input
            aria-label={t('concurrency')}
            type="range"
            min="1"
            max="8"
            step="1"
            value={state.concurrency.configured}
            disabled={updatingConcurrency}
            onChange={(event) => { void updateConcurrency(Number(event.target.value)) }}
          />
          <output className={css.concurrencyValue}>
            {state.concurrency.configured}
          </output>
          {updatingConcurrency && <span className={css.muted}>{t('concurrencyUpdating')}</span>}
        </label>
      </section>

      {error !== null && <div className={css.error} role="alert">{error}</div>}

      <div className={css.metricGrid}>
        <MetricCard label={t('statTodaySavings')} value={money(state.reports.day.savings, state.reports.day.currency)} tone="success" />
        <MetricCard label={t('statWeekSavings')} value={money(state.reports.week.savings, state.reports.week.currency)} tone="success" />
        <MetricCard label={t('statMonthSavings')} value={money(state.reports.month.savings, state.reports.month.currency)} tone="success" />
        <MetricCard label={t('statExecutions')} value={state.reports.day.executions} tone="accent" />
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
          {queue.length > 1 && <span className={css.sectionHint}>{t('queueOrderHint')}</span>}
        </div>
        <TaskList
          tasks={queue}
          t={t}
          moving={moving}
          onCancel={(id) => { void cancel(id) }}
          onMove={(id, direction) => { void move(id, direction) }}
        />
      </div>
    </div>
  )
}
