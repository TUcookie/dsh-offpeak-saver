// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SidebarEntry } from '../src/client/sidebar-entry.tsx'
import { zh } from '../src/client/locales.ts'
import type { PanelOverview } from '../src/client/api.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function overview(phase: PanelOverview['phase']): PanelOverview {
  const report = {
    period: 'day', period_label: '2026-08-21', executions: 0, completed_tasks: 0,
    failed_tasks: 0, pending_tasks: 0, input_tokens: 0, output_tokens: 0,
    cost_actual: 0, cost_baseline: 0, savings: 0, equivalent_free_tokens: 0,
    currency: 'CNY' as const,
  }
  return { now: '2026-08-21T00:00:00.000Z', phase, nextOffPeak: null, pending: [], running: [], recent: [], reports: { day: report, week: { ...report, period: 'week' }, month: { ...report, period: 'month' } } }
}

describe('SidebarEntry 时段图标', () => {
  it.each([
    ['offpeak', '空闲时段（半价）'],
    ['peak', '高峰时段'],
  ] as const)('在 %s 时段显示 %s 图标', async (phase, label) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: overview(phase) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    render(<SidebarEntry wide t={(key) => zh[key]} />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: label })).toBeTruthy()
    })
  })
})
