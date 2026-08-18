import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OffPeakSaver } from '../src/core.js'
import { createTools } from '../src/tools.js'

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
    saver.stop()
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
    saver.stop()
  })

  it('offpeak_report 返回账单文本', async () => {
    const { tools } = makeSaver()
    const result = await tool(tools, 'offpeak_report').execute({}, exec)
    expect(result.period).toBe('day')
    expect(String(result.text)).toContain('错峰省钱账单')
  })

  it('offpeak_cancel 取消排队任务', async () => {
    const { saver, tools } = makeSaver()
    const queued = await tool(tools, 'offpeak_submit').execute({ prompt: '任务' }, exec)
    const result = await tool(tools, 'offpeak_cancel').execute({ task_id: String(queued.task_id) }, exec)
    expect(result.status).toBe('cancelled')
    expect(saver.countPending()).toBe(0)
    saver.stop()
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
    saver.stop()
  })
})
