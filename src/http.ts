/**
 * Host 半：为 Web 面板提供 JSON API（/offpeak-saver/*）。
 * 只读概览 + 取消任务，不暴露明文密钥。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OffPeakSaver } from './core.js'
import type { WebServerService } from './web-server.js'

interface PanelOverview {
  now: string
  phase: 'peak' | 'offpeak'
  nextOffPeak: string | null
  pending: unknown[]
  running: unknown[]
  recent: unknown[]
  reports: {
    day: unknown
    week: unknown
    month: unknown
  }
}

function priorityFromString(raw: string | undefined): number {
  switch (raw) {
    case 'realtime': return 0
    case 'background': return 2
    default: return 1
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(json)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid json')
  }
  return parsed as Record<string, unknown>
}

/** 注册面板 API；返回卸载函数。 */
export function registerPanelHttp(ctx: Context, saver: OffPeakSaver, server: WebServerService | undefined): () => void {
  if (server === undefined) {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.('offpeak-saver: 无 webServer，跳过面板 API（headless 模式正常）')
    return () => {}
  }

  // SSE 订阅者：任务状态变化实时推给浏览器面板
  const subscribers = new Set<ServerResponse>()
  const unsubscribeEvents = saver.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of subscribers) {
      if (!res.writableEnded) {
        try {
          res.write(payload)
        } catch {
          // 客户端断开
        }
      }
    }
  })

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host ?? '127.0.0.1'
    const url = new URL(req.url ?? '/offpeak-saver', `http://${host}`)
    const route = url.pathname.replace(/\/+$/, '') || '/offpeak-saver'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    try {
      if (method === 'GET' && route === '/offpeak-saver/events') {
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.setHeader('connection', 'keep-alive')
        res.write(': connected\n\n')
        res.flushHeaders?.()
        subscribers.add(res)
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n')
        }, 25_000)
        const onClose = (): void => {
          clearInterval(heartbeat)
          subscribers.delete(res)
        }
        res.on('close', onClose)
        return
      }

      if (method === 'GET' && route === '/offpeak-saver/overview') {
        const now = new Date()
        const { pending, running, recent } = saver.listTasks()
        const overview: PanelOverview = {
          now: now.toISOString(),
          phase: saver.currentPhase(),
          nextOffPeak: saver.nextOffPeak()?.label ?? null,
          pending,
          running,
          recent,
          reports: {
            day: saver.getReport('day'),
            week: saver.getReport('week'),
            month: saver.getReport('month'),
          },
        }
        send(res, 200, { ok: true, value: overview })
        return
      }

      if (method === 'POST' && route === '/offpeak-saver/cancel') {
        const body = await readJson(req)
        const id = typeof body.taskId === 'string' ? body.taskId : ''
        if (id === '') {
          send(res, 400, { ok: false, error: 'taskId 不能为空' })
          return
        }
        const task = saver.cancelTask(id)
        if (task === null) {
          send(res, 404, { ok: false, error: `未找到任务 ${id}` })
          return
        }
        send(res, 200, { ok: true, value: { id, status: task.status } })
        return
      }

      if (method === 'POST' && route === '/offpeak-saver/submit') {
        const body = await readJson(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          send(res, 400, { ok: false, error: 'prompt 不能为空' })
          return
        }
        const priority = priorityFromString(typeof body.priority === 'string' ? body.priority : undefined)
        const result = await saver.submitTask(
          {
            prompt,
            title: typeof body.title === 'string' ? body.title : undefined,
            model: typeof body.model === 'string' ? body.model : undefined,
            output_path: typeof body.outputPath === 'string' ? body.outputPath : undefined,
            params: {
              temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
              max_tokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
            },
          },
          priority as 0 | 1 | 2,
        )
        const task = result.task
        send(res, 200, {
          ok: true,
          value: {
            task_id: task.id,
            status: task.status,
            priority,
            message: priority === 0
              ? `✅ 完成 | 实际花费 ¥${task.cost_actual.toFixed(4)} | 节省 ¥${task.savings.toFixed(4)}`
              : `已加入错峰队列（${task.id.slice(0, 8)}…），${saver.nextOffPeak()?.label ?? '下一空闲时段'}开始执行`,
          },
        })
        return
      }

      send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      send(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const disposeRoute = server.register({ kind: 'prefix', path: '/offpeak-saver', handler })
  return () => {
    disposeRoute()
    unsubscribeEvents()
    for (const res of subscribers) {
      try {
        res.end()
      } catch {
        // 已关闭
      }
    }
    subscribers.clear()
  }
}

/**
 * 等待 webServer 服务就绪后注册面板 API。
 * Cordis 服务可能晚于本插件 apply 激活，因此轮询探测；headless 下没有
 * webServer，探测超时后放弃（不影响工具与调度）。
 */
export function registerPanelHttpWhenReady(ctx: Context, saver: OffPeakSaver): () => void {
  const getServer = (): WebServerService | undefined =>
    (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown })
      .get?.('webServer', false) as WebServerService | undefined

  let disposeHttp: (() => void) | null = null
  let timer: NodeJS.Timeout | null = null
  let attempts = 0
  let disposed = false

  const tryRegister = (): void => {
    if (disposed || disposeHttp !== null) return
    const server = getServer()
    if (server !== undefined) {
      disposeHttp = registerPanelHttp(ctx, saver, server)
      if (timer !== null) clearInterval(timer)
      timer = null
      return
    }
    attempts++
    if (attempts >= 60) {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
  }

  tryRegister()
  if (disposeHttp === null && timer === null && attempts < 60) {
    timer = setInterval(tryRegister, 500)
  }

  return () => {
    disposed = true
    if (timer !== null) clearInterval(timer)
    disposeHttp?.()
  }
}
