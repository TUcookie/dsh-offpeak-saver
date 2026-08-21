/**
 * Plugin configuration: defaults, persisted overrides, and path resolution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parsePeakHours } from './time.js'

export interface PricingEntry {
  /** 高峰时段输入价格：元 / 百万 tokens（缓存未命中） */
  input: number
  /** 高峰时段输入价格：元 / 百万 tokens（缓存命中） */
  input_cache_hit: number
  /** 高峰时段输出价格：元 / 百万 tokens */
  output: number
}

export interface Config {
  /** DeepSeek API Key；留空则读取环境变量 DEEPSEEK_API_KEY。 */
  api_key: string
  /** API 根地址，默认 https://api.deepseek.com */
  base_url: string
  /** 默认模型 */
  default_model: string
  /** 高峰时段列表，格式 "HH:MM-HH:MM"（北京时间）。 */
  peak_hours: string[]
  /** 时区偏移（小时），默认 +8。 */
  timezone_offset_hours: number
  /** 同时进行的 API 请求数上限。 */
  max_concurrency: number
  /** 指数退避最大重试次数。 */
  retry_attempts: number
  /** 指数退避基准延迟（毫秒）。 */
  backoff_base_ms: number
  /** 单次 API 请求超时（毫秒），默认 30 分钟。 */
  request_timeout_ms: number
  /** 任务执行模式：session = 唤醒 Harness 会话执行（原生直播）；direct = 直接调 API（静默批量）。 */
  execution_mode: 'session' | 'direct'
  /** 高峰开始前多少分钟停止派发新任务。 */
  stop_before_peak_minutes: number
  /** 调度器检查间隔（毫秒）。 */
  check_interval_ms: number
  /** 空闲时段折扣：0.5 = 高峰价格的一半。 */
  discount_rate: number
  /** 金额展示币种。 */
  currency: 'CNY' | 'USD'
  /** SQLite 数据库路径；留空则使用默认数据目录。 */
  db_path: string
  /** 排队超过该小时数的任务在启动时提醒。 */
  stale_hours: number
  /** running 任务认领租约（毫秒）：超过后视为进程崩溃，启动时重置为 pending。 */
  lease_ms: number
  /** 是否发送完成/失败事件通知。 */
  notify: boolean
  /** 各模型高峰价格表（元 / 百万 tokens）。 */
  pricing: Record<string, PricingEntry>
}

/** 官方峰谷定价（2026-08-17 起生效）：高峰 09:00-12:00、14:00-18:00（北京时间）。 */
export const OFFICIAL_PEAK_HOURS = ['09:00-12:00', '14:00-18:00']
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 8
export const DEFAULT_MAX_CONCURRENCY = 3

export const DEFAULT_PRICING: Record<string, PricingEntry> = {
  'deepseek-v4-flash': { input: 3.0, input_cache_hit: 0.1, output: 9.0 },
  'deepseek-v4-pro': { input: 9.0, input_cache_hit: 0.3, output: 27.0 },
}

export const DEFAULT_CONFIG: Config = {
  api_key: '',
  base_url: 'https://api.deepseek.com',
  default_model: 'deepseek-v4-flash',
  peak_hours: [...OFFICIAL_PEAK_HOURS],
  timezone_offset_hours: 8,
  max_concurrency: DEFAULT_MAX_CONCURRENCY,
  retry_attempts: 3,
  backoff_base_ms: 2000,
  request_timeout_ms: 1_800_000,
  execution_mode: 'session',
  stop_before_peak_minutes: 10,
  check_interval_ms: 30_000,
  discount_rate: 0.5,
  currency: 'CNY',
  db_path: '',
  stale_hours: 24,
  lease_ms: 1_800_000,
  notify: true,
  pricing: { ...DEFAULT_PRICING },
}

/** 配置合并优先级：cordis 插件配置 > 本地 config.json 覆盖 > 默认值。 */
export function mergeConfig(pluginConfig: Partial<Config>): Config {
  if (pluginConfig.base_url !== undefined && pluginConfig.base_url !== '' && !/^https:\/\//i.test(pluginConfig.base_url)) {
    throw new Error('offpeak-saver: base_url 只允许 https:// 地址（防止 API Key 外发）')
  }
  if (pluginConfig.max_concurrency !== undefined) {
    validateMaxConcurrency(pluginConfig.max_concurrency)
  }
  return {
    ...DEFAULT_CONFIG,
    ...pluginConfig,
    pricing: {
      ...DEFAULT_PRICING,
      ...(pluginConfig.pricing ?? {}),
    },
  }
}

/** 默认数据目录：优先 DSH_HOME，其次用户主目录。 */
export function defaultDataDir(): string {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') {
    return path.join(process.env.DSH_HOME, 'data', 'offpeak-saver')
  }
  // dsh 运行时不把 DSH_HOME 写进环境变量；探测真实 Harness 主目录
  const harnessHome = path.join(homedir(), '.dsh')
  if (existsSync(harnessHome)) {
    return path.join(harnessHome, 'data', 'offpeak-saver')
  }
  return path.join(homedir(), '.dsh-offpeak-saver')
}

/** 解析最终数据库路径，并确保父目录存在。 */
export function resolveDbPath(config: Config): string {
  if (config.db_path && config.db_path.trim() !== '') {
    const dir = path.dirname(path.resolve(config.db_path))
    mkdirSync(dir, { recursive: true })
    return path.resolve(config.db_path)
  }
  const dir = defaultDataDir()
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'offpeak.db')
}

export function resolveResultsDir(config: Config): string {
  if (config.db_path && config.db_path.trim() !== '') {
    return path.join(path.dirname(path.resolve(config.db_path)), 'results')
  }
  return path.join(defaultDataDir(), 'results')
}

/** 覆盖文件路径（与数据库同目录）。 */
export function overridesPath(config: Config): string {
  if (config.db_path && config.db_path.trim() !== '') {
    return path.join(path.dirname(path.resolve(config.db_path)), 'config.json')
  }
  return path.join(defaultDataDir(), 'config.json')
}

export type ConfigPatch = Partial<Config>

const OVERRIDE_KEYS: ReadonlySet<keyof Config> = new Set([
  'peak_hours',
  'timezone_offset_hours',
  'max_concurrency',
  'retry_attempts',
  'backoff_base_ms',
  'request_timeout_ms',
  'stop_before_peak_minutes',
  'check_interval_ms',
  'discount_rate',
  'currency',
  'stale_hours',
  'lease_ms',
  'notify',
  'pricing',
  'default_model',
])

export function isHotKey(key: string): key is keyof Config {
  return OVERRIDE_KEYS.has(key as keyof Config)
}

export function loadOverrides(config: Config): ConfigPatch {
  const file = overridesPath(config)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ConfigPatch
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(parsed)) {
      if (isHotKey(key)) {
        filtered[key] = parsed[key as keyof Config]
      }
    }
    return filtered as ConfigPatch
  } catch {
    return {}
  }
}

export function saveOverrides(config: Config, patch: ConfigPatch): void {
  const file = overridesPath(config)
  const current = loadOverrides(config)
  const next = { ...current, ...patch }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
}

/** 校验热更新值（与 loadOverrides / updateSetting 共用同一套规则）。 */
export function sanitizeHotValue(key: string, rawValue: string): unknown {
  let parsed: unknown = rawValue
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    parsed = rawValue
  }

  switch (key) {
    case 'peak_hours': {
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('offpeak-saver: peak_hours 必须是字符串数组，如 ["09:00-12:00","14:00-18:00"]')
      }
      validatePeakHours(parsed as string[])
      return parsed
    }
    case 'pricing': {
      return validatePricing(parsed)
    }
    case 'discount_rate': {
      const n = Number(parsed)
      if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error('offpeak-saver: discount_rate 必须在 (0, 1] 之间')
      return n
    }
    case 'currency': {
      if (parsed !== 'CNY' && parsed !== 'USD') throw new Error('offpeak-saver: currency 只能是 CNY 或 USD')
      return parsed
    }
    case 'notify': {
      if (typeof parsed !== 'boolean') throw new Error('offpeak-saver: notify 必须是布尔值')
      return parsed
    }
    case 'timezone_offset_hours':
    case 'retry_attempts':
    case 'backoff_base_ms':
    case 'request_timeout_ms':
    case 'execution_mode':
    case 'stop_before_peak_minutes':
    case 'check_interval_ms':
    case 'stale_hours':
    case 'lease_ms': {
      if (key === 'execution_mode') {
        if (parsed !== 'session' && parsed !== 'direct') {
          throw new Error('offpeak-saver: execution_mode 只能是 session 或 direct')
        }
        return parsed
      }
      const n = Number(parsed)
      if (!Number.isFinite(n) || n < 0) throw new Error(`offpeak-saver: ${key} 必须是非负数`)
      return n
    }
    case 'default_model': {
      if (typeof parsed !== 'string' || parsed.trim() === '') throw new Error('offpeak-saver: default_model 必须是非空字符串')
      return parsed
    }
    case 'max_concurrency': {
      const n = Number(parsed)
      validateMaxConcurrency(n)
      return n
    }
    default:
      throw new Error(`offpeak-saver: 不允许热更新配置项 "${key}"`)
  }
}

/** 用户可配置并发范围：避免把 API 或本地会话同时压垮。 */
export function validateMaxConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) {
    throw new Error(`offpeak-saver: max_concurrency 必须是 ${MIN_CONCURRENCY} 到 ${MAX_CONCURRENCY} 的整数`)
  }
}

/** 高峰时段数值校验（0<=HH<=23、0<=MM<=59）。 */
export function validatePeakHours(hours: string[]): void {
  parsePeakHours(hours)
}

/** pricing 逐项校验：input/input_cache_hit/output 必须为有限非负数。 */
export function validatePricing(value: unknown): Record<string, PricingEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('offpeak-saver: pricing 必须是模型价格对象')
  }
  const result: Record<string, PricingEntry> = {}
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`offpeak-saver: 模型 ${model} 的价格必须是对象`)
    }
    const e = entry as Record<string, unknown>
    for (const field of ['input', 'input_cache_hit', 'output'] as const) {
      const n = Number(e[field])
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`offpeak-saver: 模型 ${model} 的 ${field} 必须是有限非负数`)
      }
      result[model] = { ...result[model], [field]: n }
    }
  }
  return result
}
