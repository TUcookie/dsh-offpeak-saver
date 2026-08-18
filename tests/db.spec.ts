import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, TaskStore, type TaskPayload } from '../src/db.js'

function makeStore(): TaskStore {
  return new TaskStore(openDatabase(':memory:'))
}

function payload(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return { prompt: '生成摘要', model: 'deepseek-v4-flash', ...overrides }
}

describe('TaskStore', () => {
  it('创建与读取任务', () => {
    const store = makeStore()
    const task = store.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    expect(task.status).toBe('pending')
    expect(store.getTask('t1')?.id).toBe('t1')
  })

  it('待执行队列按优先级与创建时间排序', () => {
    const store = makeStore()
    store.createTask({ id: 'a', payload: payload(), priority: 2, created_at: '2026-08-18T00:00:00Z' })
    store.createTask({ id: 'b', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    store.createTask({ id: 'c', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    expect(store.listPending().map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('状态流转：pending -> running -> completed 并写入计费日志', () => {
    const store = makeStore()
    store.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    store.markRunning('t1', '2026-08-18T01:00:00Z')
    expect(store.getTask('t1')?.status).toBe('running')
    store.markCompleted('t1', {
      status: 'completed',
      model: 'deepseek-v4-flash',
      completed_at: '2026-08-18T01:00:05Z',
      billed_at: '2026-08-18T00:59:55Z',
      discount_used: 0.5,
      input_tokens: 100,
      output_tokens: 50,
      cache_hit_tokens: 10,
      cost_actual: 0.001,
      cost_baseline: 0.002,
      savings: 0.001,
      price_snapshot: { input: 3, input_cache_hit: 0.1, output: 9 },
      result_path: '/tmp/t1.md',
    })
    const task = store.getTask('t1')
    expect(task?.status).toBe('completed')
    expect(task?.savings).toBe(0.001)
    const billing = store.billingSince('2026-08-18T00:00:00Z')
    expect(billing.executions).toBe(1)
    expect(billing.input_tokens).toBe(100)
    expect(billing.savings).toBeCloseTo(0.001, 6)
    expect(store.getTask('t1')?.billed_at).toBe('2026-08-18T00:59:55Z')
    expect(store.getTask('t1')?.discount_used).toBe(0.5)
  })

  it('暂停任务在空闲时段重新入队', () => {
    const store = makeStore()
    store.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    store.markPaused('t1', 'peak')
    expect(store.getTask('t1')?.status).toBe('paused')
    expect(store.requeuePaused()).toBe(1)
    expect(store.getTask('t1')?.status).toBe('pending')
  })

  it('取消与重试', () => {
    const store = makeStore()
    store.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    const cancelled = store.cancel('t1')
    expect(cancelled?.status).toBe('cancelled')
    // running 任务不可取消
    store.createTask({ id: 't2', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    store.markRunning('t2', '2026-08-18T01:00:00Z')
    expect(store.cancel('t2')?.status).toBe('running')
    // failed -> retry -> pending
    store.markFailed('t2', 'boom', '2026-08-18T01:00:05Z')
    expect(store.retry('t2')?.status).toBe('pending')
  })

  it('配置表读写', () => {
    const store = makeStore()
    store.setConfig('peak_hours', JSON.stringify(['09:00-12:00']))
    expect(store.getConfig('peak_hours')).toBe('["09:00-12:00"]')
  })

  it('原子认领：两个 store 认领同一任务只有一个成功（P1 竞态）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-claim-'))
    const dbPath = path.join(dir, 'offpeak.db')
    const dbA = openDatabase(dbPath)
    const dbB = openDatabase(dbPath)
    const storeA = new TaskStore(dbA)
    const storeB = new TaskStore(dbB)
    storeA.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })

    const claimedA = storeA.claimTask('t1', '2026-08-18T01:00:00Z')
    const claimedB = storeB.claimTask('t1', '2026-08-18T01:00:01Z')
    expect(claimedA?.status).toBe('running')
    expect(claimedB).toBeNull()
    expect(storeA.getTask('t1')?.claimed_at).toBe('2026-08-18T01:00:00Z')

    storeA.close()
    storeB.close()
    dbA.close()
    dbB.close()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
  })

  it('崩溃租约恢复：超时 running 任务重置为 pending（P1 卡死）', () => {
    const store = makeStore()
    store.createTask({ id: 't1', payload: payload(), priority: 1, created_at: '2026-08-18T00:00:00Z' })
    expect(store.claimTask('t1', '2026-08-18T01:00:00Z')?.status).toBe('running')
    expect(store.recoverStaleRunning('2026-08-18T01:30:00Z')).toBe(1)
    expect(store.getTask('t1')?.status).toBe('pending')
    expect(store.getTask('t1')?.error_msg).toContain('认领租约超时')
  })

  it('旧库迁移：v0.1.0 schema 打开后自动补新列（索引在列迁移之后）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-migrate-'))
    const dbPath = path.join(dir, 'offpeak.db')
    const oldDb = new DatabaseSync(dbPath)
    oldDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, executed_at TEXT,
        completed_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
        cost_actual REAL NOT NULL DEFAULT 0, cost_baseline REAL NOT NULL DEFAULT 0, savings REAL NOT NULL DEFAULT 0,
        price_snapshot TEXT, error_msg TEXT, result_path TEXT
      );
      CREATE TABLE billing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, model TEXT NOT NULL,
        created_at TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_hit_tokens INTEGER NOT NULL DEFAULT 0, cost_actual REAL NOT NULL DEFAULT 0,
        cost_baseline REAL NOT NULL DEFAULT 0, savings REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO tasks (id, payload, priority, status, created_at)
        VALUES ('old-1', '{"prompt":"旧任务"}', 1, 'pending', '2026-08-18T00:00:00Z');
    `)
    oldDb.close()

    const db = openDatabase(dbPath)
    const store = new TaskStore(db)
    const migrated = store.getTask('old-1')
    expect(migrated?.status).toBe('pending')
    expect(migrated?.claimed_at).toBeNull()
    expect(migrated?.billed_at).toBeNull()
    expect(migrated?.discount_used).toBe(1)
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('claimed_at')
    db.close()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
  })
})
