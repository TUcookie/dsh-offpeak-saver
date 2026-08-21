/**
 * 核心门面：把数据库、执行器、调度循环、配置热更新组合成一个可独立使用的对象。
 * 既被 dsh 插件入口调用，也可被 CLI / 测试直接使用。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  isHotKey,
  loadOverrides,
  mergeConfig,
  resolveDbPath,
  sanitizeHotValue,
  saveOverrides,
  type Config,
  type ConfigPatch,
} from './config.js'
import { DeepSeekClient } from './client.js'
import { openDatabase, TaskStore, type TaskPayload, type TaskRow } from './db.js'
import { TaskExecutor, type CoreEvent } from './executor.js'
import { buildReport, renderReport, type ReportPeriod, type SavingsReport } from './reports.js'
import type { SessionRunner } from './session-runner.js'
import { isPeak, nextOffPeakStart, parsePeakHours, type PeakWindow } from './time.js'

export type { CoreEvent, ReportPeriod, SavingsReport }

export interface CoreHooks {
  onEvent?: (event: CoreEvent) => void
  /** 解析 API Key 的钩子；dsh 环境通过 credentials 服务提供，CLI/测试可留空。 */
  apiKeyResolver?: () => Promise<string | undefined>
  /** 时钟注入（测试用）。 */
  now?: () => Date
  /** 会话内执行器（B 方案）；dsh 环境传入，CLI/测试可留空回退 direct。 */
  sessionRunner?: SessionRunner
}

export type Priority = 0 | 1 | 2

export interface SubmitInput {
  prompt: string
  /** 任务执行时的工作目录（独立会话的 cwd，避免 {{cwd}} 无值）。 */
  cwd?: string
  title?: string
  model?: string
  session_id?: string
  output_path?: string
  params?: {
    temperature?: number
    max_tokens?: number
  }
}

export interface SubmitResult {
  task: TaskRow
  /** 实时任务直接执行后的结果摘要 */
  immediate?: {
    content: string
    cost_actual: number
    savings: number
  }
}

export interface TaskView {
  id: string
  title: string
  model: string
  priority: number
  queue_order: number
  status: TaskRow['status']
  created_at: string
  executed_at: string | null
  completed_at: string | null
  retry_count: number
  billed_at: string | null
  discount_used: number
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  error_msg: string | null
  result_path: string | null
  prompt: string
}

export class OffPeakSaver {
  private config: Config
  private db: ReturnType<typeof openDatabase>
  private readonly store: TaskStore
  private readonly client: DeepSeekClient
  private readonly executor: TaskExecutor
  private windows: PeakWindow[]
  private timer: NodeJS.Timeout | null = null
  private windowWakeTimer: NodeJS.Timeout | null = null
  private lastPhase: 'peak' | 'offpeak' | null = null
  private draining = false
  private closed = false
  private stopping = false
  private readonly listeners = new Set<(event: CoreEvent) => void>()

  constructor(pluginConfig: Partial<Config>, private readonly hooks: CoreHooks = {}) {
    const base = mergeConfig(pluginConfig)
    const overrides = loadOverrides(base)
    this.config = {
      ...base,
      ...overrides,
      pricing: { ...base.pricing, ...(overrides.pricing ?? {}) },
    }
    this.windows = parsePeakHours(this.config.peak_hours)
    this.db = openDatabase(resolveDbPath(this.config))
    this.store = new TaskStore(this.db)
    this.client = new DeepSeekClient({
      getBaseUrl: () => this.config.base_url,
      getTimeoutMs: () => this.config.request_timeout_ms,
      apiKey: this.config.api_key,
      apiKeyResolver: this.hooks.apiKeyResolver,
      now: this.hooks.now,
    })
    this.executor = new TaskExecutor(this.store, this.client, () => this.config, {
      isClosed: () => this.closed || this.stopping,
      sessionRunner: this.hooks.sessionRunner,
      onEvent: (event) => this.emit(event),
    })
  }

  private emit(event: CoreEvent): void {
    if (this.config.notify === false && isNotifyEvent(event.type)) return
    this.hooks.onEvent?.(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 订阅者异常不影响主流程
      }
    }
  }

  /** 订阅核心事件（面板 SSE 等）；返回取消订阅函数。 */
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.closed) {
      throw new Error('offpeak-saver: 插件已关闭，不能重新 start')
    }
    if (this.timer !== null) return
    this.recoverCrashedTasks()
    this.timer = setInterval(() => this.tick(), this.config.check_interval_ms)
    this.tick()
    this.scheduleNextOffPeakWake()
    this.staleCheck()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopping = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.windowWakeTimer !== null) {
      clearTimeout(this.windowWakeTimer)
      this.windowWakeTimer = null
    }
    await this.executor.abortAllAndSettle()
    this.store.close()
    this.db.close()
  }

  get currentConfig(): Config {
    return this.config
  }

  /** 面板展示：用户设置上限与调度器当前实际派发上限。 */
  getConcurrency(): { configured: number; effective: number } {
    return { configured: this.config.max_concurrency, effective: this.executor.effectiveConcurrency }
  }

  /** 提交任务。priority 0 = 立即执行，1 = 错峰，2 = 后台错峰。 */
  async submitTask(input: SubmitInput, priority: Priority): Promise<SubmitResult> {
    const task = this.createQueuedTask(input, priority)

    if (priority === 0) {
      await this.executor.runTask(task.id)
      const final = this.requireTask(task.id)
      if (final.status === 'completed' && final.result_path !== null) {
        const content = readResult(final.result_path)
        return {
          task: final,
          immediate: {
            content,
            cost_actual: final.cost_actual,
            savings: final.savings,
          },
        }
      }
      return { task: final }
    }
    return { task }
  }

  /** 只入队、不执行（供自动分流：先拿到任务 ID 再决定立即执行或排队）。 */
  createQueuedTask(input: SubmitInput, priority: Priority): TaskRow {
    const prompt = input.prompt.trim()
    if (prompt === '') {
      throw new Error('offpeak-saver: 任务 prompt 不能为空')
    }
    const task = this.store.createTask({
      id: randomUUID(),
      payload: {
        prompt,
        cwd: input.cwd,
        title: (() => {
          const raw = input.title?.trim()
          return raw !== undefined && raw !== '' ? raw : autoTitle(prompt)
        })(),
        model: input.model,
        session_id: input.session_id,
        output_path: input.output_path,
        params: input.params,
      },
      priority,
      created_at: new Date().toISOString(),
    })
    this.emit({ type: 'task-submitted', task })
    return task
  }

  /** 把已入队（pending/paused）的任务提级为实时并立即执行。 */
  async runTaskNow(id: string): Promise<TaskRow | null> {
    const task = this.store.getTask(id)
    if (task === null || (task.status !== 'pending' && task.status !== 'paused')) return task
    this.store.requeueTask(id)
    this.store.setPriority(id, 0)
    await this.executor.runTask(id)
    return this.requireTask(id)
  }

  /**
   * 错峰时段：任务直接复用当前会话执行（auto-route 已放行消息）。
   * 这里把任务标记为“本地已认领”，避免调度器再把它当 pending 重复执行；
   * 完成后的 token 用量由当前会话回填（见回填接口）。
   */
  markTaskStartedLocally(id: string): void {
    const task = this.store.getTask(id)
    if (task === null || task.status !== 'pending') return
    this.store.markRunning(id, new Date().toISOString())
  }

  getTask(id: string): TaskView | null {
    const task = this.store.getTask(id)
    return task === null ? null : this.toView(task)
  }

  /** 同优先级队列位置，供高峰确认和提交回执展示。 */
  getQueuePosition(id: string): { position: number; total: number } | null {
    return this.store.queuePosition(id)
  }

  /** 仪表盘操作：仅同优先级、pending 任务可上移或下移。 */
  moveQueuedTask(id: string, direction: 'up' | 'down'): TaskRow | null {
    const moved = this.store.movePendingTask(id, direction)
    if (moved !== null && moved.status === 'pending') {
      this.emit({ type: 'log', level: 'info', message: `已调整任务 ${id} 的队列顺序` })
    }
    return moved
  }

  cancelTask(id: string): TaskRow | null {
    const task = this.store.getTask(id)
    if (task === null) return null
    if (task.status === 'pending' || task.status === 'paused') {
      const cancelled = this.store.cancel(id)
      if (cancelled !== null) {
        this.emit({ type: 'task-cancelled', task: cancelled })
      }
      return cancelled
    }
    if (task.status === 'running') {
      // 中止在途请求；执行器收尾时会把它标记为 failed(cancelled)
      this.executor.abortTask(id)
    }
    return task
  }

  retryTask(id: string): TaskRow | null {
    return this.store.retry(id)
  }

  getReport(period: ReportPeriod = 'day'): SavingsReport {
    return buildReport(this.store, this.config, new Date(), period)
  }

  renderReport(period: ReportPeriod = 'day'): string {
    return renderReport(this.getReport(period))
  }

  getSettings(): { config: Config; overrides: ConfigPatch } {
    return {
      config: { ...this.config, api_key: maskApiKey(this.config.api_key) },
      overrides: loadOverrides(this.config),
    }
  }

  /** 热更新配置（仅允许白名单键），写入 config.json 并立即生效。 */
  updateSetting(key: string, rawValue: string): { key: string; value: unknown } {
    if (!isHotKey(key)) {
      throw new Error(`offpeak-saver: 不允许热更新配置项 "${key}"`)
    }
    const value = sanitizeHotValue(key, rawValue)
    const patch: ConfigPatch = { [key]: value } as ConfigPatch
    this.config = {
      ...this.config,
      ...patch,
      pricing: key === 'pricing' ? { ...this.config.pricing, ...(patch.pricing ?? {}) } : this.config.pricing,
    }
    if (key === 'peak_hours' || key === 'discount_rate' || key === 'timezone_offset_hours') {
      this.windows = parsePeakHours(this.config.peak_hours)
    }
    if (key === 'check_interval_ms' && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = setInterval(() => this.tick(), this.config.check_interval_ms)
    }
    if (key === 'peak_hours' || key === 'timezone_offset_hours' || key === 'stop_before_peak_minutes') {
      this.scheduleNextOffPeakWake()
    }
    saveOverrides(this.config, patch)
    this.store.setConfig(key, JSON.stringify(value))
    this.emit({ type: 'log', level: 'info', message: `配置已热更新：${key} = ${JSON.stringify(value)}` })
    return { key, value }
  }

  countPending(): number {
    return this.store.countPending()
  }

  /** 面板用：待执行 / 运行中 / 最近任务一览。 */
  listTasks(): { pending: TaskView[]; running: TaskView[]; recent: TaskView[] } {
    const pending = this.store.listPending().map((task) => this.toView(task))
    const running = this.store.listByStatus('running').map((task) => this.toView(task))
    const recent = this.store.listRecent(12).map((task) => this.toView(task))
    return { pending, running, recent }
  }

  /** 下一个空闲时段开始信息（供 UI 提示）。 */
  nextOffPeak(): { minutes: number; label: string; at: Date } | null {
    return nextOffPeakStart(new Date(), this.windows, this.config.timezone_offset_hours)
  }

  /** 当前处于高峰还是空闲时段。 */
  currentPhase(): 'peak' | 'offpeak' {
    return isPeak(new Date(), this.windows, this.config.timezone_offset_hours) ? 'peak' : 'offpeak'
  }

  /** 测试辅助：立即执行一轮队列 drain（等价于调度器空闲分支）。 */
  async runPendingNowForTest(): Promise<void> {
    await this.executor.drain()
  }

  private tick(): void {
    const now = new Date()
    const phase: 'peak' | 'offpeak' = isPeak(now, this.windows, this.config.timezone_offset_hours) ? 'peak' : 'offpeak'
    if (this.lastPhase !== phase) {
      this.lastPhase = phase
      this.emit({ type: 'window-changed', phase, at: now.toISOString() })
    }
    if (phase === 'offpeak' && !this.draining) {
      this.draining = true
      void this.executor.drain().finally(() => {
        this.draining = false
      })
    }
    this.scheduleNextOffPeakWake()
  }

  /** 高峰结束点精确唤醒，不必等最长 30 秒的常规轮询。 */
  private scheduleNextOffPeakWake(): void {
    if (this.closed) return
    if (this.windowWakeTimer !== null) {
      clearTimeout(this.windowWakeTimer)
      this.windowWakeTimer = null
    }
    const next = nextOffPeakStart(new Date(), this.windows, this.config.timezone_offset_hours)
    if (next === null) return
    const delay = Math.max(0, next.at.getTime() - Date.now() + 50)
    this.windowWakeTimer = setTimeout(() => {
      this.windowWakeTimer = null
      this.tick()
    }, delay)
  }

  private staleCheck(): void {
    const threshold = new Date(Date.now() - this.config.stale_hours * 3_600_000).toISOString()
    const count = this.store.countStale(threshold)
    if (count > 0) {
      this.emit({ type: 'stale-tasks', count })
    }
  }

  private recoverCrashedTasks(): void {
    const before = new Date(Date.now() - this.config.lease_ms).toISOString()
    const recovered = this.store.recoverStaleRunning(before)
    if (recovered > 0) {
      this.emit({ type: 'log', level: 'warn', message: `已恢复 ${recovered} 个因进程中断而遗留的 running 任务` })
    }
  }

  private toView(task: TaskRow): TaskView {
    const payload = parsePayload(task.payload)
    return {
      id: task.id,
      title: payload.title ?? '未命名任务',
      model: payload.model ?? this.config.default_model,
      priority: task.priority,
      queue_order: task.queue_order,
      status: task.status,
      created_at: task.created_at,
      executed_at: task.executed_at,
      completed_at: task.completed_at,
      billed_at: task.billed_at,
      discount_used: task.discount_used,
      retry_count: task.retry_count,
      input_tokens: task.input_tokens,
      output_tokens: task.output_tokens,
      cache_hit_tokens: task.cache_hit_tokens,
      cost_actual: task.cost_actual,
      cost_baseline: task.cost_baseline,
      savings: task.savings,
      error_msg: task.error_msg,
      result_path: task.result_path,
      prompt: payload.prompt,
    }
  }

  private requireTask(id: string): TaskRow {
    const task = this.store.getTask(id)
    if (task === null) throw new Error(`offpeak-saver: 任务 ${id} 不存在`)
    return task
  }
}

/** 自动标题：取 prompt 前 30 个字符（含 #offpeak 时先剔除标签）。 */
function autoTitle(prompt: string): string {
  const cleaned = prompt.replace(/#\s*(offpeak|batch|realtime)\b/gi, '').trim()
  const source = cleaned === '' ? prompt : cleaned
  return source.length <= 30 ? source : `${source.slice(0, 30)}…`
}

function parsePayload(raw: string): TaskPayload {
  try {
    return JSON.parse(raw) as TaskPayload
  } catch {
    throw new Error('offpeak-saver: 任务 payload 损坏')
  }
}

function readResult(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const NOTIFY_EVENTS = new Set<CoreEvent['type']>([
  'task-started',
  'task-completed',
  'task-failed',
  'task-paused',
  'task-cancelled',
  'stale-tasks',
])

function isNotifyEvent(type: CoreEvent['type']): boolean {
  return NOTIFY_EVENTS.has(type)
}

function maskApiKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 4) return '****'
  return `****${key.slice(-4)}`
}
