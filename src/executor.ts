/**
 * 异步执行器：并发控制、单层指数退避重试、按请求发起时刻计费、
 * 跨入高峰自动挂起、本地持久化错误绝不重试、优雅关闭。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { computeCosts, type Usage } from './billing.js'
import { ApiError, CancelledError, DeepSeekClient } from './client.js'
import { resolveResultsDir, type Config, type PricingEntry } from './config.js'
import { type TaskPayload, type TaskRow, TaskStore } from './db.js'
import { CancelledSessionError, SessionOutputError, type SessionRunner } from './session-runner.js'
import { isPeak, parsePeakHours, shouldStopBeforePeak, type PeakWindow } from './time.js'

export type CoreEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'task-submitted'; task: TaskRow }
  | { type: 'task-started'; task: TaskRow }
  | { type: 'task-completed'; task: TaskRow }
  | { type: 'task-failed'; task: TaskRow; error: string }
  | { type: 'task-paused'; task: TaskRow; reason: string }
  | { type: 'task-cancelled'; task: TaskRow }
  | { type: 'task-stream'; taskId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'window-changed'; phase: 'peak' | 'offpeak'; at: string }
  | { type: 'drain-started'; count: number }
  | { type: 'stale-tasks'; count: number }

export interface ExecutorHooks {
  onEvent?: (event: CoreEvent) => void
  /** 插件/核心正在关闭时禁止一切重试。 */
  isClosed?: () => boolean
  /** 会话内执行器（B 方案）；缺失时回退 direct 模式。 */
  sessionRunner?: SessionRunner
}

/** 动态信号量：limit 变化即时生效（max_concurrency 热更新）。 */
class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly getLimit: () => number) {}

  async acquire(): Promise<() => void> {
    while (this.active >= this.getLimit()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

export class TaskExecutor {
  private readonly semaphore: Semaphore
  private readonly inFlight = new Map<string, AbortController>()
  private readonly settling = new Set<Promise<void>>()

  constructor(
    private readonly store: TaskStore,
    private readonly client: DeepSeekClient,
    private readonly getConfig: () => Config,
    private readonly hooks: ExecutorHooks = {},
  ) {
    this.semaphore = new Semaphore(() => this.config.max_concurrency)
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

  private get closed(): boolean {
    return this.hooks.isClosed?.() ?? false
  }

  /** 拉取一批待执行任务（空闲时段 + 未进入高峰前停止派发区间）。 */
  async drain(): Promise<number> {
    const now = new Date()
    if (shouldStopBeforePeak(now, this.windows, this.config.timezone_offset_hours, this.config.stop_before_peak_minutes)) {
      return 0
    }
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

  /** 执行单个任务：原子认领；非实时任务在高峰/高峰前停止派发区间内不认领。 */
  async runTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (task === null || task.status !== 'pending') return
    const now = new Date()
    if (
      task.priority !== 0
      && shouldStopBeforePeak(now, this.windows, this.config.timezone_offset_hours, this.config.stop_before_peak_minutes)
    ) {
      // 未到可执行窗口，保持 pending 等待下一次 drain
      return
    }

    const release = await this.semaphore.acquire()
    try {
      const claimed = this.store.claimTask(taskId, now.toISOString())
      if (claimed === null) return // 已被其他进程/实例认领
      this.emit({ type: 'task-started', task: claimed })

      const controller = new AbortController()
      this.inFlight.set(taskId, controller)
      const run = this.executeWithRetries(claimed, controller.signal)
      this.settling.add(run)
      try {
        await run
      } finally {
        this.settling.delete(run)
        this.inFlight.delete(taskId)
      }
    } finally {
      release()
    }
  }

  /** 取消在途请求（running 任务）。 */
  abortTask(taskId: string): boolean {
    const controller = this.inFlight.get(taskId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** 停止时中止所有在途请求并等待收尾。 */
  async abortAllAndSettle(): Promise<void> {
    for (const controller of this.inFlight.values()) controller.abort()
    await Promise.allSettled([...this.settling])
  }

  private async executeWithRetries(task: TaskRow, signal: AbortSignal): Promise<void> {
    const payload = parsePayload(task.payload)
    const model = payload.model ?? this.config.default_model
    const pricing = this.pricingFor(model)
    const isRealtime = task.priority === 0
    const useSession = this.config.execution_mode === 'session' && this.hooks.sessionRunner !== undefined

    for (let attempt = 0; ; attempt++) {
      if (this.closed) {
        this.fail(task.id, '插件正在关闭，任务终止', 'shutdown')
        return
      }
      if (!isRealtime && shouldStopBeforePeak(new Date(), this.windows, this.config.timezone_offset_hours, this.config.stop_before_peak_minutes)) {
        this.pause(task.id, '已进入高峰时段或高峰前停止派发区间，暂停等待下一空闲窗口')
        return
      }

      try {
        const result = useSession
          ? await this.runInSession(task, payload, model, signal)
          : await this.runDirect(task, payload, model, signal)
        const startedAt = result.startedAt
        const usage: Usage = {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_hit_tokens: result.usage.cache_hit_tokens,
        }
        // 计费时段以“请求发起时刻”为准，而非完成时刻（DeepSeek 服务端口径）
        const effectiveDiscount = isPeak(startedAt, this.windows, this.config.timezone_offset_hours)
          ? 1
          : this.config.discount_rate
        const costs = computeCosts(usage, pricing, effectiveDiscount)
        const resultPath = writeResult(this.config, task.id, payload, result.content)
        this.store.markCompleted(task.id, {
          status: 'completed',
          model,
          completed_at: new Date().toISOString(),
          billed_at: startedAt.toISOString(),
          discount_used: effectiveDiscount,
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
        if (error instanceof CancelledError || error instanceof CancelledSessionError) {
          this.fail(task.id, '请求被取消（用户取消或插件关闭）', 'cancelled')
          return
        }
        if (error instanceof SessionOutputError) {
          this.fail(task.id, error.message, 'api')
          return
        }
        if (error instanceof ApiError) {
          const retryable = error.retryable
          const message = error.message
          const maxRetries = this.config.retry_attempts
          if (
            retryable
            && attempt < maxRetries
            && !this.closed
            && (isRealtime || !shouldStopBeforePeak(new Date(), this.windows, this.config.timezone_offset_hours, this.config.stop_before_peak_minutes))
          ) {
            this.store.bumpRetry(task.id)
            const backoff = this.config.backoff_base_ms * 2 ** attempt * (0.5 + Math.random())
            this.emit({
              type: 'log',
              level: 'warn',
              message: `任务 ${task.id} 第 ${attempt + 1} 次失败，${Math.round(backoff / 1000)}s 后重试：${message}`,
            })
            await sleep(backoff, signal)
            continue
          }
          this.fail(task.id, message, 'api')
          return
        }
        // 非 ApiError = 本地持久化/写盘错误：API 已成功，绝不重试（避免二次扣费）
        const message = error instanceof Error ? error.message : String(error)
        this.fail(task.id, `本地持久化错误（API 已返回，未重试）：${message}`, 'local')
        return
      }
    }
  }

  private async runDirect(
    task: TaskRow,
    payload: TaskPayload,
    model: string,
    signal: AbortSignal,
  ): Promise<{
    content: string
    usage: { input_tokens: number; output_tokens: number; cache_hit_tokens: number }
    startedAt: Date
  }> {
    const result = await this.client.chat(
      {
        model,
        messages: [{ role: 'user', content: payload.prompt }],
        temperature: payload.params?.temperature,
        max_tokens: payload.params?.max_tokens,
      },
      signal,
    )
    return {
      content: result.content,
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_hit_tokens: result.usage.cache_hit_tokens,
      },
      startedAt: result.startedAt,
    }
  }

  private async runInSession(
    task: TaskRow,
    payload: TaskPayload,
    model: string,
    signal: AbortSignal,
  ): Promise<{
    content: string
    usage: { input_tokens: number; output_tokens: number; cache_hit_tokens: number }
    startedAt: Date
  }> {
    const runner = this.hooks.sessionRunner
    if (runner === undefined) {
      throw new SessionOutputError('会话内执行器不可用')
    }
    const result = await runner.runTask(payload, signal, model, (delta) => {
      this.emit({ type: 'task-stream', taskId: task.id, kind: delta.kind, text: delta.text })
    })
    return {
      content: result.content,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_hit_tokens: result.usage.cacheReadTokens,
      },
      startedAt: new Date(),
    }
  }

  private fail(taskId: string, message: string, kind: 'api' | 'local' | 'cancelled' | 'shutdown'): void {
    this.store.markFailed(taskId, message, new Date().toISOString())
    this.emit({ type: 'task-failed', task: this.requireTask(taskId), error: message })
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

function writeResult(config: Config, taskId: string, payload: TaskPayload, content: string): string {
  let resultPath: string
  if (payload.output_path && payload.output_path.trim() !== '') {
    resultPath = path.resolve(payload.output_path)
  } else {
    resultPath = path.join(resolveResultsDir(config), `${taskId}.md`)
  }
  mkdirSync(path.dirname(resultPath), { recursive: true })
  writeFileSync(resultPath, content, 'utf8')
  return resultPath
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
