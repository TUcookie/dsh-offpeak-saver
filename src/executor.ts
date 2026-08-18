/**
 * 异步执行器：并发控制、指数退避重试、跨入高峰自动挂起、结果落盘。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { computeCosts, type Usage } from './billing.js'
import { ApiError, CancelledError, DeepSeekClient } from './client.js'
import { resolveResultsDir, type Config, type PricingEntry } from './config.js'
import { type TaskPayload, type TaskRow, TaskStore } from './db.js'
import { isPeak, parsePeakHours, type PeakWindow } from './time.js'

export type CoreEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'task-submitted'; task: TaskRow }
  | { type: 'task-started'; task: TaskRow }
  | { type: 'task-completed'; task: TaskRow }
  | { type: 'task-failed'; task: TaskRow; error: string }
  | { type: 'task-paused'; task: TaskRow; reason: string }
  | { type: 'task-cancelled'; task: TaskRow }
  | { type: 'window-changed'; phase: 'peak' | 'offpeak'; at: string }
  | { type: 'drain-started'; count: number }
  | { type: 'stale-tasks'; count: number }

export interface ExecutorHooks {
  onEvent?: (event: CoreEvent) => void
}

class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    this.available = Math.max(1, limit)
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return () => {
        this.available++
        this.waiters.shift()?.()
      }
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.available--
    return () => {
      this.available++
      this.waiters.shift()?.()
    }
  }
}

export class TaskExecutor {
  private readonly semaphore: Semaphore

  constructor(
    private readonly store: TaskStore,
    private readonly client: DeepSeekClient,
    private readonly getConfig: () => Config,
    private readonly hooks: ExecutorHooks = {},
  ) {
    this.semaphore = new Semaphore(getConfig().max_concurrency)
  }

  private get config(): Config {
    return this.getConfig()
  }

  private get windows(): PeakWindow[] {
    return parsePeakHours(this.config.peak_hours)
  }

  private emit(event: CoreEvent): void {
    this.hooks.onEvent?.(event)
  }

  /** 拉取一批待执行任务（仅空闲时段），返回启动数量。 */
  async drain(): Promise<number> {
    if (isPeak(new Date(), this.windows, this.config.timezone_offset_hours)) return 0
    const requeued = this.store.requeuePaused()
    if (requeued > 0) {
      this.emit({ type: 'log', level: 'info', message: `已将 ${requeued} 个暂停任务重新加入队列` })
    }
    const pending = this.store.listPending()
    const batch = pending.slice(0, this.config.max_concurrency)
    if (batch.length === 0) return 0
    this.emit({ type: 'drain-started', count: batch.length })
    await Promise.allSettled(batch.map((task) => this.runTask(task.id)))
    return batch.length
  }

  /** 执行单个任务；若已跨入高峰则挂起等待下一窗口。 */
  async runTask(taskId: string): Promise<void> {
    const release = await this.semaphore.acquire()
    try {
      const task = this.store.getTask(taskId)
      if (task === null || task.status !== 'pending') return
      if (isPeak(new Date(), this.windows, this.config.timezone_offset_hours)) {
        this.store.markPaused(taskId, '已进入高峰时段，等待下一空闲窗口')
        this.emit({ type: 'task-paused', task: this.requireTask(taskId), reason: 'peak window' })
        return
      }
      this.store.markRunning(taskId, new Date().toISOString())
      this.emit({ type: 'task-started', task: this.requireTask(taskId) })
      await this.executeWithRetries(task)
    } finally {
      release()
    }
  }

  private async executeWithRetries(task: TaskRow): Promise<void> {
    const payload = parsePayload(task.payload)
    const model = payload.model ?? this.config.default_model
    const pricing = this.pricingFor(model)

    for (let attempt = 0; attempt <= this.config.retry_attempts; attempt++) {
      if (isPeak(new Date(), this.windows, this.config.timezone_offset_hours)) {
        this.pause(task.id, '已跨入高峰时段，暂停等待下一空闲窗口')
        return
      }
      try {
        const result = await this.client.chat(
          {
            model,
            messages: [{ role: 'user', content: payload.prompt }],
            temperature: payload.params?.temperature,
            max_tokens: payload.params?.max_tokens,
          },
        )
        const usage: Usage = {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_hit_tokens: result.usage.cache_hit_tokens,
        }
        const costs = computeCosts(usage, pricing, this.config.discount_rate)
        const resultPath = writeResult(this.config, task.id, result.content ?? '')
        const completedAt = new Date().toISOString()
        this.store.markCompleted(task.id, {
          status: 'completed',
          completed_at: completedAt,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_hit_tokens: usage.cache_hit_tokens,
          cost_actual: costs.cost_actual,
          cost_baseline: costs.cost_baseline,
          savings: costs.savings,
          price_snapshot: costs.price_snapshot,
          result_path: resultPath,
        })
        this.emit({ type: 'task-completed', task: this.requireTask(task.id) })
        return
      } catch (error) {
        if (error instanceof CancelledError) {
          this.store.markFailed(task.id, '任务被取消', new Date().toISOString())
          this.emit({ type: 'task-failed', task: this.requireTask(task.id), error: 'cancelled' })
          return
        }
        const retryable = error instanceof ApiError ? error.retryable : true
        const message = error instanceof Error ? error.message : String(error)
        if (attempt < this.config.retry_attempts && retryable && !isPeak(new Date(), this.windows, this.config.timezone_offset_hours)) {
          this.store.bumpRetry(task.id)
          const backoff = this.config.backoff_base_ms * 2 ** attempt * (0.5 + Math.random())
          this.emit({ type: 'log', level: 'warn', message: `任务 ${task.id} 第 ${attempt + 1} 次失败，${Math.round(backoff / 1000)}s 后重试：${message}` })
          await sleep(backoff)
          continue
        }
        this.store.markFailed(task.id, message, new Date().toISOString())
        this.emit({ type: 'task-failed', task: this.requireTask(task.id), error: message })
        return
      }
    }
  }

  private pause(taskId: string, reason: string): void {
    this.store.markPaused(taskId, reason)
    this.emit({ type: 'task-paused', task: this.requireTask(taskId), reason })
  }

  private pricingFor(model: string): PricingEntry {
    const entry = this.config.pricing[model]
    if (entry !== undefined) return entry
    const fallback = this.config.pricing[this.config.default_model] ?? { input: 3.0, input_cache_hit: 0.1, output: 9.0 }
    this.emit({ type: 'log', level: 'warn', message: `模型 ${model} 未配置价格，已按 ${this.config.default_model} 价格估算` })
    return fallback
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

function writeResult(config: Config, taskId: string, content: string): string {
  const dir = resolveResultsDir(config)
  mkdirSync(dir, { recursive: true })
  const resultPath = path.join(dir, `${taskId}.md`)
  writeFileSync(resultPath, content, 'utf8')
  return resultPath
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
