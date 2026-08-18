/**
 * SQLite 持久化层：任务表、计费日志表、配置表。
 *
 * 使用 Node 内置 node:sqlite（Node >= 22.13 免 flag，DSH 要求 22.19+），
 * 零原生依赖，安装到任何 DSH profile 都不需要编译原生模块。
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { PricingEntry } from './config.js'

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface TaskPayload {
  prompt: string
  model?: string
  params?: {
    temperature?: number
    max_tokens?: number
  }
  session_id?: string
  title?: string
  output_path?: string
}

export interface TaskRow {
  id: string
  payload: string
  priority: number
  status: TaskStatus
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
  price_snapshot: string | null
  error_msg: string | null
  result_path: string | null
}

export interface BillingRow {
  id: number
  task_id: string
  model: string
  created_at: string
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
}

export interface CompletionPatch {
  status: 'completed'
  completed_at: string
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  price_snapshot: PricingEntry
  result_path: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  executed_at TEXT,
  completed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cost_actual REAL NOT NULL DEFAULT 0,
  cost_baseline REAL NOT NULL DEFAULT 0,
  savings REAL NOT NULL DEFAULT 0,
  price_snapshot TEXT,
  error_msg TEXT,
  result_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks(priority, created_at);

CREATE TABLE IF NOT EXISTS billing_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cost_actual REAL NOT NULL DEFAULT 0,
  cost_baseline REAL NOT NULL DEFAULT 0,
  savings REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_billing_created ON billing_logs(created_at);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

function row<T>(db: DatabaseSync, sql: string, params: Record<string, SQLInputValue> = {}): T | undefined {
  return db.prepare(sql).get(params) as T | undefined
}

function all<T>(db: DatabaseSync, sql: string, params: Record<string, SQLInputValue> = {}): T[] {
  return db.prepare(sql).all(params) as T[]
}

export class TaskStore {
  constructor(private readonly db: DatabaseSync) {}

  createTask(task: {
    id: string
    payload: TaskPayload
    priority: number
    created_at: string
  }): TaskRow {
    this.db
      .prepare(
        `INSERT INTO tasks (id, payload, priority, status, created_at)
         VALUES (@id, @payload, @priority, 'pending', @created_at)`,
      )
      .run({
        '@id': task.id,
        '@payload': JSON.stringify(task.payload),
        '@priority': task.priority,
        '@created_at': task.created_at,
      })
    const created = this.getTask(task.id)
    if (created === null) throw new Error('offpeak-saver: 任务写入后未能读取')
    return created
  }

  getTask(id: string): TaskRow | null {
    return row<TaskRow>(this.db, 'SELECT * FROM tasks WHERE id = @id', { '@id': id }) ?? null
  }

  listPending(): TaskRow[] {
    return all<TaskRow>(
      this.db,
      `SELECT * FROM tasks
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC`,
    )
  }

  listByStatus(status: TaskStatus): TaskRow[] {
    return all<TaskRow>(
      this.db,
      'SELECT * FROM tasks WHERE status = @status ORDER BY created_at ASC',
      { '@status': status },
    )
  }

  markRunning(id: string, executedAt: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'running', executed_at = COALESCE(executed_at, @executedAt)
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ '@id': id, '@executedAt': executedAt })
  }

  markPaused(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'paused', error_msg = @reason
         WHERE id = @id AND status IN ('pending', 'running')`,
      )
      .run({ '@id': id, '@reason': reason })
  }

  /** 空闲时段开始：把暂停的任务重新放回待执行队列。 */
  requeuePaused(): number {
    return this.db
      .prepare(`UPDATE tasks SET status = 'pending', error_msg = NULL WHERE status = 'paused'`)
      .run().changes as number
  }

  bumpRetry(id: string): void {
    this.db
      .prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = @id')
      .run({ '@id': id })
  }

  markCompleted(id: string, patch: CompletionPatch): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE tasks SET
             status = 'completed',
             completed_at = @completed_at,
             input_tokens = @input_tokens,
             output_tokens = @output_tokens,
             cache_hit_tokens = @cache_hit_tokens,
             cost_actual = @cost_actual,
             cost_baseline = @cost_baseline,
             savings = @savings,
             price_snapshot = @price_snapshot,
             result_path = @result_path,
             error_msg = NULL
           WHERE id = @id`,
        )
        .run({
          '@id': id,
          '@completed_at': patch.completed_at,
          '@input_tokens': patch.input_tokens,
          '@output_tokens': patch.output_tokens,
          '@cache_hit_tokens': patch.cache_hit_tokens,
          '@cost_actual': patch.cost_actual,
          '@cost_baseline': patch.cost_baseline,
          '@savings': patch.savings,
          '@price_snapshot': JSON.stringify(patch.price_snapshot),
          '@result_path': patch.result_path,
        })
      this.addBillingLog({
        task_id: id,
        model: this.modelOf(id),
        created_at: patch.completed_at,
        input_tokens: patch.input_tokens,
        output_tokens: patch.output_tokens,
        cache_hit_tokens: patch.cache_hit_tokens,
        cost_actual: patch.cost_actual,
        cost_baseline: patch.cost_baseline,
        savings: patch.savings,
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markFailed(id: string, errorMsg: string, completedAt: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error_msg = @errorMsg, completed_at = @completedAt
         WHERE id = @id`,
      )
      .run({ '@id': id, '@errorMsg': errorMsg, '@completedAt': completedAt })
  }

  cancel(id: string): TaskRow | null {
    const task = this.getTask(id)
    if (task === null) return null
    if (task.status === 'pending' || task.status === 'paused') {
      this.db
        .prepare(`UPDATE tasks SET status = 'cancelled', error_msg = 'cancelled by user' WHERE id = @id`)
        .run({ '@id': id })
      return this.getTask(id)
    }
    return task
  }

  retry(id: string): TaskRow | null {
    const task = this.getTask(id)
    if (task === null || task.status !== 'failed') return null
    this.db
      .prepare(
        `UPDATE tasks SET status = 'pending', error_msg = NULL, retry_count = 0, executed_at = NULL, completed_at = NULL
         WHERE id = @id`,
      )
      .run({ '@id': id })
    return this.getTask(id)
  }

  countPending(): number {
    const result = row<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`)
    return result?.n ?? 0
  }

  countStale(beforeIso: string): number {
    const result = row<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'paused') AND created_at < @beforeIso`,
      { '@beforeIso': beforeIso },
    )
    return result?.n ?? 0
  }

  addBillingLog(log: Omit<BillingRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO billing_logs
           (task_id, model, created_at, input_tokens, output_tokens, cache_hit_tokens, cost_actual, cost_baseline, savings)
         VALUES
           (@task_id, @model, @created_at, @input_tokens, @output_tokens, @cache_hit_tokens, @cost_actual, @cost_baseline, @savings)`,
      )
      .run({
        '@task_id': log.task_id,
        '@model': log.model,
        '@created_at': log.created_at,
        '@input_tokens': log.input_tokens,
        '@output_tokens': log.output_tokens,
        '@cache_hit_tokens': log.cache_hit_tokens,
        '@cost_actual': log.cost_actual,
        '@cost_baseline': log.cost_baseline,
        '@savings': log.savings,
      })
  }

  billingSince(fromIso: string): {
    executions: number
    input_tokens: number
    output_tokens: number
    cache_hit_tokens: number
    cost_actual: number
    cost_baseline: number
    savings: number
  } {
    const result = row<{
      executions: number
      input_tokens: number
      output_tokens: number
      cache_hit_tokens: number
      cost_actual: number
      cost_baseline: number
      savings: number
    }>(
      this.db,
      `SELECT
         COUNT(*) AS executions,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
         COALESCE(SUM(cost_actual), 0) AS cost_actual,
         COALESCE(SUM(cost_baseline), 0) AS cost_baseline,
         COALESCE(SUM(savings), 0) AS savings
       FROM billing_logs WHERE created_at >= @fromIso`,
      { '@fromIso': fromIso },
    )
    return (
      result ?? {
        executions: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_hit_tokens: 0,
        cost_actual: 0,
        cost_baseline: 0,
        savings: 0,
      }
    )
  }

  taskCountsSince(fromIso: string): { completed: number; failed: number } {
    const result = row<{ completed: number; failed: number }>(
      this.db,
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM tasks WHERE completed_at >= @fromIso`,
      { '@fromIso': fromIso },
    )
    return result ?? { completed: 0, failed: 0 }
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ '@key': key, '@value': value })
  }

  getConfig(key: string): string | null {
    const result = row<{ value: string }>(this.db, 'SELECT value FROM config WHERE key = @key', { '@key': key })
    return result?.value ?? null
  }

  private modelOf(taskId: string): string {
    const task = this.getTask(taskId)
    if (task === null) return 'unknown'
    try {
      const payload = JSON.parse(task.payload) as TaskPayload
      return payload.model ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
