import { describe, expect, it, vi } from 'vitest'
import { classifyTask, installAutoRouting } from '../src/auto-route.ts'
import type { OffPeakSaver, Priority, SubmitInput } from '../src/core.js'

describe('classifyTask', () => {
  it('把文档/批处理类任务识别为 defer', () => {
    expect(classifyTask('帮我把项目结构总结成一份 Markdown 报告')).toBe('defer')
    expect(classifyTask('写一份本周工作总结')).toBe('defer')
    expect(classifyTask('批量翻译这 20 篇文档')).toBe('defer')
    expect(classifyTask('整理 D 盘的文件清单')).toBe('defer')
    expect(classifyTask('重构一下这个模块的代码')).toBe('defer')
  })

  it('把交互式任务放行', () => {
    expect(classifyTask('帮我修复这个 bug')).toBe('skip')
    expect(classifyTask('解释一下这段代码的作用')).toBe('skip')
    expect(classifyTask('看看这个报错是什么原因')).toBe('skip')
    expect(classifyTask('运行一下测试')).toBe('skip')
  })

  it('紧急任务放行', () => {
    expect(classifyTask('立即帮我总结这份报告')).toBe('immediate')
    expect(classifyTask('马上写一份周报')).toBe('immediate')
  })

  it('问答/短消息放行', () => {
    expect(classifyTask('今天天气怎么样？')).toBe('skip')
    expect(classifyTask('你好')).toBe('skip')
    expect(classifyTask('怎么安装依赖')).toBe('skip')
  })
})

function makeSaver(phase: 'peak' | 'offpeak') {
  const created: Array<{ input: SubmitInput; priority: Priority }> = []
  const runNow: string[] = []
  const cancelled: string[] = []
  const saver = {
    currentPhase: vi.fn(() => phase),
    nextOffPeak: vi.fn(() => ({ minutes: 120, label: '今日 18:00', at: new Date() })),
    createQueuedTask: vi.fn((input: SubmitInput, priority: Priority) => {
      created.push({ input, priority })
      return { id: 'task-auto-1', payload: JSON.stringify(input) }
    }),
    getQueuePosition: vi.fn(() => ({ position: 3, total: 5 })),
    runTaskNow: vi.fn(async (id: string) => { runNow.push(id); return { id } }),
    cancelTask: vi.fn((id: string) => { cancelled.push(id); return { id, status: 'cancelled' } }),
    markTaskStartedLocally: vi.fn(),
  } as unknown as OffPeakSaver
  return { saver, created, runNow, cancelled }
}

function makeCtx() {
  const listeners: Array<{ event: string; handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> }> = []
  const ctx = {
    on: vi.fn((event: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.push({ event, handler })
      return () => {}
    }),
  } as unknown as Parameters<typeof installAutoRouting>[0]
  return { ctx, listeners }
}

function userMessage(text: string) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function pluginMessage(text: string) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-offpeak-saver' },
  }
}

function waitForScheduledWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

async function dispatch(listeners: Array<{ event: string; handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> }>, messages: unknown[]) {
  const handler = listeners.find((l) => l.event === 'agent/pre-step')
  if (handler === undefined) throw new Error('listener not installed')
  const next = vi.fn(async () => ({ kind: 'enter', messages }))
  const appended: Array<{ type: string; data: unknown; options: unknown }> = []
  const result = await handler.handler({
    agent: {
      id: 'session-1',
      session: {
        header: { cwd: 'D:\\我的文件夹\\Game_Projects(by GODOT)' },
        append: (type: string, data: unknown, options: unknown) => {
          appended.push({ type, data, options })
        },
      },
      whenIdle: async () => {},
      cancel: () => {},
    },
    messages,
    turn: 3,
    step: 1,
  }, next)
  return { result, next, appended }
}

describe('installAutoRouting', () => {
  it('注册 agent/pre-step 监听', () => {
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, makeSaver('offpeak').saver)
    expect(listeners.some((l) => l.event === 'agent/pre-step')).toBe(true)
  })

  it('错峰时段：文档任务直接放行给当前会话（不创建调度器任务，无 running 残留）', async () => {
    const { saver, created, runNow } = makeSaver('offpeak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    const { result, next } = await dispatch(listeners, [userMessage('帮我把项目结构总结成 Markdown 报告')])
    expect(created.length).toBe(0) // 错峰时段不创建任务
    expect(runNow).toEqual([])
    expect(saver.markTaskStartedLocally).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'enter' }) // 放行给当前会话
    expect(next).toHaveBeenCalled()
  })

  it('高峰时段：文档任务自动排队，调度器直接写入确认而不把控制提示交给模型', async () => {
    const { saver, created, runNow } = makeSaver('peak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    const { result, next, appended } = await dispatch(listeners, [userMessage('写一份本周工作总结')])
    expect(created.length).toBe(1)
    expect(created[0].priority).toBe(1)
    expect(created[0].input.session_id).toBe('session-1')
    expect(created[0].input.cwd).toBe('D:\\我的文件夹\\Game_Projects(by GODOT)')
    expect(runNow).toEqual([])
    expect(next).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'enter', messages: [] })
    expect(appended.map((event) => event.type)).toEqual(['user/message', 'assistant/message'])
    expect((appended[0].data as { content: Array<{ text: string }> }).content[0].text).toBe('写一份本周工作总结')
    const reply = (appended[1].data as { message: { content: Array<{ text: string }>; source: { provider: string } } }).message
    expect(reply.content[0].text).toBe('当前是高峰时段，已帮您安排到今日 18:00错峰执行（享半价折扣）。\n队列第 3 位（共 5 项），可在仪表盘调整顺序。\n如需立即处理，请回复“现在做”；如需取消，请回复“取消”。')
    expect(reply.content[0].text).not.toContain('不要执行任何任务')
    expect(reply.source.provider).toBe('dsh-offpeak-saver')
  })

  it('交互式任务放行，不创建任务', async () => {
    const { saver, created } = makeSaver('peak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    const { next } = await dispatch(listeners, [userMessage('帮我修复这个 bug')])
    expect(created.length).toBe(0)
    expect(next).toHaveBeenCalled()
  })

  it('插件自己的通知消息放行，不递归拦截', async () => {
    const { saver, created } = makeSaver('peak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    const { next } = await dispatch(listeners, [pluginMessage('[OFFPEAK-SAVER 自动分流] 已把任务排入队列')])
    expect(created.length).toBe(0)
    expect(next).toHaveBeenCalled()
  })

  it('回复“现在做”先结束确认回合，再提级执行，避免与当前 pre-step 竞争', async () => {
    const { saver, runNow } = makeSaver('peak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    // 先排队一个任务
    await dispatch(listeners, [userMessage('写一份本周工作总结')])
    expect(saver.createQueuedTask).toHaveBeenCalledTimes(1)

    // 用户回复“现在做”
    const { result, next, appended } = await dispatch(listeners, [userMessage('现在做')])
    // 执行不能在当前 pre-step 内抢跑，否则 agent 还没真正 idle。
    expect(runNow).toEqual([])
    expect(next).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'enter', messages: [] })
    expect((appended[1].data as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe('好的！开始执行——')
    await waitForScheduledWork()
    expect(runNow).toEqual(['task-auto-1'])
  })

  it('回复“取消”撤销任务，并由调度器直接确认（不请求模型）', async () => {
    const { saver, cancelled } = makeSaver('peak')
    const { ctx, listeners } = makeCtx()
    installAutoRouting(ctx, saver)

    await dispatch(listeners, [userMessage('写一份本周工作总结')])
    const { result, next, appended } = await dispatch(listeners, [userMessage('取消')])
    expect(cancelled).toEqual(['task-auto-1'])
    expect(next).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'enter', messages: [] })
    expect((appended[1].data as { message: { content: Array<{ text: string }> } }).message.content[0].text).toContain('已取消排队任务')
  })
})
