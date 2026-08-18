/**
 * dsh-offpeak-saver — DeepSeek Harness 错峰省钱调度器插件。
 *
 * 非紧急任务写入本地 SQLite 队列，空闲时段（官方半价窗口）自动执行，
 * 每次完成输出“节省金额”，并提供日 / 周 / 月账单。
 *
 * 注意：只使用命名导出，不要添加 export default（dsh loader 会因此丢失
 * name / inject / Config，插件将无法加载）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { DEFAULT_PRICING, OFFICIAL_PEAK_HOURS, type Config as RuntimeConfig, type PricingEntry } from './config.js'
import { OffPeakSaver } from './core.js'
import { registerPanelHttpWhenReady } from './http.js'
import { createDshSessionRunner } from './session-runner.js'
import { createTools } from './tools.js'
import { satisfiesCaret } from './version.js'

export const name = 'dsh-offpeak-saver'

/** Services required by this plugin. */
export const inject = ['tools']

/** Peer range this plugin is tested against and guards at runtime. */
export const TESTED_PEER_RANGE = '^0.1.0-rc.6'

const require = createRequire(import.meta.url)

/** Resolve the dsh-tools version the plugin is actually linked against. */
export function resolvedDshToolsVersion(): string {
  try {
    const pkg = require('@deepseek-ai/dsh-tools/package.json') as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unresolved'
  }
}

/** 把静默的 peer 版本不匹配变成加载时的明确报错。 */
export function assertPeerCompatible(): void {
  const version = resolvedDshToolsVersion()
  if (!satisfiesCaret(version, TESTED_PEER_RANGE)) {
    throw new Error(
      `dsh-offpeak-saver: resolved @deepseek-ai/dsh-tools ${version}, but this plugin is tested with `
      + `${TESTED_PEER_RANGE}. Upgrade DeepSeek Harness to 0.1.0-rc.6 or later, then reinstall this plugin.`,
    )
  }
}

export type Config = RuntimeConfig

const pricingEntry = (input: number, input_cache_hit: number, output: number) =>
  Schema.object({
    input: Schema.number().default(input),
    input_cache_hit: Schema.number().default(input_cache_hit),
    output: Schema.number().default(output),
  })

/** Schemastery 配置 schema（与 cordis.yml 中的 config 对应）。 */
export const Config: Schema<Config> = Schema.object({
  api_key: Schema.string().default(''),
  base_url: Schema.string().default('https://api.deepseek.com'),
  default_model: Schema.string().default('deepseek-v4-flash'),
  execution_mode: Schema.union(['session', 'direct']).default('session'),
  peak_hours: Schema.array(Schema.string()).default([...OFFICIAL_PEAK_HOURS]),
  timezone_offset_hours: Schema.number().default(8),
  max_concurrency: Schema.number().default(5),
  retry_attempts: Schema.number().default(3),
  backoff_base_ms: Schema.number().default(2000),
  request_timeout_ms: Schema.number().default(1_800_000),
  stop_before_peak_minutes: Schema.number().default(10),
  check_interval_ms: Schema.number().default(30_000),
  discount_rate: Schema.number().default(0.5),
  currency: Schema.union(['CNY', 'USD']).default('CNY'),
  db_path: Schema.string().default(''),
  stale_hours: Schema.number().default(24),
  lease_ms: Schema.number().default(1_800_000),
  notify: Schema.boolean().default(true),
  pricing: Schema.dict(
    Schema.union([
      pricingEntry(3.0, 0.1, 9.0),
      pricingEntry(9.0, 0.3, 27.0),
      pricingEntry(0, 0, 0),
    ]),
  ).default({ ...DEFAULT_PRICING }),
})

/** 插件入口：注册工具、启动调度器，并在卸载时完整回收资源。 */
export function apply(ctx: Context, config: Config): void {
  assertPeerCompatible()

  // 会话内执行（B 方案）：复用 dsh agents 服务，任务在原生会话里执行
  let sessionRunner: import('./session-runner.js').SessionRunner | undefined
  try {
    sessionRunner = createDshSessionRunner(ctx)
  } catch {
    sessionRunner = undefined
  }

  const saver = new OffPeakSaver(config, {
    sessionRunner,
    apiKeyResolver: async () => {
      // 官方凭证通道：~/.dsh/.credentials.yaml 或启动环境里的 DEEPSEEK_API_KEY
      const credentials = ctx.get('credentials') as
        | { resolve: (ref: string) => Promise<{ value: string; source: string } | undefined> }
        | undefined
      const hit = await credentials?.resolve('DEEPSEEK_API_KEY')
      return hit?.value
    },
    onEvent: (event) => {
      if (event.type === 'log') {
        const logger =
          (ctx as unknown as { logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } })
            .logger ?? console
        if (event.level === 'error') logger.error?.(`[offpeak-saver] ${event.message}`)
        else if (event.level === 'warn') logger.warn?.(`[offpeak-saver] ${event.message}`)
        else logger.info?.(`[offpeak-saver] ${event.message}`)
        return
      }
      const emit = (ctx as unknown as { emit: (name: string, payload: unknown) => void }).emit
      emit(`offpeak/${event.type}`, event)
    },
  })

  ctx.effect(() => {
    const disposers = createTools(saver).map((tool) => ctx.tools.register(tool))
    const disposeHttp = registerPanelHttpWhenReady(ctx, saver)
    saver.start()
    return async () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
      disposeHttp()
      await saver.stop()
    }
  })
}

export { DEFAULT_PRICING, OFFICIAL_PEAK_HOURS }
export type { PricingEntry }
