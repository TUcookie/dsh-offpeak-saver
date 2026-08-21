/**
 * 无感自动分流：用户只需要说任务本身，插件自动判断
 * - 可延后任务 + 高峰时段 → 自动排入错峰队列（半价），并告知用户可“现在做”
 * - 可延后任务 + 错峰时段 → 自动交给调度器立即执行（半价 + 完整计费统计）
 * - 交互式 / 紧急 / 问答 → 放行，模型正常处理
 *
 * 通过 dsh 的 agent/pre-step waterfall 拦截实现：命中时直接写入会话记录，
 * 再以空消息完成本轮，不把调度控制语传给模型。
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { OffPeakSaver } from './core.js'
import type { SessionRunner } from './session-runner.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 与 dsh-agent 的 agent/pre-step 一致的最小面（插件构建不依赖 dsh-agent 类型）。 */
    'agent/pre-step'(
      this: unknown,
      payload: {
        agent: {
          id: string
          session?: {
            header?: { cwd?: string }
            append?: (type: string, data: unknown, options?: unknown) => unknown
          }
          followup(message: { role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown> }): void
          whenIdle(): Promise<void>
          cancel(cause: { kind: 'user' }): void
        }
        messages: Array<{
          role?: string
          content?: Array<{ type?: string; text?: string }>
          source?: { kind?: string; plugin?: string }
        }>
        turn: number
        step: number
      },
      next: () => Promise<unknown>,
    ): Promise<unknown>
  }
}

/** 适合自动错峰的任务关键词（命中即视为可延后的批处理/文档类任务）。 */
const DEFER_KEYWORDS = [
  '总结', '摘要', '报告', '文档', '周报', '月报', '日报', '复盘', '纪要', '记录',
  '笔记', '归档', '备份', '导出', '整理', '汇总', '翻译', '改写', '润色', '草稿',
  '大纲', '计划', '规划', '方案', '调研', '梳理', '批量', '清单', '列表', '目录',
  '索引', '介绍', '说明', '重构', '迁移', '批量处理', '架构分析',
]

/** 交互式任务关键词（命中即放行，让模型立即处理）。优先级高于 DEFER。 */
const INTERACTIVE_KEYWORDS = [
  '修复', '修一下', '调试', '实现', '写代码', '运行', '执行', '测试', '审查',
  '解释', '回答', '看看', '检查', '部署', '提交', '推送', '发布', '改一下',
  '更新', '删除', '创建', '报错', '错误',
]

const URGENT_RE = /(立即|马上|尽快|现在就?做|现在做|紧急|urgent|realtime)/i
const QUESTION_RE = /[？?]$|^(怎么|如何|为什么|什么|哪些|是否|能不能|可以吗|请问|帮我看看|解释一下)/

/** 判断一条用户消息该被自动分流到错峰，还是放行。 */
export function classifyTask(text: string): 'defer' | 'immediate' | 'skip' {
  const t = text.trim()
  if (t.length < 6) return 'skip'
  if (QUESTION_RE.test(t)) return 'skip'
  if (URGENT_RE.test(t)) return 'immediate'
  if (INTERACTIVE_KEYWORDS.some((keyword) => t.includes(keyword))) return 'skip'
  if (DEFER_KEYWORDS.some((keyword) => t.includes(keyword))) return 'defer'
  return 'skip'
}

/** 用户回复“现在做”的快捷指令。 */
const RUN_NOW_RE = /^(现在|立即|马上)(做|执行|跑)?[！!。.]?$|^现在(就)?做[！!。.]?$/
/** 用户回复“取消/算了”的快捷指令。 */
const CANCEL_RE = /^(取消|算了|不做了|撤销)(刚才那个|这个|上一个)?[！!。.]?$/

function extractText(message: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim()
}

/**
 * 直接把“已排队”写进会话记录，并让本轮以空步骤正常结束。
 *
 * 不能把这类控制文案伪装成第二条 user 消息交给模型：模型会把它当作
 * 不可信提示词来审视，既浪费 tokens，也可能把审视过程流式展示给用户。
 * 这里保留用户原话，再写入一个由调度器生成的 assistant 消息；模型完全
 * 不参与这次确认。到错峰时间后，SessionRunner 才会把原任务作为新消息
 * 唤醒到同一会话里执行。
 */
function recordSchedulerReply(
  agent: {
    session?: {
      append?: (type: string, data: unknown, options?: unknown) => unknown
    }
  },
  userMessage: {
    role?: string
    content?: Array<{ type?: string; text?: string }>
    source?: { kind?: string; plugin?: string }
  },
  reply: string,
  turn: number,
  step: number,
): boolean {
  const session = agent.session
  if (typeof session?.append !== 'function') return false

  session.append('user/message', userMessage, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step,
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: reply }],
      source: {
        kind: 'model',
        provider: 'dsh-offpeak-saver',
        model: 'scheduler',
      },
    },
  }, {
    surfaceOp: 'append',
    sourceEventSeqs: [],
  })
  return true
}

/**
 * 当前 pre-step 仍在运行时，不能立刻对同一个 agent followup：Harness 此时
 * 的 whenIdle 可能把这条尚未收尾的确认回合当作完成，导致执行器读不到
 * 新的 assistant 消息。延迟到本轮回调返回后，再等待 agent 确实 idle。
 */
function runTaskAfterConfirmation(
  agent: { whenIdle?: () => Promise<void> },
  saver: OffPeakSaver,
  taskId: string,
  onError: (error: unknown) => void,
): void {
  setTimeout(() => {
    void (async () => {
      await agent.whenIdle?.()
      await saver.runTaskNow(taskId)
    })().catch(onError)
  }, 0)
}

/**
 * 安装自动分流。返回清理函数（在插件 effect 中调用）。
 */
export function installAutoRouting(ctx: Context, saver: OffPeakSaver, sessionRunner?: SessionRunner): () => void {
  // sessionId -> 最近一次自动排队（或已启动）的任务 id
  const autoQueued = new Map<string, string>()

  const listener = async (
      payload: {
        agent: {
          id: string
          session?: {
            header?: { cwd?: string }
            append?: (type: string, data: unknown, options?: unknown) => unknown
          }
          followup(message: { role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown> }): void
          whenIdle(): Promise<void>
        }
        messages: Array<{
        role?: string
        content?: Array<{ type?: string; text?: string }>
        source?: { kind?: string; plugin?: string }
      }>
      turn: number
      step: number
    },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const message = payload.messages[0]
      if (message === undefined) return next()
      // 插件自己注入的通知消息一律放行，防止递归拦截
      if (message.source?.kind === 'plugin') return next()

      const text = extractText(message)
      if (text === '') return next()
      const agentId = String(payload.agent.id)

      // 快捷指令：现在做 → 把最近自动排队的任务提级立即执行
      if (RUN_NOW_RE.test(text)) {
        const taskId = autoQueued.get(agentId)
        if (taskId !== undefined) {
          const reply = '正在为你立即执行该任务。执行过程会显示在当前会话，完成后可在错峰省钱面板查看结果与节省金额。'
          if (!recordSchedulerReply(payload.agent, message, reply, payload.turn, payload.step)) return next()
          autoQueued.delete(agentId)
          runTaskAfterConfirmation(payload.agent, saver, taskId, (error) => {
            const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
            logger?.warn?.(`[offpeak-saver] 立即执行任务 ${taskId} 失败：${error instanceof Error ? error.message : String(error)}`)
          })
          return { kind: 'enter', messages: [] }
        }
        return next()
      }

      // 快捷指令：取消 → 取消最近自动排队的任务
      if (CANCEL_RE.test(text)) {
        const taskId = autoQueued.get(agentId)
        if (taskId !== undefined) {
          const reply = '已取消排队任务。'
          if (!recordSchedulerReply(payload.agent, message, reply, payload.turn, payload.step)) return next()
          autoQueued.delete(agentId)
          saver.cancelTask(taskId)
          return { kind: 'enter', messages: [] }
        }
        return next()
      }

      if (classifyTask(text) !== 'defer') return next()

      const phase = saver.currentPhase()
      const cwd = payload.agent.session?.header?.cwd

      if (phase === 'offpeak') {
        // 错峰时段：本来就是半价，直接放行给当前会话原样执行。
        // 不创建调度器任务，避免 running 残留与重复计费。
        return await next()
      }

      // 高峰时段：排队到错峰（半价）。确认由插件直接写入会话，不请求模型。
      const priority = 1
      // 方案 B：记住任务属于哪个会话；并把 live agent 注册进执行器，
      // 错峰到点后直接在原对话唤醒执行（而不是另开独立会话）。
      // 先确认运行时能写入 Session，再入队；否则让原会话照常处理，绝不产生
      // 一个用户看不到确认、也无法“现在做/取消”的隐藏任务。
      if (typeof payload.agent.session?.append !== 'function') return next()

      const task = saver.createQueuedTask({ prompt: text, cwd, session_id: agentId }, priority)
      sessionRunner?.registerAgent?.(payload.agent as Parameters<NonNullable<SessionRunner['registerAgent']>>[0])
      autoQueued.set(agentId, task.id)
      const nextOff = saver.nextOffPeak()
      const label = nextOff?.label ?? '下一空闲时段'
      const reply = `现在已处于高峰时段，已为您排队到错峰时段执行（${label}，半价）。若需要立即执行，请回复“现在做”；若需要取消该任务，请回复“取消”。`
      if (!recordSchedulerReply(payload.agent, message, reply, payload.turn, payload.step)) {
        // 未知/不兼容运行时没有公开 Session.append 时宁可放行，不创建隐藏队列，
        // 避免“已经排队”却不给用户任何确认。
        saver.cancelTask(task.id)
        autoQueued.delete(agentId)
        return next()
      }
      return { kind: 'enter', messages: [] }
    } catch (error) {
      const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
      logger?.warn?.(`[offpeak-saver] 自动分流失败，已放行消息：${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  }

  // cordis 事件系统在运行时接受该 key；类型经 declare module 合并。
  ;(ctx as unknown as {
    on(
      event: 'agent/pre-step',
      handler: typeof listener,
    ): () => void
  }).on('agent/pre-step', listener)

  return () => {
    autoQueued.clear()
  }
}
