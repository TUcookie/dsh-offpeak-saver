/**
 * 累计账单：日 / 周 / 月汇总。
 */

import { equivalentFreeTokens, round6 } from './billing.js'
import type { Config } from './config.js'
import { type TaskStore } from './db.js'

export type ReportPeriod = 'day' | 'week' | 'month'

export interface SavingsReport {
  period: ReportPeriod
  period_label: string
  from: string
  executions: number
  completed_tasks: number
  failed_tasks: number
  pending_tasks: number
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  equivalent_free_tokens: number
  currency: 'CNY' | 'USD'
}

export function startOfPeriod(now: Date, period: ReportPeriod, tzOffsetHours: number): Date {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000)
  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth()
  const d = shifted.getUTCDate()
  const dayOfWeek = shifted.getUTCDay() // 0 = Sunday
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek

  let startShifted: Date
  if (period === 'day') {
    startShifted = new Date(Date.UTC(y, m, d, 0, 0, 0, 0))
  } else if (period === 'week') {
    startShifted = new Date(Date.UTC(y, m, d + mondayOffset, 0, 0, 0, 0))
  } else {
    startShifted = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
  }
  return new Date(startShifted.getTime() - tzOffsetHours * 3_600_000)
}

export function periodLabel(period: ReportPeriod, now: Date, tzOffsetHours: number): string {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000)
  const iso = shifted.toISOString().slice(0, 10)
  if (period === 'day') return iso
  if (period === 'week') return `本周 ${iso}`
  return `本月 ${iso.slice(0, 7)}`
}

export function buildReport(
  store: TaskStore,
  config: Config,
  now: Date = new Date(),
  period: ReportPeriod = 'day',
): SavingsReport {
  const from = startOfPeriod(now, period, config.timezone_offset_hours)
  const fromIso = from.toISOString()
  const billing = store.billingSince(fromIso)
  const counts = store.taskCountsSince(fromIso)
  const pricing = config.pricing[config.default_model] ?? { input: 3.0, input_cache_hit: 0.1, output: 9.0 }

  return {
    period,
    period_label: periodLabel(period, now, config.timezone_offset_hours),
    from: fromIso,
    executions: billing.executions,
    completed_tasks: counts.completed,
    failed_tasks: counts.failed,
    pending_tasks: store.countPending(),
    input_tokens: billing.input_tokens,
    output_tokens: billing.output_tokens,
    cache_hit_tokens: billing.cache_hit_tokens,
    cost_actual: round6(billing.cost_actual),
    cost_baseline: round6(billing.cost_baseline),
    savings: round6(billing.savings),
    equivalent_free_tokens: equivalentFreeTokens(billing.savings, pricing, config.discount_rate),
    currency: config.currency,
  }
}

export function renderReport(report: SavingsReport): string {
  const money = (n: number): string => (report.currency === 'CNY' ? `¥${n.toFixed(2)}` : `$${n.toFixed(2)}`)
  const lines = [
    `📊 错峰省钱账单（${report.period_label}）`,
    `✅ 执行 ${report.executions} 次（成功 ${report.completed_tasks} / 失败 ${report.failed_tasks}）`,
    `💰 实际花费 ${money(report.cost_actual)}`,
    `🏷️ 高峰原价 ${money(report.cost_baseline)}`,
    `💸 累计节省 ${money(report.savings)}`,
    `🔤 输入 ${report.input_tokens.toLocaleString()} tokens / 输出 ${report.output_tokens.toLocaleString()} tokens`,
    `🎁 等效免费 tokens ≈ ${report.equivalent_free_tokens.toLocaleString()}`,
  ]
  if (report.pending_tasks > 0) {
    lines.push(`⏳ 还有 ${report.pending_tasks} 个任务等待空闲时段执行`)
  }
  return lines.join('\n')
}
