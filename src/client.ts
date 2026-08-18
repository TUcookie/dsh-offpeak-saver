/**
 * DeepSeek Chat Completions 客户端：单次请求 + 超时 + 错误分类。
 *
 * 重试策略属于执行器（executor），客户端不做内部重试：
 * - 避免两层退避互不知情导致同一任务最坏打 16 次 API；
 * - 超时类错误标记为不可重试，防止“服务器已处理但本地超时”导致二次扣费。
 */

export interface ClientConfig {
  /** 每次请求动态读取的根地址（热更新/环境变化即时生效）。 */
  getBaseUrl: () => string
  /** 每次请求动态读取的超时（毫秒）。 */
  getTimeoutMs: () => number
  apiKey: string
  /** 每次调用时解析密钥的钩子（如 dsh credentials 服务），可为空。 */
  apiKeyResolver?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
  /** 时钟注入（测试用），默认 new Date()。 */
  now?: () => Date
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

export interface ChatResult {
  content: string
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_hit_tokens: number
  }
  /** 请求实际发起的时刻（计费时段的唯一依据）。 */
  startedAt: Date
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('offpeak-saver: 请求已被取消')
    this.name = 'CancelledError'
  }
}

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export class DeepSeekClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly config: ClientConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.now = config.now ?? (() => new Date())
  }

  /** 单次请求：发起时打点，返回 usage 与 startedAt。 */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = await this.resolveApiKey()
    if (apiKey === '') {
      throw new ApiError(
        '未配置 DeepSeek API Key：请在插件配置中设置 api_key，或通过 dsh credentials 服务 / DEEPSEEK_API_KEY 环境变量提供',
        401,
        false,
      )
    }
    if (signal?.aborted) throw new CancelledError()

    // 计费时刻：请求发往服务器的时刻（DeepSeek 以服务端接收时刻判定峰谷）
    const startedAt = this.now()
    const endpoint = `${this.config.getBaseUrl().replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new DOMException('request timeout', 'TimeoutError')),
      this.config.getTimeoutMs(),
    )

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await safeErrorText(response)
        const retryable = RETRYABLE_STATUS.has(response.status)
        throw new ApiError(
          `DeepSeek API ${response.status}: ${detail || response.statusText}`,
          response.status,
          retryable,
        )
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>
        model?: string
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          prompt_cache_hit_tokens?: number
        }
      }

      const content = json.choices?.[0]?.message?.content
      if (content === undefined || content === null) {
        throw new ApiError('DeepSeek API 返回空内容（choices 缺失或 content 为 null）', 0, false)
      }

      const raw = json.usage
      if (raw === undefined) {
        throw new ApiError('DeepSeek API 响应缺少 usage 字段，无法计费', 0, false)
      }
      const inputTokens = toTokenCount(raw.prompt_tokens, 'prompt_tokens')
      const outputTokens = toTokenCount(raw.completion_tokens, 'completion_tokens')
      const cacheHit = toTokenCount(
        raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens,
        'cached_tokens',
      )
      // 缓存命中不可能超过输入 tokens
      const clampedCacheHit = Math.min(cacheHit, inputTokens)

      return {
        content,
        model: json.model ?? request.model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_hit_tokens: clampedCacheHit,
        },
        startedAt,
      }
    } catch (error) {
      if (signal?.aborted) throw new CancelledError()
      if (error instanceof Error && error.name === 'TimeoutError') {
        // 服务器可能已处理并扣费：不重试，避免二次扣费
        throw new ApiError('DeepSeek API 请求超时（未重试，避免重复扣费）', 0, false)
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(
        `DeepSeek API 网络错误: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async resolveApiKey(): Promise<string> {
    if (this.config.apiKey && this.config.apiKey.trim() !== '') return this.config.apiKey
    const viaSeam = await this.config.apiKeyResolver?.()
    if (viaSeam !== undefined && viaSeam.trim() !== '') return viaSeam
    return process.env.DEEPSEEK_API_KEY ?? ''
  }
}

function toTokenCount(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new ApiError(`DeepSeek API usage.${field} 非法（${String(value)}）`, 0, false)
  }
  return n
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      return parsed.error?.message ?? text.slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return ''
  }
}
