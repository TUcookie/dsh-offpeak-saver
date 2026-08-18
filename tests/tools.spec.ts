import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OffPeakSaver } from '../src/core.js'
import { createTools } from '../src/tools.js'

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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

function makeSaver(): { saver: OffPeakSaver; tools: Array<ReturnType<typeof createTools>[number]> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-tools-'))
  TMP_DIRS.push(dir)
  vi.stubGlobal('fetch', vi.fn(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '工具测试回复' } }],
        model: 'deepseek-v4-flash',
        usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }))
  const saver = new OffPeakSaver({
    api_key: 'sk-test',
    db_path: path.join(dir, 'offpeak.db'),
    peak_hours: ['00:00-00:01'],
    stop_before_peak_minutes: 0,
  })
  SAVERS.push(saver)
  return { saver, tools: createTools(saver) }
}

function tool(tools: Array<ReturnType<typeof createTools>[number]>, name: string) {
  const found = tools.find((t) => t.name === name)
  expect(found, `tool ${name} should exist`).toBeDefined()
  return found!
}

const exec = { signal: new AbortController().signal }

/**
 * 模拟 dsh 的 lossless JSON 检查：JSON 往返后必须与原值严格相等，
 * 任何 undefined 字段 / NaN 都会让往返结果不一致。
 */
function assertLosslessJson(value: unknown): void {
  const json = JSON.stringify(value)
  expect(json).toBeDefined()
  expect(JSON.parse(json!)).toEqual(value)
}

describe('dsh 工具', () => {
  it('注册 5 个工具且参数声明完整', () => {
    const { tools } = makeSaver()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'offpeak_cancel',
      'offpeak_report',
      'offpeak_settings',
      'offpeak_status',
      'offpeak_submit',
    ])
    const submit = tool(tools, 'offpeak_submit')
    expect(submit.parameters.type).toBe('object')
    expect(submit.parameters.properties.prompt).toBeDefined()
    expect(submit.parameters.required).toContain('prompt')
  })

  it('offpeak_submit：#offpeak 标签自动进入错峰队列', async () => {
    const { saver, tools } = makeSaver()
    const result = await tool(tools, 'offpeak_submit').execute(
      { prompt: '#offpeak 批量处理文档摘要', title: '批量摘要' },
      exec,
    )
    expect(result.status).toBe('pending')
    expect(String(result.message)).toContain('已加入错峰队列')
    expect(saver.countPending()).toBe(1)
    // 回归：空闲时段提交（nextOffPeak 为 null）时返回值必须 lossless（曾返回 undefined 导致 dsh 报错）
    assertLosslessJson(result)
  })

  it('offpeak_submit：realtime 立即执行并报告节省金额', async () => {
    const { tools } = makeSaver()
    const result = await tool(tools, 'offpeak_submit').execute(
      { prompt: '生成周报', title: '周报', priority: 'realtime' },
      exec,
    )
    expect(result.status).toBe('completed')
    expect(String(result.message)).toContain('✅ 完成')
    expect(String(result.message)).toContain('节省 ¥')
    assertLosslessJson(result)
  })

  it('offpeak_status 查询任务状态与结果预览', async () => {
    const { saver, tools } = makeSaver()
    const queued = await tool(tools, 'offpeak_submit').execute(
      { prompt: '稍后执行', priority: 'offpeak' },
      exec,
    )
    const status = await tool(tools, 'offpeak_status').execute({ task_id: String(queued.task_id) }, exec)
    expect(status.status).toBe('pending')
    expect(String(status.message)).toContain('状态：pending')
    assertLosslessJson(status)
  })

  it('offpeak_report 返回账单文本', async () => {
    const { tools } = makeSaver()
    const result = await tool(tools, 'offpeak_report').execute({}, exec)
    expect(result.period).toBe('day')
    expect(String(result.text)).toContain('错峰省钱账单')
    assertLosslessJson(result)
  })

  it('offpeak_cancel 取消排队任务', async () => {
    const { saver, tools } = makeSaver()
    const queued = await tool(tools, 'offpeak_submit').execute({ prompt: '任务' }, exec)
    const result = await tool(tools, 'offpeak_cancel').execute({ task_id: String(queued.task_id) }, exec)
    expect(result.status).toBe('cancelled')
    expect(saver.countPending()).toBe(0)
    assertLosslessJson(result)
  })

  it('offpeak_settings 支持 get 与热更新 set', async () => {
    const { saver, tools } = makeSaver()
    const got = await tool(tools, 'offpeak_settings').execute({ action: 'get' }, exec)
    expect(String(got.settings)).toContain('peak_hours')

    const set = await tool(tools, 'offpeak_settings').execute(
      { action: 'set', key: 'max_concurrency', value: '3' },
      exec,
    )
    expect(String(set.message)).toContain('已热更新')
    expect(saver.currentConfig.max_concurrency).toBe(3)
  })

  it('offpeak_settings 输出不含明文 API Key（P0 安全）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-mask-'))
    TMP_DIRS.push(dir)
    const saver = new OffPeakSaver({
      api_key: 'sk-super-secret-123456',
      db_path: path.join(dir, 'offpeak.db'),
      peak_hours: ['00:00-00:01'],
    })
    SAVERS.push(saver)
    const tools = createTools(saver)
    const got = await tool(tools, 'offpeak_settings').execute({ action: 'get' }, exec)
    const raw = String(got.settings)
    expect(raw).not.toContain('sk-super-secret')
    expect(raw).toContain('****3456')
    expect(saver.getSettings().config.api_key).toBe('****3456')
    assertLosslessJson(got)
  })

  it('offpeak_cancel 支持中止 running 任务（在途请求）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offpeak-cancel-running-'))
    TMP_DIRS.push(dir)
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      // 挂起请求直到被 abort
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }))

    const saver = new OffPeakSaver({
      api_key: 'sk-test',
      db_path: path.join(dir, 'offpeak.db'),
      peak_hours: ['00:00-00:01'],
      stop_before_peak_minutes: 0,
    })
    SAVERS.push(saver)
    const tools = createTools(saver)

    const submit = tool(tools, 'offpeak_submit')
    const submitPromise = submit.execute({ prompt: '慢任务', priority: 'realtime' }, exec)
    await vi.waitFor(() => {
      expect(saver.listTasks().running.length).toBe(1)
    })
    const runningId = saver.listTasks().running[0]!.id

    const cancelResult = await tool(tools, 'offpeak_cancel').execute({ task_id: runningId }, exec)
    expect(String(cancelResult.message)).toContain('已中止')
    assertLosslessJson(cancelResult)

    await submitPromise
    await vi.waitFor(() => {
      expect(saver.getTask(runningId)?.status).toBe('failed')
    })
    expect(String(saver.getTask(runningId)?.error_msg)).toContain('取消')
  })
})
