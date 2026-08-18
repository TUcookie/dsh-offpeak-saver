/**
 * dsh 工具集：提交 / 查询 / 账单 / 取消 / 设置。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { formatMoney } from './billing.js'
import type { OffPeakSaver, Priority } from './core.js'

const require = createRequire(import.meta.url)

const OFFPEAK_TAG = /#\s*(offpeak|batch)\b/i
const REALTIME_TAG = /#\s*realtime\b/i

function detectPriority(raw: string | undefined, prompt: string): Priority {
  if (raw === 'realtime') return 0
  if (raw === 'offpeak') return 1
  if (raw === 'background') return 2
  if (REALTIME_TAG.test(prompt)) return 0
  if (OFFPEAK_TAG.test(prompt)) return 1
  return 1
}

function money(n: number, currency: 'CNY' | 'USD'): string {
  return formatMoney(n, currency)
}

function readFileUtf8(file: string): string {
  try {
    return require('node:fs').readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function createTools(saver: OffPeakSaver): Array<ReturnType<typeof defineTool>> {
  const currency = (): 'CNY' | 'USD' => saver.currentConfig.currency

  const submit = defineTool({
    name: 'offpeak_submit',
    description:
      '把任务提交给错峰调度器：优先级为 offpeak/background 的任务进入本地持久化队列，'
      + '在 DeepSeek 空闲时段（半价）自动执行；priority=realtime 立即执行。'
      + 'Prompt 中带 #offpeak / #batch 标签会被自动识别为错峰任务。',
    parameters: {
      prompt: { type: 'string', required: true, description: '任务内容（要发给 DeepSeek 的 Prompt）' },
      title: { type: 'string', description: '任务名称，用于通知与账单展示' },
      model: { type: 'string', description: '模型 ID，默认 deepseek-v4-flash' },
      priority: {
        type: 'string',
        description: 'auto（默认，识别标签）/ realtime / offpeak / background',
      },
      session_id: { type: 'string', description: '关联的 Harness 会话 ID' },
      output_path: { type: 'string', description: '结果输出文件路径（可选）' },
      max_tokens: { type: 'number', description: '最大输出 tokens' },
      temperature: { type: 'number', description: '采样温度' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          priority: { type: 'string', required: true },
          message: { type: 'string', required: true },
          content_preview: { type: 'string' },
          cost_actual: { type: 'number' },
          cost_baseline: { type: 'number' },
          savings: { type: 'number' },
          next_offpeak_start: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.message}${value.content_preview !== undefined ? `\n\n${value.content_preview}` : ''}`,
        },
      ],
    },
    async execute(args) {
      const priority = detectPriority(args.priority, args.prompt)
      const result = await saver.submitTask(
        {
          prompt: args.prompt,
          title: args.title,
          model: args.model,
          session_id: args.session_id,
          output_path: args.output_path,
          params: {
            temperature: args.temperature,
            max_tokens: args.max_tokens,
          },
        },
        priority,
      )
      const task = result.task
      const priorityLabel = priority === 0 ? 'realtime' : priority === 1 ? 'offpeak' : 'background'

      if (result.immediate !== undefined && task.status === 'completed') {
        return {
          task_id: task.id,
          status: task.status,
          priority: priorityLabel,
          message: `✅ 完成 | 💰 节省 ${money(task.savings, currency())} (50% OFF)`,
          content_preview: result.immediate.content.slice(0, 500),
          cost_actual: task.cost_actual,
          cost_baseline: task.cost_baseline,
          savings: task.savings,
        }
      }

      if (task.status === 'failed') {
        return {
          task_id: task.id,
          status: task.status,
          priority: priorityLabel,
          message: `❌ 执行失败：${task.error_msg ?? '未知错误'}`,
        }
      }

      const next = saver.nextOffPeak()
      return {
        task_id: task.id,
        status: task.status,
        priority: priorityLabel,
        message: `已加入错峰队列，预计在 ${next?.label ?? '下一空闲时段'} 后开始执行。`,
        next_offpeak_start: next?.label,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `错峰提交：${args.title ?? args.prompt.slice(0, 30)}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  const status = defineTool({
    name: 'offpeak_status',
    description: '查询错峰任务的状态、费用与节省金额；已完成任务附带结果预览。',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 ID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          priority: { type: 'number', required: true },
          created_at: { type: 'string', required: true },
          executed_at: { type: 'string' },
          completed_at: { type: 'string' },
          model: { type: 'string', required: true },
          input_tokens: { type: 'number' },
          output_tokens: { type: 'number' },
          cost_actual: { type: 'number' },
          cost_baseline: { type: 'number' },
          savings: { type: 'number' },
          error_msg: { type: 'string' },
          result_excerpt: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const view = saver.getTask(args.task_id)
      if (view === null) {
        return {
          task_id: args.task_id,
          title: '未知任务',
          status: 'not_found',
          priority: 0,
          created_at: '',
          model: '',
          message: `未找到任务 ${args.task_id}`,
        }
      }
      const lines = [
        `📋 ${view.title}（${view.id.slice(0, 8)}…）`,
        `状态：${view.status}`,
        `创建：${view.created_at}`,
      ]
      if (view.executed_at !== null) lines.push(`开始执行：${view.executed_at}`)
      if (view.completed_at !== null) lines.push(`完成：${view.completed_at}`)
      if (view.status === 'completed') {
        lines.push(
          `💰 实际花费 ${money(view.cost_actual, currency())}｜高峰原价 ${money(view.cost_baseline, currency())}｜节省 ${money(view.savings, currency())}`,
        )
        lines.push(`tokens：输入 ${view.input_tokens.toLocaleString()} / 输出 ${view.output_tokens.toLocaleString()}`)
      }
      if (view.error_msg !== null) lines.push(`错误：${view.error_msg}`)

      let resultExcerpt = ''
      if (view.result_path !== null) {
        resultExcerpt = readFileUtf8(view.result_path).slice(0, 1200)
        if (resultExcerpt === '') {
          lines.push('结果文件读取失败')
        } else {
          lines.push(`结果预览：\n${resultExcerpt}`)
        }
      }

      return {
        task_id: view.id,
        title: view.title,
        status: view.status,
        priority: view.priority,
        created_at: view.created_at,
        executed_at: view.executed_at ?? undefined,
        completed_at: view.completed_at ?? undefined,
        model: view.model,
        input_tokens: view.input_tokens,
        output_tokens: view.output_tokens,
        cost_actual: view.cost_actual,
        cost_baseline: view.cost_baseline,
        savings: view.savings,
        error_msg: view.error_msg ?? undefined,
        result_excerpt: resultExcerpt,
        message: lines.join('\n'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `查询错峰任务 ${args.task_id.slice(0, 8)}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  const report = defineTool({
    name: 'offpeak_report',
    description: '查看日 / 周 / 月错峰省钱账单：执行次数、实际花费、高峰原价、节省金额、等效免费 tokens。',
    parameters: {
      period: { type: 'string', description: 'day（默认）/ week / month' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period: { type: 'string', required: true },
          executions: { type: 'number', required: true },
          completed_tasks: { type: 'number', required: true },
          failed_tasks: { type: 'number', required: true },
          pending_tasks: { type: 'number', required: true },
          cost_actual: { type: 'number', required: true },
          cost_baseline: { type: 'number', required: true },
          savings: { type: 'number', required: true },
          equivalent_free_tokens: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const period = args.period === 'week' || args.period === 'month' ? args.period : 'day'
      const report = saver.getReport(period)
      return {
        period,
        executions: report.executions,
        completed_tasks: report.completed_tasks,
        failed_tasks: report.failed_tasks,
        pending_tasks: report.pending_tasks,
        cost_actual: report.cost_actual,
        cost_baseline: report.cost_baseline,
        savings: report.savings,
        equivalent_free_tokens: report.equivalent_free_tokens,
        text: saver.renderReport(period),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `错峰账单：${args.period ?? 'day'}`,
      kind: 'other',
      rawInput: args,
    }),
  })

  const cancel = defineTool({
    name: 'offpeak_cancel',
    description: '取消一个还在排队（pending / paused）的错峰任务。',
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 ID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const task = saver.cancelTask(args.task_id)
      if (task === null) {
        return { task_id: args.task_id, status: 'not_found', message: `未找到任务 ${args.task_id}` }
      }
      if (task.status === 'cancelled') {
        return { task_id: task.id, status: task.status, message: `已取消任务 ${task.id.slice(0, 8)}` }
      }
      return {
        task_id: task.id,
        status: task.status,
        message: `任务当前状态为 ${task.status}，无法取消（仅 pending / paused 可取消）`,
      }
    },
  })

  const settings = defineTool({
    name: 'offpeak_settings',
    description:
      '查看或热更新错峰调度器配置。可更新：peak_hours、discount_rate、max_concurrency、retry_attempts、'
      + 'stop_before_peak_minutes、currency、pricing、default_model 等。',
    parameters: {
      action: { type: 'string', required: true, description: 'get 或 set' },
      key: { type: 'string', description: '要读取/更新的配置键' },
      value: { type: 'string', description: '新值（JSON 字符串，如 ["09:00-12:00"]）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          settings: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      if (args.action === 'set') {
        if (args.key === undefined || args.value === undefined) {
          return { message: 'set 操作需要同时提供 key 和 value' }
        }
        try {
          const { key, value } = saver.updateSetting(args.key, args.value)
          return {
            message: `✅ 配置已热更新：${key} = ${JSON.stringify(value)}（重启后依然生效）`,
            settings: JSON.stringify(saver.getSettings().config, null, 2),
          }
        } catch (error) {
          return { message: `❌ 更新失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      const settings = saver.getSettings()
      return {
        message: `当前配置：\n\`\`\`json\n${JSON.stringify(settings.config, null, 2)}\n\`\`\``,
        settings: JSON.stringify(settings.config, null, 2),
      }
    },
  })

  return [submit, status, report, cancel, settings]
}
