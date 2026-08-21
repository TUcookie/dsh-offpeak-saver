import { describe, expect, it, vi } from 'vitest'
import { extractSessionOutput, extractStreamDeltas, SessionOutputError, createDshSessionRunner } from '../src/session-runner.js'

function assistantEvent(seq: number, text: string, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }) {
  return {
    seq,
    type: 'assistant/message',
    data: {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'text', text }] },
      usage,
    },
  }
}

describe('extractSessionOutput', () => {
  it('汇总多轮 assistant 文本与 usage', () => {
    const result = extractSessionOutput([
      assistantEvent(1, '第一段', { inputTokens: 100, outputTokens: 50 }),
      assistantEvent(2, '第二段', { inputTokens: 40, outputTokens: 10, cacheReadTokens: 30 }),
    ])
    expect(result.content).toBe('第一段第二段')
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 60, cacheReadTokens: 30 })
  })

  it('无 assistant 消息抛错', () => {
    expect(() => extractSessionOutput([])).toThrow(SessionOutputError)
    expect(() => extractSessionOutput([{ seq: 1, type: 'user/message', data: {} }])).toThrow(SessionOutputError)
  })

  it('usage 全为 0 视为计费数据缺失并抛错', () => {
    expect(() => extractSessionOutput([assistantEvent(1, 'text', { inputTokens: 0, outputTokens: 0 })])).toThrow(
      /缺少 usage/,
    )
  })

  it('usage 中负值/非法值归零，但有效值仍参与计费', () => {
    const result = extractSessionOutput([
      assistantEvent(1, 'x', { inputTokens: -5, outputTokens: 20 }),
    ])
    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(20)
  })
})

describe('extractStreamDeltas', () => {
  it('提取 text-delta 与 reasoning-delta 增量', () => {
    const deltas = extractStreamDeltas([
      { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: '思考' } } },
      { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 1, text: '回答' } } },
      { seq: 3, type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0 } } },
      { seq: 4, type: 'turn/end', data: {} },
    ])
    expect(deltas).toEqual([
      { kind: 'reasoning', text: '思考' },
      { kind: 'text', text: '回答' },
    ])
  })

  it('忽略空文本与其他事件', () => {
    expect(extractStreamDeltas([])).toEqual([])
    expect(extractStreamDeltas([
      { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '' } } },
      { seq: 2, type: 'user/message', data: {} },
    ])).toEqual([])
  })
})

describe('方案 B：原会话唤醒执行', () => {
  function makeFakeAgent(initialEvents: unknown[] = []) {
    const events = [...initialEvents]
    let idleResolvers: Array<() => void> = []
    const agent = {
      id: 'session-live-1',
      session: { events },
      followup: vi.fn(() => {
        // 模拟 followup 后 agent 产生 assistant 消息
        events.push(
          { seq: events.length, type: 'assistant/message', data: {
            message: { content: [{ type: 'text', text: '原会话产出的结果' }] },
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
          } },
        )
        for (const resolve of idleResolvers.splice(0)) resolve()
      }),
      whenIdle: vi.fn(async () => {
        if (events.some((e) => (e as { type?: string }).type === 'assistant/message')) return
        await new Promise<void>((resolve) => { idleResolvers.push(resolve) })
      }),
      cancel: vi.fn(),
    }
    return agent
  }

  function makeCtx(agents: { get?: () => unknown }) {
    return {
      get: (name: string) => name === 'agents' ? agents : undefined,
      on: () => {},
    }
  }

  it('注册 agent 后，runInLiveSession 在原会话 followup 唤醒并提取结果', async () => {
    const fakeAgent = makeFakeAgent()
    const runner = createDshSessionRunner(makeCtx({ get: () => fakeAgent }))
    runner.registerAgent?.(fakeAgent)

    const result = await runner.runInLiveSession!(
      { prompt: '总结项目', session_id: 'session-live-1' },
      new AbortController().signal,
      'deepseek-v4-flash',
    )

    expect(fakeAgent.followup).toHaveBeenCalledTimes(1)
    expect(fakeAgent.followup.mock.calls[0][0].content[0].text).toBe('总结项目')
    expect(result).not.toBeNull()
    expect(result!.content).toContain('原会话产出的结果')
    expect(result!.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 })
    expect(result!.sessionId).toBe('session-live-1')
  })

  it('插件重启后从 Harness 运行时注册表恢复在线会话，不会回退 resume', async () => {
    const fakeAgent = makeFakeAgent()
    // 模拟新的插件实例：liveAgents 为空，但 Harness 仍持有原会话。
    const runner = createDshSessionRunner(makeCtx({ get: () => fakeAgent }))

    const result = await runner.runInLiveSession!(
      { prompt: '重启后继续执行', session_id: 'session-live-1' },
      new AbortController().signal,
    )

    expect(fakeAgent.followup).toHaveBeenCalledTimes(1)
    expect(result?.content).toContain('原会话产出的结果')
  })

  it('agent 不在注册表时返回 null（调用方回退独立会话）', async () => {
    const runner = createDshSessionRunner(makeCtx({ get: () => undefined }))
    const result = await runner.runInLiveSession!(
      { prompt: '任务', session_id: 'session-gone' },
      new AbortController().signal,
    )
    expect(result).toBeNull()
  })

  it('未指定 session_id 时返回 null', async () => {
    const runner = createDshSessionRunner(makeCtx({ get: () => undefined }))
    const result = await runner.runInLiveSession!(
      { prompt: '任务' },
      new AbortController().signal,
    )
    expect(result).toBeNull()
  })

  it('unregisterAgent 后不再唤醒', async () => {
    const fakeAgent = makeFakeAgent()
    const runner = createDshSessionRunner(makeCtx({ get: () => undefined }))
    runner.registerAgent?.(fakeAgent)
    runner.unregisterAgent?.('session-live-1')
    const result = await runner.runInLiveSession!(
      { prompt: '任务', session_id: 'session-live-1' },
      new AbortController().signal,
    )
    expect(result).toBeNull()
  })
})
