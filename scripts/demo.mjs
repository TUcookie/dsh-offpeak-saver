#!/usr/bin/env node
/**
 * 本地演示 CLI：不启动完整 DeepSeek Harness，直接用插件核心模块。
 *
 * 用法：
 *   node scripts/demo.mjs submit "写 100 篇文档摘要" [--realtime] [--model deepseek-v4-flash]
 *   node scripts/demo.mjs status <task_id>
 *   node scripts/demo.mjs report [day|week|month]
 *   node scripts/demo.mjs cancel <task_id>
 *
 * 需要 DEEPSEEK_API_KEY 环境变量（或首次使用时通过 offpeak_settings 配置）。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OffPeakSaver } from '../lib/core.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [command, ...rest] = process.argv.slice(2)

function usage() {
  console.log(
    '用法：node scripts/demo.mjs <submit|status|report|cancel> ...\n'
    + '  submit "prompt" [--realtime] [--model X] [--title T]\n'
    + '  status <task_id>\n'
    + '  report [day|week|month]\n'
    + '  cancel <task_id>',
  )
}

if (command === undefined) {
  usage()
  process.exit(1)
}

const saver = new OffPeakSaver(
  {},
  {
    onEvent: (event) => {
      if (event.type === 'log') {
        const tag = event.level === 'error' ? '❌' : event.level === 'warn' ? '⚠️' : 'ℹ️'
        console.log(`${tag} ${event.message}`)
      }
    },
  },
)

if (command === 'submit') {
  const prompt = rest.find((arg) => !arg.startsWith('--'))
  if (prompt === undefined) {
    console.error('缺少 prompt')
    process.exit(1)
  }
  const realtime = rest.includes('--realtime')
  const modelArg = rest.find((arg) => arg.startsWith('--model='))
  const titleArg = rest.find((arg) => arg.startsWith('--title='))
  const result = await saver.submitTask(
    {
      prompt,
      model: modelArg?.split('=')[1],
      title: titleArg?.split('=')[1],
    },
    realtime ? 0 : 1,
  )
  if (result.immediate !== undefined) {
    console.log(`✅ 完成 | 💰 节省 ¥${result.task.savings.toFixed(2)}`)
    console.log(result.immediate.content)
  } else {
    const next = saver.nextOffPeak()
    console.log(`已加入错峰队列（${result.task.id}），预计在 ${next?.label ?? '下一空闲时段'} 后开始执行。`)
  }
} else if (command === 'status') {
  const id = rest[0]
  if (id === undefined) {
    console.error('缺少 task_id')
    process.exit(1)
  }
  const view = saver.getTask(id)
  if (view === null) {
    console.log(`未找到任务 ${id}`)
    process.exit(1)
  }
  console.log(JSON.stringify(view, null, 2))
  if (view.result_path !== null) {
    const { readFileSync } = await import('node:fs')
    console.log('--- 结果 ---')
    console.log(readFileSync(view.result_path, 'utf8').slice(0, 2000))
  }
} else if (command === 'report') {
  const period = rest[0] === 'week' || rest[0] === 'month' ? rest[0] : 'day'
  console.log(saver.renderReport(period))
} else if (command === 'cancel') {
  const id = rest[0]
  if (id === undefined) {
    console.error('缺少 task_id')
    process.exit(1)
  }
  const task = saver.cancelTask(id)
  console.log(task === null ? `未找到任务 ${id}` : `已取消（${task.status}）`)
} else {
  usage()
  process.exit(1)
}

await saver.stop()
