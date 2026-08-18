/**
 * 计费核算：实际花费 / 高峰基准价 / 节省金额。
 */

import type { PricingEntry } from './config.js'

export interface Usage {
  input_tokens: number
  output_tokens: number
  /** 命中缓存的输入 tokens 数 */
  cache_hit_tokens: number
}

export interface CostBreakdown {
  cost_actual: number
  cost_baseline: number
  savings: number
  /** 计算所用的价格快照（元 / 百万 tokens） */
  price_snapshot: PricingEntry
}

/**
 * 按高峰价格计算基准价，再乘以折扣率得到实际价。
 * 官方规则：空闲时段价格 = 高峰价格 × 0.5。
 */
export function computeCosts(
  usage: Usage,
  pricing: PricingEntry,
  discountRate: number,
): CostBreakdown {
  const inputMiss = Math.max(0, usage.input_tokens - usage.cache_hit_tokens)
  const baseline =
    (inputMiss * pricing.input + usage.cache_hit_tokens * pricing.input_cache_hit + usage.output_tokens * pricing.output) /
    1_000_000
  const actualUnrounded = baseline * discountRate
  return {
    cost_actual: round6(actualUnrounded),
    cost_baseline: round6(baseline),
    savings: round6(baseline - actualUnrounded),
    price_snapshot: pricing,
  }
}

/** 入库精度：6 位小数（展示时再 toFixed(2)），避免万笔任务累计误差。 */
export function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

/** 金额展示：¥1.23 / $1.23。 */
export function formatMoney(amount: number, currency: 'CNY' | 'USD'): string {
  const symbol = currency === 'CNY' ? '¥' : '$'
  return `${symbol}${amount.toFixed(2)}`
}

/** 等效免费 tokens：按默认模型空闲时段输入价折算。 */
export function equivalentFreeTokens(savings: number, pricing: PricingEntry, discountRate: number): number {
  const offPeakInputPricePerToken = (pricing.input * discountRate) / 1_000_000
  if (offPeakInputPricePerToken <= 0) return 0
  return Math.floor(savings / offPeakInputPricePerToken)
}
