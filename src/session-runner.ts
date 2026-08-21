/**
 * 会话内执行器（B 方案）：
 * 在 Harness 原生会话里唤醒 agent 执行任务，过程可见、可打断、可续聊；
 * 执行后从会话事件提取回复文本与 TokenUsage 用于计费。
 *
 * 依赖 dsh 的 agents / session 服务，运行时由 dsh 提供；
 * 这里只声明最小类型面，避免把 dsh 运行时包变成构建依赖。
 */

import type { TaskPayload } from './db.js'

/** 会话事件里 assistant/message 的 usage 形状（dsh TokenUsage）。 */
export interface SessionTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 一次会话执行的产出。 */
export interface SessionRunResult {
  /** 执行期间全部 assistant 文本（多轮拼接）。 */
  content: string
  /** 执行期间全部 usage 汇总。 */
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }
  /** 执行所用的会话 id（新会话为 create 的 id，原会话为 resume 的 id）。 */
  sessionId: string
}

/** 流式增量：reasoning = 思考过程，text = 最终回复。 */
export interface SessionStreamDelta {
  kind: 'text' | 'reasoning'
  text: string
}

/** 执行器需要的会话运行能力（core 注入；测试可 mock）。 */
export interface SessionRunner {
  runTask(
    payload: TaskPayload,
    signal: AbortSignal,
    model?: string,
    onStream?: (delta: SessionStreamDelta) => void,
  ): Promise<SessionRunResult>
  /**
   * 在原会话（live agent）里唤醒执行：任务排队时注册的会话仍存活则直接
   * followup 注入，用户在原对话中即可看到执行过程与结果。
   * 返回 null 表示该会话不在注册表（已关闭/重启/删除），由调用方回退独立会话。
   */
  runInLiveSession?(
    payload: TaskPayload,
    signal: AbortSignal,
    model?: string,
    onStream?: (delta: SessionStreamDelta) => void,
  ): Promise<SessionRunResult | null>
  /** 注册一个 live agent（auto-route 在用户消息 pre-step 时调用）。 */
  registerAgent?(agent: AgentLike): void
  /** 注销一个 live agent（agent 销毁时调用）。 */
  unregisterAgent?(agentId: string): void
  cancelAll(): void
}

/** 会话服务的最小类型面（dsh 运行时提供）。 */
interface AgentsService {
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: { model?: string; maxTokens?: number }
    signal?: AbortSignal
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { model?: string; maxTokens?: number }
    signal?: AbortSignal
  }): Promise<AgentHandle>
  /** 查询 live agent 是否仍在注册表。 */
  get?(id: string): unknown
}

/** create/resume 返回的已发布句柄。 */
interface AgentHandle {
  agent: AgentLike
  dispose?: () => void
}

/** Agent 的最小类型面。 */
interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  followup(message: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'user' }): void
}

interface SessionLike {
  readonly events: Array<{
    seq: number
    type: string
    data?: {
      turn?: number
      step?: number
      message?: {
        content?: Array<{ type?: string; text?: string }>
      }
      usage?: SessionTokenUsage
      chunk?: {
        type?: string
        index?: number
        text?: string
      }
    }
  }>
}

export class CancelledSessionError extends Error {
  constructor() {
    super('会话内执行已被取消')
    this.name = 'CancelledSessionError'
  }
}

/** 空内容或缺失 usage 时抛出，由执行器按失败处理。 */
export class SessionOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionOutputError'
  }
}

/** 真实实现：驱动 dsh agents 服务。 */
export function createDshSessionRunner(ctx: unknown): SessionRunner {
  const agents = (ctx as { get?: (name: string, strict?: boolean) => unknown })
    .get?.('agents', false) as AgentsService | undefined
  if (agents === undefined) {
    throw new Error('offpeak-saver: 需要 agents 服务才能使用会话内执行模式')
  }

  const activeAgents = new Set<AgentLike>()
  // 用户会话注册表：sessionId -> live Agent（方案 B：错峰到点在原对话唤醒执行）
  const liveAgents = new Map<string, AgentLike>()

  // agent 销毁时自动清理注册表，避免悬挂引用
  const ctxAny = ctx as { on?: (event: string, handler: (payload: { agent?: { id?: string } }) => void) => void }
  ctxAny.on?.('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) liveAgents.delete(String(agent.id))
  })

  /** 唤醒一个 live agent 执行任务（不 create/resume，直接 followup）。 */
  async function wakeAgent(
    agent: AgentLike,
    payload: TaskPayload,
    signal: AbortSignal,
    model?: string,
    onStream?: (delta: SessionStreamDelta) => void,
  ): Promise<SessionRunResult> {
    const cursor = agent.session.events.length
    const abortHandler = (): void => {
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        // agent 可能已收尾
      }
    }
    signal.addEventListener('abort', abortHandler, { once: true })

    let pollTimer: ReturnType<typeof setInterval> | null = null
    let seenSeq = cursor
    const pollAndEmit = (): void => {
      const events = agent.session.events
      if (events.length <= seenSeq) return
      const fresh = events.slice(seenSeq)
      seenSeq = events.length
      if (onStream === undefined) return
      for (const delta of extractStreamDeltas(fresh)) {
        onStream(delta)
      }
    }
    const startPolling = (): void => {
      if (onStream === undefined) return
      pollTimer = setInterval(pollAndEmit, 120)
    }
    const stopPolling = (): void => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    try {
      agent.followup({
        content: [{ type: 'text', text: payload.prompt }],
        source: { kind: 'plugin', plugin: 'dsh-offpeak-saver' },
      })
      startPolling()
      await agent.whenIdle()
      stopPolling()
      pollAndEmit()
      if (signal.aborted) throw new CancelledSessionError()

      const { content, usage } = extractSessionOutput(agent.session.events.slice(cursor))
      if (content.trim() === '') {
        throw new SessionOutputError('agent 会话内执行未产生回复内容')
      }
      return { content, usage, sessionId: agent.id }
    } finally {
      stopPolling()
      signal.removeEventListener('abort', abortHandler)
    }
  }

  return {
    async runTask(
      payload: TaskPayload,
      signal: AbortSignal,
      model?: string,
      onStream?: (delta: SessionStreamDelta) => void,
    ): Promise<SessionRunResult> {
      const startedEvents = Date.now()
      const options = {
        provider: 'deepseek-official',
        model: model ?? payload.model,
        maxTokens: payload.params?.max_tokens,
      }

      let handle: AgentHandle
      if (payload.session_id !== undefined && payload.session_id !== '') {
        handle = await agents.resume({
          resumeSessionId: payload.session_id,
          agentOptions: options,
          signal,
        })
      } else {
        const newId = `offpeak-${startedEvents.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        handle = await agents.create({
          sessionId: newId,
          meta: { cwd: payload.cwd ?? process.cwd() },
          agentOptions: options,
          signal,
        })
      }
      const agent = handle.agent
      activeAgents.add(agent)

      const cursor = agent.session.events.length
      const abortHandler = (): void => {
        try {
          agent.cancel({ kind: 'user' })
        } catch {
          // agent 可能已收尾
        }
      }
      signal.addEventListener('abort', abortHandler, { once: true })

      let pollTimer: ReturnType<typeof setInterval> | null = null
      let seenSeq = cursor
      const pollAndEmit = (): void => {
        const events = agent.session.events
        if (events.length <= seenSeq) return
        const fresh = events.slice(seenSeq)
        seenSeq = events.length
        if (onStream === undefined) return
        for (const delta of extractStreamDeltas(fresh)) {
          onStream(delta)
        }
      }
      const startPolling = (): void => {
        if (onStream === undefined) return
        pollTimer = setInterval(pollAndEmit, 120)
      }
      const stopPolling = (): void => {
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      try {
        agent.followup({
          content: [{ type: 'text', text: payload.prompt }],
          source: { kind: 'plugin', plugin: 'dsh-offpeak-saver' },
        })
        startPolling()
        await agent.whenIdle()
        stopPolling()
        // 收尾时补扫最后一批事件（interval 可能还没触发）
        pollAndEmit()
        if (signal.aborted) throw new CancelledSessionError()

        const { content, usage } = extractSessionOutput(agent.session.events.slice(cursor))
        if (content.trim() === '') {
          throw new SessionOutputError('agent 会话内执行未产生回复内容')
        }
        return {
          content,
          usage,
          sessionId: agent.id,
        }
      } finally {
        stopPolling()
        signal.removeEventListener('abort', abortHandler)
        activeAgents.delete(agent)
      }
    },

    cancelAll(): void {
      for (const agent of activeAgents) {
        try {
          agent.cancel({ kind: 'user' })
        } catch {
          // 忽略
        }
      }
    },

    registerAgent(agent: AgentLike): void {
      if (agent.id !== undefined) liveAgents.set(String(agent.id), agent)
    },

    unregisterAgent(agentId: string): void {
      liveAgents.delete(agentId)
    },

    async runInLiveSession(
      payload: TaskPayload,
      signal: AbortSignal,
      model?: string,
      onStream?: (delta: SessionStreamDelta) => void,
    ): Promise<SessionRunResult | null> {
      if (payload.session_id === undefined || payload.session_id === '') return null
      const agent = liveAgents.get(payload.session_id)
      if (agent === undefined) return null
      // 确认 agent 仍在 live registry 中（dsh agents.get 可查）
      const stillLive = agents.get?.(String(agent.id)) !== undefined
      if (!stillLive) {
        liveAgents.delete(String(agent.id))
        return null
      }
      activeAgents.add(agent)
      try {
        return await wakeAgent(agent, payload, signal, model, onStream)
      } finally {
        activeAgents.delete(agent)
      }
    },
  }
}

/** 从新增会话事件里提取流式增量（assistant/chunk 的 text/reasoning delta）。 */
export function extractStreamDeltas(events: SessionLike['events']): SessionStreamDelta[] {
  const deltas: SessionStreamDelta[] = []
  for (const event of events) {
    if (event.type !== 'assistant/chunk' || event.data === undefined) continue
    const chunk = event.data.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      deltas.push({ kind: 'text', text: chunk.text })
    } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      deltas.push({ kind: 'reasoning', text: chunk.text })
    }
  }
  return deltas
}

/** 从新增会话事件提取文本与 usage 汇总。 */
export function extractSessionOutput(events: SessionLike['events']): {
  content: string
  usage: SessionRunResult['usage']
} {
  let content = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let sawAssistant = false

  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data === undefined) continue
    sawAssistant = true
    for (const block of event.data.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content += block.text
      }
    }
    const usage = event.data.usage
    if (usage !== undefined) {
      inputTokens += toNonNegative(usage.inputTokens)
      outputTokens += toNonNegative(usage.outputTokens)
      cacheReadTokens += toNonNegative(usage.cacheReadTokens)
    }
  }

  if (!sawAssistant) {
    throw new SessionOutputError('agent 会话内执行未产生 assistant 消息')
  }
  if (inputTokens === 0 && outputTokens === 0) {
    throw new SessionOutputError('agent 会话内执行缺少 usage 计费数据')
  }
  return { content, usage: { inputTokens, outputTokens, cacheReadTokens } }
}

function toNonNegative(value: number | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}
