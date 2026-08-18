import { describe, expect, it } from 'vitest'
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
      completed_at: '2026-08-18T01:00:05Z',
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
})
