import { describe, expect, it } from 'vitest'
import { extractSessionOutput, extractStreamDeltas, SessionOutputError } from '../src/session-runner.js'

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
