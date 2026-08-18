import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OffPeakSaver } from '../src/core.js'
import { minutesOf } from '../src/time.js'

const TMP_DIRS: string[] = []
const SAVERS: OffPeakSaver[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const saver of SAVERS.splice(0)) saver.stop()
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

function makeSaver(config: Partial<ConstructorParameters<typeof OffPeakSaver>[0]> = {}): OffPeakSaver {
  const saver = new OffPeakSaver({
    api_key: 'sk-test',
    db_path: tmpDbPath(),
    ...config,
  })
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

  it('高峰时刻提交实时任务会被挂起', async () => {
    const fetchMock = stubFetch()
    const saver = makeSaver({ peak_hours: peakHours() })
    const result = await saver.submitTask({ prompt: '立即执行' }, 0)
    expect(result.task.status).toBe('paused')
    expect(fetchMock).not.toHaveBeenCalled()
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
    first.stop()

    const second = makeSaver({ db_path: dbPath, peak_hours: peakHours() })
    expect(second.getTask(queued.task.id)?.status).toBe('pending')
  })

  it('日账单汇总执行次数与节省金额', async () => {
    stubFetch()
    const saver = makeSaver({ peak_hours: offPeakHours() })
    await saver.submitTask({ prompt: '任务 A' }, 0)
    const report = saver.getReport('day')
    expect(report.executions).toBe(1)
    expect(report.savings).toBeCloseTo(5.71, 2)
    expect(report.equivalent_free_tokens).toBe(3_806_666)
    expect(saver.renderReport('day')).toContain('错峰省钱账单')
  })

  it('取消排队任务', async () => {
    const saver = makeSaver({ peak_hours: peakHours() })
    const queued = await saver.submitTask({ prompt: '将被取消' }, 1)
    const cancelled = saver.cancelTask(queued.task.id)
    expect(cancelled?.status).toBe('cancelled')
  })

  it('配置热更新校验与持久化', async () => {
    const dbPath = tmpDbPath()
    const saver = makeSaver({ db_path: dbPath })
    expect(saver.updateSetting('discount_rate', '0.3').value).toBe(0.3)
    expect(saver.currentConfig.discount_rate).toBe(0.3)
    expect(() => saver.updateSetting('peak_hours', '["09:00"]')).toThrow()
    expect(() => saver.updateSetting('api_key', 'x')).toThrow()
    saver.stop()

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
    expect(report.failed_tasks).toBe(1)
  })
})
