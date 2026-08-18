/**
 * DeepSeek Chat Completions 客户端：超时、指数退避重试、usage 解析。
 */

export interface ClientConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  retryAttempts: number
  backoffBaseMs: number
  fetchImpl?: typeof fetch
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
  content: string | null
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_hit_tokens: number
  }
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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DeepSeekClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: ClientConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    if (this.config.apiKey === '') {
      throw new ApiError(
        '未配置 DeepSeek API Key：请在插件配置中设置 api_key，或设置 DEEPSEEK_API_KEY 环境变量',
        401,
        false,
      )
    }
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      if (signal?.aborted) throw new CancelledError()

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      if (signal !== undefined) {
        if (signal.aborted) throw new CancelledError()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new DOMException('request timeout', 'TimeoutError')), this.config.timeoutMs)

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          const detail = await safeErrorText(response)
          const retryable = RETRYABLE_STATUS.has(response.status)
          lastError = new ApiError(
            `DeepSeek API ${response.status}: ${detail || response.statusText}`,
            response.status,
            retryable,
          )
        } else {
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
          const usage = json.usage ?? {}
          const cacheHit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
          return {
            content: json.choices?.[0]?.message?.content ?? null,
            model: json.model ?? request.model,
            usage: {
              input_tokens: usage.prompt_tokens ?? 0,
              output_tokens: usage.completion_tokens ?? 0,
              cache_hit_tokens: cacheHit,
            },
          }
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError' && signal?.aborted)) {
          throw new CancelledError()
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
          lastError = new ApiError('DeepSeek API 请求超时', 0, true)
        } else if (error instanceof ApiError) {
          lastError = error
        } else {
          lastError = new ApiError(
            `DeepSeek API 网络错误: ${error instanceof Error ? error.message : String(error)}`,
            0,
            true,
          )
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      if (attempt < this.config.retryAttempts && lastError instanceof ApiError && lastError.retryable) {
        const backoff = this.config.backoffBaseMs * 2 ** attempt * (0.5 + Math.random())
        await sleep(backoff)
        continue
      }
      break
    }

    throw lastError ?? new ApiError('DeepSeek API 未知错误', 0, false)
  }
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
