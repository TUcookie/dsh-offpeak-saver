/**
 * SQLite 持久化层：任务表、计费日志表、配置表。
 *
 * 使用 Node 内置 node:sqlite（Node >= 22.13 免 flag，DSH 要求 22.19+）。
 * 所有语句在构造时预编译、close() 时统一关闭；任务认领是原子 UPDATE，
 * 支持多进程共享同一数据库时也不会双重执行。
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type { PricingEntry } from './config.js'

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface TaskPayload {
  prompt: string
  /** 任务执行时的工作目录（独立会话 cwd）。 */
  cwd?: string
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
  billed_at: string | null
  claimed_at: string | null
  discount_used: number
}

export interface BillingRow {
  id: number
  task_id: string
  model: string
  created_at: string
  billed_at: string
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  discount_used: number
}

export interface CompletionPatch {
  status: 'completed'
  /** 实际调用的模型 ID（计费日志归属）。 */
  model: string
  completed_at: string
  billed_at: string
  discount_used: number
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
  result_path TEXT,
  billed_at TEXT,
  claimed_at TEXT,
  discount_used REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks(priority, created_at);

CREATE TABLE IF NOT EXISTS billing_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  billed_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  cost_actual REAL NOT NULL DEFAULT 0,
  cost_baseline REAL NOT NULL DEFAULT 0,
  savings REAL NOT NULL DEFAULT 0,
  discount_used REAL NOT NULL DEFAULT 1
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
  ensureColumn(db, 'tasks', 'billed_at', 'TEXT')
  ensureColumn(db, 'tasks', 'claimed_at', 'TEXT')
  ensureColumn(db, 'tasks', 'discount_used', 'REAL NOT NULL DEFAULT 1')
  ensureColumn(db, 'billing_logs', 'billed_at', 'TEXT')
  ensureColumn(db, 'billing_logs', 'discount_used', 'REAL NOT NULL DEFAULT 1')
  // 索引必须在列迁移之后创建：旧库升级时 SCHEMA 阶段还没有 claimed_at 列
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_claimed ON tasks(claimed_at)')
  return db
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export class TaskStore {
  private readonly insertTaskStmt: StatementSync
  private readonly getTaskStmt: StatementSync
  private readonly listPendingStmt: StatementSync
  private readonly listByStatusStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly claimStmt: StatementSync
  private readonly markRunningStmt: StatementSync
  private readonly markPausedStmt: StatementSync
  private readonly requeuePausedStmt: StatementSync
  private readonly bumpRetryStmt: StatementSync
  private readonly updateCompletedStmt: StatementSync
  private readonly markFailedStmt: StatementSync
  private readonly cancelStmt: StatementSync
  private readonly setPriorityStmt: StatementSync
  private readonly requeueTaskStmt: StatementSync
  private readonly retryStmt: StatementSync
  private readonly countPendingStmt: StatementSync
  private readonly countStaleStmt: StatementSync
  private readonly insertBillingStmt: StatementSync
  private readonly billingSinceStmt: StatementSync
  private readonly billingSinceOffpeakStmt: StatementSync
  private readonly taskCountsSinceOffpeakStmt: StatementSync
  private readonly taskCountsStmt: StatementSync
  private readonly setConfigStmt: StatementSync
  private readonly getConfigStmt: StatementSync
  private readonly recoverStaleStmt: StatementSync

  constructor(private readonly db: DatabaseSync) {
    this.insertTaskStmt = db.prepare(
      `INSERT INTO tasks (id, payload, priority, status, created_at)
       VALUES (@id, @payload, @priority, 'pending', @created_at)`,
    )
    this.getTaskStmt = db.prepare('SELECT * FROM tasks WHERE id = @id')
    this.listPendingStmt = db.prepare(
      `SELECT * FROM tasks
       WHERE status = 'pending'
       ORDER BY priority ASC, created_at ASC`,
    )
    this.listByStatusStmt = db.prepare(
      'SELECT * FROM tasks WHERE status = @status ORDER BY created_at ASC',
    )
    this.listRecentStmt = db.prepare(
      'SELECT * FROM tasks ORDER BY created_at DESC LIMIT @limit',
    )
    this.claimStmt = db.prepare(
      `UPDATE tasks SET status = 'running', executed_at = COALESCE(executed_at, @executedAt), claimed_at = @executedAt
       WHERE id = @id AND status = 'pending'`,
    )
    this.markRunningStmt = db.prepare(
      `UPDATE tasks SET status = 'running', executed_at = COALESCE(executed_at, @executedAt)
       WHERE id = @id AND status = 'pending'`,
    )
    this.markPausedStmt = db.prepare(
      `UPDATE tasks SET status = 'paused', error_msg = @reason
       WHERE id = @id AND status IN ('pending', 'running')`,
    )
    this.requeuePausedStmt = db.prepare(
      `UPDATE tasks SET status = 'pending', error_msg = NULL WHERE status = 'paused'`,
    )
    this.bumpRetryStmt = db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = @id')
    this.updateCompletedStmt = db.prepare(
      `UPDATE tasks SET
         status = 'completed',
         completed_at = @completed_at,
         billed_at = @billed_at,
         discount_used = @discount_used,
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
    this.markFailedStmt = db.prepare(
      `UPDATE tasks SET status = 'failed', error_msg = @errorMsg, completed_at = @completedAt
       WHERE id = @id`,
    )
    this.cancelStmt = db.prepare(
      `UPDATE tasks SET status = 'cancelled', error_msg = 'cancelled by user' WHERE id = @id`,
    )
    this.setPriorityStmt = db.prepare('UPDATE tasks SET priority = @priority WHERE id = @id')
    this.requeueTaskStmt = db.prepare(
      `UPDATE tasks SET status = 'pending', error_msg = NULL WHERE id = @id AND status IN ('pending', 'paused')`,
    )
    this.retryStmt = db.prepare(
      `UPDATE tasks SET status = 'pending', error_msg = NULL, retry_count = 0, executed_at = NULL,
         completed_at = NULL, claimed_at = NULL
       WHERE id = @id`,
    )
    this.countPendingStmt = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`)
    this.countStaleStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'paused') AND created_at < @beforeIso`,
    )
    this.insertBillingStmt = db.prepare(
      `INSERT INTO billing_logs
         (task_id, model, created_at, billed_at, input_tokens, output_tokens, cache_hit_tokens,
          cost_actual, cost_baseline, savings, discount_used)
       VALUES
         (@task_id, @model, @created_at, @billed_at, @input_tokens, @output_tokens, @cache_hit_tokens,
          @cost_actual, @cost_baseline, @savings, @discount_used)`,
    )
    this.billingSinceStmt = db.prepare(
      `SELECT
         COUNT(*) AS executions,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
         COALESCE(SUM(cost_actual), 0) AS cost_actual,
         COALESCE(SUM(cost_baseline), 0) AS cost_baseline,
         COALESCE(SUM(savings), 0) AS savings
       FROM billing_logs WHERE created_at >= @fromIso`,
    )
    this.billingSinceOffpeakStmt = db.prepare(
      `SELECT
         COUNT(*) AS executions,
         COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
         COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(l.cache_hit_tokens), 0) AS cache_hit_tokens,
         COALESCE(SUM(l.cost_actual), 0) AS cost_actual,
         COALESCE(SUM(l.cost_baseline), 0) AS cost_baseline,
         COALESCE(SUM(l.savings), 0) AS savings
       FROM billing_logs l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.created_at >= @fromIso AND t.priority IN (1, 2)`,
    )
    this.taskCountsStmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM tasks WHERE completed_at >= @fromIso`,
    )
    this.taskCountsSinceOffpeakStmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM tasks WHERE completed_at >= @fromIso AND priority IN (1, 2)`,
    )
    this.setConfigStmt = db.prepare(
      `INSERT INTO config (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    this.getConfigStmt = db.prepare('SELECT value FROM config WHERE key = @key')
    this.recoverStaleStmt = db.prepare(
      `UPDATE tasks SET status = 'pending', claimed_at = NULL,
         error_msg = '上次运行中断（认领租约超时），已重置等待重试'
       WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < @beforeIso)`,
    )
  }

  close(): void {
    // node:sqlite 的 StatementSync 没有 close API，由 GC 管理；
    // 本类已把全部语句在构造时预编译一次并复用，避免每次操作新建原生语句。
  }

  createTask(task: { id: string; payload: TaskPayload; priority: number; created_at: string }): TaskRow {
    this.insertTaskStmt.run({
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
    return (this.getTaskStmt.get({ '@id': id }) as TaskRow | undefined) ?? null
  }

  listPending(): TaskRow[] {
    return this.listPendingStmt.all() as unknown as TaskRow[]
  }

  listByStatus(status: TaskStatus): TaskRow[] {
    return this.listByStatusStmt.all({ '@status': status }) as unknown as TaskRow[]
  }

  listRecent(limit: number): TaskRow[] {
    return this.listRecentStmt.all({ '@limit': limit }) as unknown as TaskRow[]
  }

  /**
   * 原子认领：只有真正把 pending 改成 running 的一方返回任务。
   * 多进程共享同一 SQLite 时，同一任务只会被一个执行者认领。
   */
  claimTask(id: string, nowIso: string): TaskRow | null {
    const result = this.claimStmt.run({ '@id': id, '@executedAt': nowIso })
    if ((result.changes as number) !== 1) return null
    return this.getTask(id)
  }

  /** 兼容旧调用（测试用）；生产路径统一走 claimTask。 */
  markRunning(id: string, executedAt: string): boolean {
    const result = this.markRunningStmt.run({ '@id': id, '@executedAt': executedAt })
    return (result.changes as number) === 1
  }

  markPaused(id: string, reason: string): void {
    this.markPausedStmt.run({ '@id': id, '@reason': reason })
  }

  /** 空闲时段开始：把暂停的任务重新放回待执行队列。 */
  requeuePaused(): number {
    return this.requeuePausedStmt.run().changes as number
  }

  bumpRetry(id: string): void {
    this.bumpRetryStmt.run({ '@id': id })
  }

  markCompleted(id: string, patch: CompletionPatch): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.updateCompletedStmt.run({
        '@id': id,
        '@completed_at': patch.completed_at,
        '@billed_at': patch.billed_at,
        '@discount_used': patch.discount_used,
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
        model: patch.model,
        created_at: patch.completed_at,
        billed_at: patch.billed_at,
        input_tokens: patch.input_tokens,
        output_tokens: patch.output_tokens,
        cache_hit_tokens: patch.cache_hit_tokens,
        cost_actual: patch.cost_actual,
        cost_baseline: patch.cost_baseline,
        savings: patch.savings,
        discount_used: patch.discount_used,
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markFailed(id: string, errorMsg: string, completedAt: string): void {
    this.markFailedStmt.run({ '@id': id, '@errorMsg': errorMsg, '@completedAt': completedAt })
  }

  cancel(id: string): TaskRow | null {
    const task = this.getTask(id)
    if (task === null) return null
    if (task.status === 'pending' || task.status === 'paused') {
      this.cancelStmt.run({ '@id': id })
      return this.getTask(id)
    }
    return task
  }

  /** 把任务提级为实时（priority 0），供“立即执行”场景使用。 */
  setPriority(id: string, priority: number): boolean {
    const result = this.setPriorityStmt.run({ '@id': id, '@priority': priority })
    return (result.changes as number) === 1
  }

  /** 把 paused/pending 任务重新放回待执行（供单任务立即执行前调用）。 */
  requeueTask(id: string): boolean {
    const result = this.requeueTaskStmt.run({ '@id': id })
    return (result.changes as number) === 1
  }

  retry(id: string): TaskRow | null {
    const task = this.getTask(id)
    if (task === null || task.status !== 'failed') return null
    this.retryStmt.run({ '@id': id })
    return this.getTask(id)
  }

  countPending(): number {
    const result = this.countPendingStmt.get() as { n: number }
    return result.n
  }

  countStale(beforeIso: string): number {
    const result = this.countStaleStmt.get({ '@beforeIso': beforeIso }) as { n: number }
    return result.n
  }

  /** 启动时恢复崩溃遗留的 running 任务（认领租约超时）。 */
  recoverStaleRunning(beforeIso: string): number {
    return this.recoverStaleStmt.run({ '@beforeIso': beforeIso }).changes as number
  }

  addBillingLog(log: Omit<BillingRow, 'id'>): void {
    this.insertBillingStmt.run({
      '@task_id': log.task_id,
      '@model': log.model,
      '@created_at': log.created_at,
      '@billed_at': log.billed_at,
      '@input_tokens': log.input_tokens,
      '@output_tokens': log.output_tokens,
      '@cache_hit_tokens': log.cache_hit_tokens,
      '@cost_actual': log.cost_actual,
      '@cost_baseline': log.cost_baseline,
      '@savings': log.savings,
      '@discount_used': log.discount_used,
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
    const result = this.billingSinceStmt.get({ '@fromIso': fromIso }) as {
      executions: number
      input_tokens: number
      output_tokens: number
      cache_hit_tokens: number
      cost_actual: number
      cost_baseline: number
      savings: number
    }
    return result
  }

  /** 只统计真正错峰（priority 1/2）任务的账单。 */
  billingSinceOffpeak(fromIso: string): {
    executions: number
    input_tokens: number
    output_tokens: number
    cache_hit_tokens: number
    cost_actual: number
    cost_baseline: number
    savings: number
  } {
    const result = this.billingSinceOffpeakStmt.get({ '@fromIso': fromIso }) as {
      executions: number
      input_tokens: number
      output_tokens: number
      cache_hit_tokens: number
      cost_actual: number
      cost_baseline: number
      savings: number
    }
    return result
  }

  taskCountsSince(fromIso: string): { completed: number; failed: number } {
    return this.taskCountsStmt.get({ '@fromIso': fromIso }) as { completed: number; failed: number }
  }

  /** 只统计真正错峰（priority 1/2）任务的成功/失败数。 */
  taskCountsSinceOffpeak(fromIso: string): { completed: number; failed: number } {
    return this.taskCountsSinceOffpeakStmt.get({ '@fromIso': fromIso }) as { completed: number; failed: number }
  }

  setConfig(key: string, value: string): void {
    this.setConfigStmt.run({ '@key': key, '@value': value })
  }

  getConfig(key: string): string | null {
    const result = this.getConfigStmt.get({ '@key': key }) as { value: string } | undefined
    return result?.value ?? null
  }

}
