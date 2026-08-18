import { describe, expect, it } from 'vitest'
import { computeCosts, equivalentFreeTokens, formatMoney, round4 } from '../src/billing.js'

const FLASH = { input: 3.0, input_cache_hit: 0.1, output: 9.0 }

describe('computeCosts', () => {
  it('计算缓存命中与未命中的混合计费', () => {
    const costs = computeCosts(
      { input_tokens: 1000, output_tokens: 500, cache_hit_tokens: 400 },
      FLASH,
      0.5,
    )
    // baseline = (600*3 + 400*0.1 + 500*9) / 1e6 = 0.00634
    expect(costs.cost_baseline).toBeCloseTo(0.0063, 6)
    expect(costs.cost_actual).toBeCloseTo(0.0032, 6)
    expect(costs.savings).toBeCloseTo(0.0032, 6)
  })

  it('全部命中缓存时按缓存价计费', () => {
    const costs = computeCosts({ input_tokens: 2000, output_tokens: 0, cache_hit_tokens: 2000 }, FLASH, 0.5)
    expect(costs.cost_baseline).toBeCloseTo(0.0002, 6)
    expect(costs.cost_actual).toBeCloseTo(0.0001, 6)
  })

  it('无折扣时实际价等于基准价', () => {
    const costs = computeCosts({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_hit_tokens: 0 }, FLASH, 1)
    expect(costs.cost_baseline).toBe(12)
    expect(costs.cost_actual).toBe(12)
    expect(costs.savings).toBe(0)
  })

  it('round4 四舍五入到 4 位小数', () => {
    expect(round4(0.123456)).toBe(0.1235)
  })
})

describe('formatMoney / equivalentFreeTokens', () => {
  it('人民币与美元格式化', () => {
    expect(formatMoney(1.5, 'CNY')).toBe('¥1.50')
    expect(formatMoney(0.25, 'USD')).toBe('$0.25')
  })

  it('等效免费 tokens 按空闲输入价折算', () => {
    // savings 3.75 元，空闲输入价 1.5 元/百万 → 2,500,000 tokens
    expect(equivalentFreeTokens(3.75, FLASH, 0.5)).toBe(2_500_000)
  })
})
