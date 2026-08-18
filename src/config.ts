/**
 * Plugin configuration: defaults, persisted overrides, and path resolution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
  /** 是否发送完成/失败事件通知。 */
  notify: boolean
  /** 各模型高峰价格表（元 / 百万 tokens）。 */
  pricing: Record<string, PricingEntry>
}

/** 官方峰谷定价（2026-08-17 起生效）：高峰 09:00-12:00、14:00-18:00（北京时间）。 */
export const OFFICIAL_PEAK_HOURS = ['09:00-12:00', '14:00-18:00']

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
  max_concurrency: 5,
  retry_attempts: 3,
  backoff_base_ms: 2000,
  request_timeout_ms: 1_800_000,
  stop_before_peak_minutes: 10,
  check_interval_ms: 30_000,
  discount_rate: 0.5,
  currency: 'CNY',
  db_path: '',
  stale_hours: 24,
  notify: true,
  pricing: { ...DEFAULT_PRICING },
}

/** 配置合并优先级：cordis 插件配置 > 本地 config.json 覆盖 > 默认值。 */
export function mergeConfig(pluginConfig: Partial<Config>): Config {
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

export function resolveApiKey(config: Config): string {
  if (config.api_key && config.api_key.trim() !== '') return config.api_key
  return process.env.DEEPSEEK_API_KEY ?? ''
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
  'notify',
  'pricing',
  'default_model',
  'base_url',
])

export function isHotKey(key: string): key is keyof Config {
  return OVERRIDE_KEYS.has(key as keyof Config)
}

export function loadOverrides(config: Config): ConfigPatch {
  const file = overridesPath(config)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ConfigPatch
    return parsed
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
