// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OffpeakPanel } from '../src/client/OffpeakPanel.tsx'
import { money } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'
import type { PanelOverview } from '../src/client/api.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(_name: string, fn: () => void): void {
    this.onmessage = fn as unknown as (ev: { data: string }) => void
  }

  close(): void {
    this.closed = true
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function stubEventSource(): void {
  vi.stubGlobal('EventSource', FakeEventSource)
}

function fakeOverview(): PanelOverview {
  const report = {
    period: 'day',
    period_label: '2026-08-18',
    executions: 2,
    completed_tasks: 2,
    failed_tasks: 0,
    pending_tasks: 1,
    input_tokens: 1000,
    output_tokens: 500,
    cost_actual: 0.1,
    cost_baseline: 0.2,
    savings: 0.1,
    equivalent_free_tokens: 66000,
    currency: 'CNY' as const,
  }
  return {
    now: '2026-08-18T12:00:00.000Z',
    phase: 'offpeak',
    nextOffPeak: null,
    concurrency: { configured: 3, effective: 2 },
    pending: [
      {
        id: 'task-pending-1',
        title: '批量摘要',
        model: 'deepseek-v4-flash',
        priority: 1,
        queue_order: 1,
        status: 'pending',
        created_at: '2026-08-18T11:00:00.000Z',
        executed_at: null,
        completed_at: null,
        billed_at: null,
        retry_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_actual: 0,
        cost_baseline: 0,
        savings: 0,
        error_msg: null,
        result_path: null,
        prompt: '#offpeak 批量摘要',
      },
    ],
    running: [],
    recent: [
      {
        id: 'task-done-1',
        title: '审计修复验证',
        model: 'deepseek-v4-flash',
        priority: 0,
        queue_order: 0,
        status: 'completed',
        created_at: '2026-08-18T06:58:58.034Z',
        executed_at: '2026-08-18T06:58:58.034Z',
        completed_at: '2026-08-18T06:58:59.338Z',
        billed_at: '2026-08-18T06:58:58.043Z',
        retry_count: 0,
        input_tokens: 93,
        output_tokens: 63,
        cost_actual: 0.000846,
        cost_baseline: 0.000846,
        savings: 0,
        error_msg: null,
        result_path: 'C:\\results\\task-done-1.md',
        prompt: '一句话',
      },
    ],
    reports: { day: report, week: { ...report, period: 'week' }, month: { ...report, period: 'month' } },
  }
}

describe('OffpeakPanel 渲染', () => {
  it('展示时段、节省金额与待执行任务（真实 DOM 渲染）', async () => {
    stubEventSource()
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, value: fakeOverview() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)

    await waitFor(() => {
      // 抽屉宿主自带标题，面板内不再重复渲染标题；以时段徽章出现作为渲染完成的信号
      expect(screen.getByText('空闲时段（半价）')).toBeTruthy()
    })
    expect(screen.getByText('今日节省')).toBeTruthy()
    expect(screen.getAllByText('¥0.10').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText(/待执行任务/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('批量摘要')).toBeTruthy()
    expect(screen.getByText('排队中')).toBeTruthy()
    expect(screen.getByText('取消')).toBeTruthy()
    // 最近任务/报告区已按要求移除，不应出现
    expect(screen.queryByText('最近任务')).toBeNull()
    expect(screen.queryByText('提交任务')).toBeNull()
  })

  it('取消按钮调用 API 并刷新列表', async () => {
    stubEventSource()
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/cancel')) {
        cancelled = true
        return new Response(JSON.stringify({ ok: true, value: { id: 'task-pending-1', status: 'cancelled' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: fakeOverview() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    await waitFor(() => expect(screen.getByText('批量摘要')).toBeTruthy())
    screen.getByText('取消').click()
    await waitFor(() => expect(cancelled).toBe(true))
  })

  it('并发滑块提交 1–8 范围内的新上限', async () => {
    stubEventSource()
    let submitted: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/concurrency')) {
        submitted = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ ok: true, value: { configured: 5, effective: 2 } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: fakeOverview() }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    const slider = await screen.findByLabelText('并发上限')
    expect(slider.getAttribute('min')).toBe('1')
    expect(slider.getAttribute('max')).toBe('8')
    fireEvent.change(slider, { target: { value: '5' } })
    await waitFor(() => expect(submitted).toEqual({ maxConcurrency: 5 }))
  })

  it('同优先级队列可通过上移/下移按钮调整顺序', async () => {
    stubEventSource()
    let submitted: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/reorder')) {
        submitted = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ ok: true, value: { id: 'task-pending-1', position: { position: 2, total: 2 } } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      const overview = fakeOverview()
      overview.pending.push({
        ...overview.pending[0]!, id: 'task-pending-2', title: '第二项任务', queue_order: 2,
      })
      return new Response(JSON.stringify({ ok: true, value: overview }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    const down = await screen.findAllByLabelText('下移')
    expect(down).toHaveLength(2)
    fireEvent.click(down[0]!)
    await waitFor(() => expect(submitted).toEqual({ taskId: 'task-pending-1', direction: 'down' }))
  })

  it('正在执行的任务实时展示：标题、开始时间、时长与取消按钮', async () => {
    stubEventSource()
    const running = {
      ...fakeOverview().pending[0]!,
      id: 'task-running-1',
      title: '正在跑的摘要任务',
      status: 'running',
      executed_at: new Date(Date.now() - 32_000).toISOString(),
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      const overview = fakeOverview()
      overview.running = [running]
      overview.pending = []
      return new Response(JSON.stringify({ ok: true, value: overview }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    await waitFor(() => {
      expect(screen.getAllByText(/正在执行/).length).toBeGreaterThanOrEqual(1)
    })
    expect(screen.getByText('正在跑的摘要任务')).toBeTruthy()
    expect(screen.getByText(/32s|31s/)).toBeTruthy()
    expect(screen.getAllByText('取消').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('实时')).toBeTruthy()
  })

  it('SSE 事件触发面板立即刷新（不等 30 秒轮询）', async () => {
    stubEventSource()
    let fetches = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches++
      return new Response(JSON.stringify({ ok: true, value: fakeOverview() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    await waitFor(() => {
      expect(screen.getByText('空闲时段（半价）')).toBeTruthy()
    })
    expect(fetches).toBe(1)

    FakeEventSource.instances.at(-1)?.emit({ type: 'task-completed' })
    await waitFor(() => expect(fetches).toBeGreaterThanOrEqual(2))
  })

  it('SSE task-stream 增量实时显示在正在执行区（逐字输出钩子）', async () => {
    stubEventSource()
    const running = {
      ...fakeOverview().pending[0]!,
      id: 'task-stream-1',
      title: '流式直播任务',
      status: 'running',
      executed_at: new Date().toISOString(),
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      const overview = fakeOverview()
      overview.running = [running]
      overview.pending = []
      return new Response(JSON.stringify({ ok: true, value: overview }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<OffpeakPanel t={(key) => zh[key]} />)
    await waitFor(() => {
      expect(screen.getByText('流式直播任务')).toBeTruthy()
    })
    expect(screen.getByText('等待模型输出…')).toBeTruthy()

    const es = FakeEventSource.instances.at(-1)!
    es.emit({ type: 'task-stream', taskId: 'task-stream-1', kind: 'reasoning', text: '先想' })
    es.emit({ type: 'task-stream', taskId: 'task-stream-1', kind: 'reasoning', text: '清楚' })
    es.emit({ type: 'task-stream', taskId: 'task-stream-1', kind: 'text', text: '最终' })
    es.emit({ type: 'task-stream', taskId: 'task-stream-1', kind: 'text', text: '答案' })

    await waitFor(() => {
      expect(screen.getByText(/先想清楚/)).toBeTruthy()
      expect(screen.getByText(/最终答案/)).toBeTruthy()
    })
  })
})

describe('money 显示', () => {
  it('金额大于 0 但小于 0.01 显示 <0.01，真实数值仍在后端', () => {
    expect(money(0.005, 'CNY')).toBe('¥<0.01')
    expect(money(0.009999, 'USD')).toBe('$<0.01')
    expect(money(0, 'CNY')).toBe('¥0.00')
    expect(money(0.01, 'CNY')).toBe('¥0.01')
    expect(money(0.0154, 'CNY')).toBe('¥0.02')
    expect(money(0.1, 'CNY')).toBe('¥0.10')
  })
})
