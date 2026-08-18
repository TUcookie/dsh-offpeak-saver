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
  resolveApiKey,
  resolveDbPath,
  saveOverrides,
  type Config,
  type ConfigPatch,
} from './config.js'
import { DeepSeekClient } from './client.js'
import { openDatabase, TaskStore, type TaskPayload, type TaskRow } from './db.js'
import { TaskExecutor, type CoreEvent } from './executor.js'
import { buildReport, renderReport, type ReportPeriod, type SavingsReport } from './reports.js'
import { isPeak, nextOffPeakStart, parsePeakHours, type PeakWindow } from './time.js'

export type { CoreEvent, ReportPeriod, SavingsReport }

export interface CoreHooks {
  onEvent?: (event: CoreEvent) => void
}

export type Priority = 0 | 1 | 2

export interface SubmitInput {
  prompt: string
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
  status: TaskRow['status']
  created_at: string
  executed_at: string | null
  completed_at: string | null
  retry_count: number
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
  private lastPhase: 'peak' | 'offpeak' | null = null
  private draining = false
  private closed = false

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
      baseUrl: this.config.base_url,
      apiKey: resolveApiKey(this.config),
      timeoutMs: this.config.request_timeout_ms,
      retryAttempts: this.config.retry_attempts,
      backoffBaseMs: this.config.backoff_base_ms,
    })
    this.executor = new TaskExecutor(this.store, this.client, () => this.config, {
      onEvent: (event) => this.hooks.onEvent?.(event),
    })
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), this.config.check_interval_ms)
    this.tick()
    this.staleCheck()
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.db.close()
  }

  get currentConfig(): Config {
    return this.config
  }

  /** 提交任务。priority 0 = 立即执行，1 = 错峰，2 = 后台错峰。 */
  async submitTask(input: SubmitInput, priority: Priority): Promise<SubmitResult> {
    const task = this.store.createTask({
      id: randomUUID(),
      payload: {
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        session_id: input.session_id,
        output_path: input.output_path,
        params: input.params,
      },
      priority,
      created_at: new Date().toISOString(),
    })
    this.hooks.onEvent?.({ type: 'task-submitted', task })

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

  getTask(id: string): TaskView | null {
    const task = this.store.getTask(id)
    return task === null ? null : this.toView(task)
  }

  cancelTask(id: string): TaskRow | null {
    const task = this.store.cancel(id)
    if (task !== null && task.status === 'cancelled') {
      this.hooks.onEvent?.({ type: 'task-cancelled', task })
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
      config: this.config,
      overrides: loadOverrides(this.config),
    }
  }

  /** 热更新配置（仅允许白名单键），写入 config.json 并立即生效。 */
  updateSetting(key: string, rawValue: string): { key: string; value: unknown } {
    if (!isHotKey(key)) {
      throw new Error(`offpeak-saver: 不允许热更新配置项 "${key}"`)
    }
    const value = sanitizeValue(key, rawValue)
    const patch: ConfigPatch = { [key]: value } as ConfigPatch
    this.config = {
      ...this.config,
      ...patch,
      pricing: key === 'pricing' ? { ...this.config.pricing, ...(patch.pricing ?? {}) } : this.config.pricing,
    }
    if (key === 'peak_hours' || key === 'discount_rate' || key === 'timezone_offset_hours') {
      this.windows = parsePeakHours(this.config.peak_hours)
    }
    saveOverrides(this.config, patch)
    this.store.setConfig(key, JSON.stringify(value))
    this.hooks.onEvent?.({ type: 'log', level: 'info', message: `配置已热更新：${key} = ${JSON.stringify(value)}` })
    return { key, value }
  }

  countPending(): number {
    return this.store.countPending()
  }

  /** 下一个空闲时段开始信息（供 UI 提示）。 */
  nextOffPeak(): { minutes: number; label: string; at: Date } | null {
    return nextOffPeakStart(new Date(), this.windows, this.config.timezone_offset_hours)
  }

  private tick(): void {
    const now = new Date()
    const phase: 'peak' | 'offpeak' = isPeak(now, this.windows, this.config.timezone_offset_hours) ? 'peak' : 'offpeak'
    if (this.lastPhase !== phase) {
      this.lastPhase = phase
      this.hooks.onEvent?.({ type: 'window-changed', phase, at: now.toISOString() })
    }
    if (phase === 'offpeak' && !this.draining) {
      this.draining = true
      void this.executor.drain().finally(() => {
        this.draining = false
      })
    }
  }

  private staleCheck(): void {
    const threshold = new Date(Date.now() - this.config.stale_hours * 3_600_000).toISOString()
    const count = this.store.countStale(threshold)
    if (count > 0) {
      this.hooks.onEvent?.({ type: 'stale-tasks', count })
    }
  }

  private toView(task: TaskRow): TaskView {
    const payload = parsePayload(task.payload)
    return {
      id: task.id,
      title: payload.title ?? '未命名任务',
      model: payload.model ?? this.config.default_model,
      priority: task.priority,
      status: task.status,
      created_at: task.created_at,
      executed_at: task.executed_at,
      completed_at: task.completed_at,
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

function sanitizeValue(key: string, rawValue: string): unknown {
  let parsed: unknown = rawValue
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    parsed = rawValue
  }

  switch (key) {
    case 'peak_hours': {
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('offpeak-saver: peak_hours 必须是字符串数组，如 ["09:00-12:00","14:00-18:00"]')
      }
      parsePeakHours(parsed as string[])
      return parsed
    }
    case 'pricing': {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('offpeak-saver: pricing 必须是模型价格对象')
      }
      return parsed
    }
    case 'discount_rate': {
      const n = Number(parsed)
      if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error('offpeak-saver: discount_rate 必须在 (0, 1] 之间')
      return n
    }
    case 'currency': {
      if (parsed !== 'CNY' && parsed !== 'USD') throw new Error('offpeak-saver: currency 只能是 CNY 或 USD')
      return parsed
    }
    case 'notify': {
      if (typeof parsed !== 'boolean') throw new Error('offpeak-saver: notify 必须是布尔值')
      return parsed
    }
    case 'timezone_offset_hours':
    case 'max_concurrency':
    case 'retry_attempts':
    case 'backoff_base_ms':
    case 'request_timeout_ms':
    case 'stop_before_peak_minutes':
    case 'check_interval_ms':
    case 'stale_hours': {
      const n = Number(parsed)
      if (!Number.isFinite(n) || n < 0) throw new Error(`offpeak-saver: ${key} 必须是正数`)
      return n
    }
    default:
      if (typeof parsed !== 'string') throw new Error(`offpeak-saver: ${key} 必须是字符串`)
      return parsed
  }
}
