import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OffPeakSaver } from '../src/core.js'
import type { SessionRunner } from '../src/session-runner.js'
import { minutesOf } from '../src/time.js'

const TMP_DIRS: string[] = []
const SAVERS: OffPeakSaver[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const saver of SAVERS.splice(0)) await saver.stop()
  while (TMP_DIRS.length > 0) {
    removeDirWithRetry(TMP_DIRS.pop()!)
  }
})

function removeDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      // Windows 下 SQLite 文件句柄释放可能有瞬时延迟
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

function tmpDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-test-'))
  TMP_DIRS.push(dir)
  return path.join(dir, 'offpeak.db')
}

function makeSaver(
  config: Partial<ConstructorParameters<typeof OffPeakSaver>[0]> = {},
  hooks: ConstructorParameters<typeof OffPeakSaver>[1] = {},
): OffPeakSaver {
  const saver = new OffPeakSaver(
    {
      api_key: 'sk-test',
      db_path: tmpDbPath(),
      stop_before_peak_minutes: 0,
      ...config,
    },
    hooks,
  )
  SAVERS.push(saver)
  return saver
}

function fmt(minutes: number): string {
  const h = Math.floor(((minutes % 1440) + 1440) % 1440 / 60)
  const m = Math.floor((((minutes % 1440) + 1440) % 1440) % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 构造一个绝对不包含当前时刻的高峰窗口。 */
function offPeakHours(): string[] {
  const nowMin = minutesOf(new Date(), 8)
  const start = (nowMin + 60) % 1440
  return [`${fmt(start)}-${fmt((start + 60) % 1440)}`]
}

/** 构造一个必然包含当前时刻的高峰窗口。 */
function peakHours(): string[] {
  const nowMin = minutesOf(new Date(), 8)
  return [`${fmt(nowMin - 5)}-${fmt(nowMin + 5)}`]
}

function fakeCompletion(content = '这是一段集成测试回复。') {
  return {
    choices: [{ message: { content } }],
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_cache_hit_tokens: 200_000 },
  }
}

function stubFetch(completion = fakeCompletion()) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('OffPeakSaver', () => {
  it('实时任务立即执行并完成计费', async () => {
    const fetchMock = stubFetch()
    const saver = makeSaver({ peak_hours: offPeakHours() })
    const result = await saver.submitTask({ prompt: '写摘要', title: '摘要任务' }, 0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.task.status).toBe('completed')
    expect(result.immediate?.content).toContain('集成测试回复')
    // 高峰基准价 = (800k*3 + 200k*0.1 + 1M*9) / 1M = 11.42；半价后节省 5.71
    expect(result.task.cost_baseline).toBeCloseTo(11.42, 2)
    expect(result.task.cost_actual).toBeCloseTo(5.71, 2)
    expect(result.task.savings).toBeCloseTo(5.71, 2)
    expect(result.task.result_path).not.toBeNull()
    expect(existsSync(result.task.result_path!)).toBe(true)
    expect(readFileSync(result.task.result_path!, 'utf8')).toContain('集成测试回复')
  })

  it('错峰任务在高峰时段只入队不调用 API', async () => {
    const fetchMock = stubFetch()
    const saver = makeSaver({ peak_hours: peakHours() })
    const result = await saver.submitTask({ prompt: '#offpeak 批量摘要' }, 1)
    expect(result.task.status).toBe('pending')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('高峰时刻实时任务立即执行（实时语义不受窗口约束）', async () => {
    const fetchMock = stubFetch()
    const saver = makeSaver({ peak_hours: peakHours() })
    const result = await saver.submitTask({ prompt: '立即执行' }, 0)
    expect(result.task.status).toBe('completed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.task.savings).toBe(0)
    expect(result.task.cost_actual).toBeCloseTo(11.42, 2)
  })

  it('热更新高峰时段后，调度器在空闲窗口自动执行队列', async () => {
    const fetchMock = stubFetch()
    const saver = makeSaver({ peak_hours: peakHours() })
    const queued = await saver.submitTask({ prompt: '稍后执行' }, 1)
    expect(queued.task.status).toBe('pending')

    saver.updateSetting('peak_hours', JSON.stringify(offPeakHours()))
    saver.start()
    // 等待调度器首个 tick 完成 drain
    await vi.waitFor(() => {
      expect(saver.getTask(queued.task.id)?.status).toBe('completed')
    }, { timeout: 3000 })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('任务在 SQLite 文件重启后不丢失（验收标准 5）', async () => {
    const dbPath = tmpDbPath()
    const first = makeSaver({ db_path: dbPath, peak_hours: peakHours() })
    const queued = await first.submitTask({ prompt: '持久化测试' }, 1)
    await first.stop()

    const second = makeSaver({ db_path: dbPath, peak_hours: peakHours() })
    expect(second.getTask(queued.task.id)?.status).toBe('pending')
  })

  it('日账单只统计真正错峰任务（realtime 不计入执行/节省）', async () => {
    stubFetch()
    const saver = makeSaver({ peak_hours: offPeakHours() })
    await saver.submitTask({ prompt: '任务 A' }, 0)
    const report = saver.getReport('day')
    expect(report.executions).toBe(0) // realtime 不计入错峰执行
    expect(report.savings).toBe(0)
    expect(report.equivalent_free_tokens).toBe(0)
    expect(saver.renderReport('day')).toContain('错峰省钱账单')

    // 真正错峰任务（priority 1）入队后 drain，计入账单
    await saver.submitTask({ prompt: '任务 B' }, 1)
    await saver.runPendingNowForTest()
    await vi.waitFor(() => expect(saver.getReport('day').executions).toBe(1))
    const report2 = saver.getReport('day')
    expect(report2.executions).toBe(1)
    expect(report2.savings).toBeCloseTo(5.71, 2)
  })

  it('取消排队任务', async () => {
    const saver = makeSaver({ peak_hours: peakHours() })
    const queued = await saver.submitTask({ prompt: '将被取消' }, 1)
    const cancelled = saver.cancelTask(queued.task.id)
    expect(cancelled?.status).toBe('cancelled')
  })

  it('归档会话只取消该会话仍在排队的任务，不中断 running 任务', () => {
    const saver = makeSaver({ peak_hours: peakHours() })
    const pendingSame = saver.createQueuedTask({ prompt: '会话 A 的排队任务', session_id: 'session-A' }, 1)
    const pendingOther = saver.createQueuedTask({ prompt: '会话 B 的排队任务', session_id: 'session-B' }, 1)
    const runningSame = saver.createQueuedTask({ prompt: '会话 A 的运行任务', session_id: 'session-A' }, 1)
    saver.markTaskStartedLocally(runningSame.id)

    expect(saver.cancelQueuedTasksForSession('session-A')).toBe(1)
    expect(saver.getTask(pendingSame.id)?.status).toBe('cancelled')
    expect(saver.getTask(pendingOther.id)?.status).toBe('pending')
    expect(saver.getTask(runningSame.id)?.status).toBe('running')
  })

  it('配置热更新校验与持久化', async () => {
    const dbPath = tmpDbPath()
    const saver = makeSaver({ db_path: dbPath })
    expect(saver.updateSetting('discount_rate', '0.3').value).toBe(0.3)
    expect(saver.currentConfig.discount_rate).toBe(0.3)
    expect(() => saver.updateSetting('peak_hours', '["09:00"]')).toThrow()
    expect(() => saver.updateSetting('max_concurrency', '0')).toThrow('1 到 8')
    expect(() => saver.updateSetting('max_concurrency', '9')).toThrow('1 到 8')
    expect(() => saver.updateSetting('max_concurrency', '2.5')).toThrow('1 到 8')
    expect(() => saver.updateSetting('api_key', 'x')).toThrow()
    await saver.stop()

    const reloaded = makeSaver({ db_path: dbPath })
    expect(reloaded.currentConfig.discount_rate).toBe(0.3)
  })

  it('缺少 API Key 时报错而非静默失败', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const fetchMock = stubFetch()
    const saver = makeSaver({ api_key: '', peak_hours: offPeakHours() })
    await saver.submitTask({ prompt: '无 key 任务' }, 0)
    expect(fetchMock).not.toHaveBeenCalled()
    const report = saver.getReport('day')
    // 实时任务（priority 0）不计入错峰账单统计
    expect(report.failed_tasks).toBe(0)
  })

  it('计费按请求发起时刻：高峰发起、空闲返回按原价（P0-1）', async () => {
    stubFetch()
    // 注入时钟：请求发起时刻固定为北京 11:00（落在 10:50-11:10 高峰窗口内）
    const peakStart = new Date('2026-08-18T03:00:00.000Z')
    const saver = makeSaver({ peak_hours: ['10:50-11:10'] }, { now: () => peakStart })
    const result = await saver.submitTask({ prompt: '跨边界任务' }, 0)
    expect(result.task.status).toBe('completed')
    expect(result.task.savings).toBe(0)
    expect(result.task.billed_at).toBe('2026-08-18T03:00:00.000Z')
  })

  it('计费按请求发起时刻：空闲发起享受半价（P0-1 反向）', async () => {
    stubFetch()
    const offpeakStart = new Date('2026-08-18T12:30:00.000Z') // 北京 20:30，窗口外
    const saver = makeSaver({ peak_hours: ['21:00-21:10'] }, { now: () => offpeakStart })
    const result = await saver.submitTask({ prompt: '半价任务' }, 0)
    expect(result.task.status).toBe('completed')
    expect(result.task.savings).toBeCloseTo(5.71, 2)
    expect(result.task.discount_used).toBe(0.5)
  })

  it('单层重试：retry_attempts=1 时最多调用 2 次 API（P0-2）', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) {
        return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
      }
      return new Response(JSON.stringify(fakeCompletion()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const saver = makeSaver({ peak_hours: offPeakHours(), retry_attempts: 1, backoff_base_ms: 5 })
    const result = await saver.submitTask({ prompt: '重试任务' }, 0)
    expect(result.task.status).toBe('completed')
    expect(calls).toBe(2)
  })

  it('本地写盘失败绝不重试 API（P0-3）', async () => {
    const fetchMock = stubFetch()
    const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-local-fail-'))
    TMP_DIRS.push(dir)
    const dbDir = path.join(dir, 'db')
    mkdirSync(dbDir, { recursive: true })
    writeFileSync(path.join(dbDir, 'results'), '占位文件，阻止目录创建')

    const saver = makeSaver({ db_path: path.join(dbDir, 'offpeak.db'), peak_hours: offPeakHours() })
    const result = await saver.submitTask({ prompt: '写盘失败任务' }, 0)
    expect(result.task.status).toBe('failed')
    expect(String(result.task.error_msg)).toContain('本地持久化错误')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stop() 中止在途请求并优雅收尾，任务不卡 running（P1-2）', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const dbPath = tmpDbPath()
    let submittedId = ''
    const saver = makeSaver(
      { db_path: dbPath, peak_hours: offPeakHours() },
      {
        onEvent: (event) => {
          if (event.type === 'task-submitted') submittedId = event.task.id
        },
      },
    )
    const pendingSubmit = saver.submitTask({ prompt: '在途请求' }, 0)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await saver.stop()
    await pendingSubmit

    const reopened = makeSaver({ db_path: dbPath, peak_hours: offPeakHours() })
    const view = reopened.getTask(submittedId)
    expect(view?.status).toBe('failed')
    expect(String(view?.error_msg)).toContain('取消')
  })

  it('安全加固：base_url 不可热更新、pricing 逐项校验、config.json 不能注入 api_key（P0）', async () => {
    const dbPath = tmpDbPath()
    writeFileSync(path.join(path.dirname(dbPath), 'config.json'), JSON.stringify({ api_key: 'hacked-key' }))
    const saver = makeSaver({ db_path: dbPath, api_key: '' })
    expect(saver.currentConfig.api_key).toBe('')
    expect(() => saver.updateSetting('base_url', '"https://evil.example"')).toThrow()
    expect(() =>
      saver.updateSetting('pricing', '{"deepseek-v4-flash":{"input":"abc","input_cache_hit":0.1,"output":1}}'),
    ).toThrow()
    expect(() => saver.updateSetting('peak_hours', '["99:00-99:01"]')).toThrow()
  })

  it('空 prompt 拒绝提交；标题自动生成（#offpeak 剔除标签、超长截断）', async () => {
    const saver = makeSaver({ peak_hours: peakHours() })
    await expect(saver.submitTask({ prompt: '   ' }, 1)).rejects.toThrow('不能为空')

    const tagged = await saver.submitTask({ prompt: '#offpeak 给文档写摘要' }, 1)
    const view = saver.getTask(tagged.task.id)
    expect(view?.title).toBe('给文档写摘要')

    const long = await saver.submitTask(
      { prompt: '这是一段非常非常非常非常非常非常非常非常非常非常非常非常长的任务描述，用来测试自动标题的截断行为' },
      1,
    )
    const longView = saver.getTask(long.task.id)
    expect(longView?.title).toHaveLength(31)
    expect(longView?.title.endsWith('…')).toBe(true)
  })

  it('会话内执行（B）：任务在原生会话跑完，计费/落盘与 direct 一致', async () => {
    const runner: SessionRunner = {
      runTask: async (payload, _signal, model) => {
        expect(payload.prompt).toContain('直播任务')
        expect(model).toBe('deepseek-v4-flash')
        return {
          content: '这是会话内执行产出的结果',
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 200_000 },
          sessionId: 'offpeak-test-session',
        }
      },
      cancelAll: () => {},
    }
    const saver = makeSaver(
      { peak_hours: offPeakHours(), execution_mode: 'session' },
      { sessionRunner: runner },
    )
    const result = await saver.submitTask({ prompt: '#offpeak 直播任务', session_id: 'orig-session' }, 1)
    // 空闲窗口内 submit 会同步 drain？submitTask 只入队；手动触发执行
    expect(result.task.status).toBe('pending')
    await saver.runPendingNowForTest()
    await vi.waitFor(() => expect(saver.getTask(result.task.id)?.status).toBe('completed'))
    const view = saver.getTask(result.task.id)
    expect(view?.status).toBe('completed')
    expect(view?.savings).toBeCloseTo(5.71, 2)
    expect(readFileSync(view?.result_path!, 'utf8')).toContain('会话内执行产出的结果')
  })

  it('错峰队列在任务完成后立即补位，不等待整批全部结束', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)))
    vi.stubGlobal('fetch', fetchMock)
    const saver = makeSaver({ peak_hours: offPeakHours(), max_concurrency: 1 })
    await saver.submitTask({ prompt: '任务 1' }, 1)
    await saver.submitTask({ prompt: '任务 2' }, 1)
    await saver.submitTask({ prompt: '任务 3' }, 1)

    await saver.runPendingNowForTest()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    resolvers.shift()!(new Response(JSON.stringify(fakeCompletion('1')), { status: 200 }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    resolvers.shift()!(new Response(JSON.stringify(fakeCompletion('2')), { status: 200 }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    resolvers.shift()!(new Response(JSON.stringify(fakeCompletion('3')), { status: 200 }))
    await vi.waitFor(() => expect(saver.listTasks().pending).toHaveLength(0))
  })

  it('session 模式把同一会话串行，并在不同会话之间公平补位', async () => {
    vi.useFakeTimers()
    const started: string[] = []
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const runner: SessionRunner = {
      runTask: async (payload) => {
        started.push(payload.prompt)
        await gate
        return { content: payload.prompt, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, sessionId: 'test' }
      },
      cancelAll: () => {},
    }
    const saver = makeSaver(
      { peak_hours: offPeakHours(), execution_mode: 'session', max_concurrency: 3 },
      { sessionRunner: runner },
    )
    await saver.submitTask({ prompt: 'A-1', session_id: 'session-A' }, 1)
    await saver.submitTask({ prompt: 'A-2', session_id: 'session-A' }, 1)
    await saver.submitTask({ prompt: 'B-1', session_id: 'session-B' }, 1)
    await saver.runPendingNowForTest()
    await vi.advanceTimersByTimeAsync(2_100)

    expect(started).toEqual(['A-1', 'B-1'])
    finish()
    await vi.advanceTimersByTimeAsync(10)
    vi.useRealTimers()
    await vi.waitFor(() => expect(started).toContain('A-2'))
  })

  it('会话内执行被取消 → 任务 failed 且不再重试', async () => {
    let releaseAbort!: () => void
    const aborted = new Promise<void>((resolve) => { releaseAbort = resolve })
    const runner: SessionRunner = {
      runTask: async (_payload, signal) => {
        signal.addEventListener('abort', () => releaseAbort())
        await aborted
        const { CancelledSessionError } = await import('../src/session-runner.js')
        throw new CancelledSessionError()
      },
      cancelAll: () => {},
    }
    const saver = makeSaver(
      { peak_hours: offPeakHours(), execution_mode: 'session', stop_before_peak_minutes: 0 },
      { sessionRunner: runner },
    )
    const submitPromise = saver.submitTask({ prompt: '会被取消的任务' }, 0)
    await vi.waitFor(() => {
      expect(saver.listTasks().running.length).toBe(1)
    })
    const runningId = saver.listTasks().running[0]!.id
    saver.cancelTask(runningId)
    await submitPromise
    expect(saver.getTask(runningId)?.status).toBe('failed')
    expect(String(saver.getTask(runningId)?.error_msg)).toContain('取消')
  })
})
