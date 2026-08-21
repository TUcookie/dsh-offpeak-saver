/** 面板数据 API（同源 /offpeak-saver/*）。 */

export interface PanelTask {
  id: string
  title: string
  model: string
  priority: number
  queue_order: number
  status: string
  created_at: string
  executed_at: string | null
  completed_at: string | null
  billed_at: string | null
  retry_count: number
  input_tokens: number
  output_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  error_msg: string | null
  result_path: string | null
  prompt: string
}

export interface PanelReport {
  period: string
  period_label: string
  executions: number
  completed_tasks: number
  failed_tasks: number
  pending_tasks: number
  input_tokens: number
  output_tokens: number
  cost_actual: number
  cost_baseline: number
  savings: number
  equivalent_free_tokens: number
  currency: 'CNY' | 'USD'
}

export interface PanelOverview {
  now: string
  phase: 'peak' | 'offpeak'
  nextOffPeak: string | null
  concurrency: {
    configured: number
    effective: number
  }
  pending: PanelTask[]
  running: PanelTask[]
  recent: PanelTask[]
  reports: {
    day: PanelReport
    week: PanelReport
    month: PanelReport
  }
}

interface OkEnvelope<T> {
  ok: true
  value: T
}

interface FailEnvelope {
  ok: false
  error: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const data = (await response.json()) as OkEnvelope<T> | FailEnvelope
  if (data.ok) return data.value
  throw new Error(data.error)
}

export function loadOverview(): Promise<PanelOverview> {
  return request<PanelOverview>('/offpeak-saver/overview')
}

export function cancelTask(taskId: string): Promise<{ id: string; status: string }> {
  return request<{ id: string; status: string }>('/offpeak-saver/cancel', {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  })
}

export function moveQueuedTask(taskId: string, direction: 'up' | 'down'): Promise<{
  id: string
  position: { position: number; total: number } | null
}> {
  return request('/offpeak-saver/reorder', {
    method: 'POST',
    body: JSON.stringify({ taskId, direction }),
  })
}

export function setMaxConcurrency(maxConcurrency: number): Promise<PanelOverview['concurrency']> {
  return request<PanelOverview['concurrency']>('/offpeak-saver/concurrency', {
    method: 'POST',
    body: JSON.stringify({ maxConcurrency }),
  })
}

export interface SubmitPanelInput {
  prompt: string
  title?: string
  priority: 'realtime' | 'offpeak' | 'background'
  model?: string
}

export function submitTask(input: SubmitPanelInput): Promise<{
  task_id: string
  status: string
  priority: number
  message: string
}> {
  return request('/offpeak-saver/submit', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function money(amount: number, currency: 'CNY' | 'USD'): string {
  const symbol = currency === 'CNY' ? '¥' : '$'
  // 大于 0 但不足 1 分钱的金额统一显示为 <0.01，真实数值仍存后端，可查明细
  if (amount !== 0 && Math.abs(amount) < 0.01) {
    return `${symbol}<0.01`
  }
  return `${symbol}${amount.toFixed(2)}`
}

export function formatClock(iso: string): string {
  try {
    const date = new Date(iso)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
  } catch {
    return iso
  }
}
