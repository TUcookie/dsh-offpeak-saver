#!/usr/bin/env node
/**
 * 打包产物集成 + 真实运行时调用冒烟测试。
 *
 * 把 pnpm pack 出的 tarball 装进全新项目，加载已安装插件 bundle，
 * 通过真实 apply() / ctx.tools.register 注册工具，用打桩的 DeepSeek API
 * 真实执行 offpeak_submit / offpeak_status / offpeak_report / offpeak_cancel，
 * 并断言每一步结果。另用一个不兼容的 dsh-tools 版本验证运行时守卫。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tgz = path.resolve(process.argv[2] ?? path.join(root, 'dsh-offpeak-saver-0.2.0.tgz'))

if (!existsSync(tgz)) {
  console.error(`[integration] missing tarball: ${tgz}`)
  process.exit(1)
}

function runPnpm(args, cwd) {
  const quoteForCmd = (arg) => (/[ \t"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.map(quoteForCmd).join(' ')}`], { cwd, encoding: 'utf8' })
    : spawnSync('pnpm', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    console.error(`[pnpm] status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'}`)
  }
  return result
}

function fakeCompletion() {
  return {
    choices: [{ message: { content: '集成测试回复：这是延迟队列产出的结果。' } }],
    model: 'deepseek-v4-flash',
    usage: { prompt_tokens: 1200, completion_tokens: 400, prompt_cache_hit_tokens: 300 },
  }
}

function installAndLoad(name, dshToolsVersion) {
  const dir = mkdtempSync(path.join(tmpdir(), `dsh-offpeak-${name}-`))
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-offpeak-integration-host',
        private: true,
        version: '1.0.0',
        dependencies: {
          '@deepseek-ai/cordis': '^4.0.1',
          '@deepseek-ai/dsh-tools': dshToolsVersion,
          '@deepseek-ai/schemastery': '^3.18.1',
          'dsh-offpeak-saver': `file:${tgz.replaceAll('\\', '/')}`,
        },
      },
      null,
      2,
    ),
  )

  console.log(`[integration:${name}] installing packed tarball (dsh-tools ${dshToolsVersion})...`)
  const install = runPnpm(['install'], dir)
  if (install.status !== 0) {
    console.error(`[integration:${name}] pnpm install failed`)
    process.exit(1)
  }

  const pluginIndex = path.join(dir, 'node_modules', 'dsh-offpeak-saver', 'lib', 'index.js')
  if (!existsSync(pluginIndex)) {
    throw new Error('packed plugin entry lib/index.js missing after install')
  }
  const clientIndex = path.join(dir, 'node_modules', 'dsh-offpeak-saver', 'lib', 'client.js')
  if (!existsSync(clientIndex)) {
    throw new Error('packed client bundle lib/client.js missing after install')
  }
  return { dir, pluginIndex }
}

async function happyScenario() {
  const { dir, pluginIndex } = installAndLoad('happy', '0.1.0-rc.6')
  const plugin = await import(pathToFileURL(pluginIndex).href)
  if (plugin.name !== 'dsh-offpeak-saver') {
    throw new Error(`unexpected plugin name: ${plugin.name}`)
  }

  const registered = []
  const events = []
  let disposer = () => {}
  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
    effect: (fn) => {
      const cleanup = fn()
      disposer = typeof cleanup === 'function' ? cleanup : () => {}
      return disposer
    },
    // 自动分流会在插件启动时注册 agent/pre-step；本集成夹具只验证工具链，
    // 因此提供空的事件注册能力即可。
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-offpeak-data-'))
  globalThis.fetch = async () => {
    return new Response(JSON.stringify(fakeCompletion()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  plugin.apply(ctx, {
    api_key: 'sk-integration-test',
    db_path: path.join(dataDir, 'offpeak.db'),
    check_interval_ms: 60_000,
    peak_hours: [],
  })

  const names = registered.map((definition) => definition.name)
  for (const expected of ['offpeak_submit', 'offpeak_status', 'offpeak_report', 'offpeak_cancel', 'offpeak_settings']) {
    if (!names.includes(expected)) throw new Error(`tool ${expected} was not registered`)
  }
  console.log('PASS all 5 tools registered through real apply()/ctx.tools.register')

  const exec = { signal: new AbortController().signal }
  const submit = registered.find((definition) => definition.name === 'offpeak_submit')

  const realtime = await submit.execute(
    { prompt: '生成项目周报', title: '周报', priority: 'realtime' },
    exec,
  )
  if (realtime.status !== 'completed') {
    throw new Error(`realtime task did not complete: ${JSON.stringify(realtime)}`)
  }
  if (!String(realtime.message).includes('任务已完成')) {
    throw new Error(`realtime message missing completion badge: ${realtime.message}`)
  }
  if (!String(realtime.content_preview).includes('集成测试回复')) {
    throw new Error('realtime content preview missing stub reply')
  }
  console.log('PASS offpeak_submit realtime: handler executed, cost recorded, render message asserted')

  const queued = await submit.execute(
    { prompt: '#offpeak 批量摘要 100 篇', title: '批量摘要', priority: 'auto' },
    exec,
  )
  if (queued.status !== 'pending' || queued.task_id === undefined) {
    throw new Error(`offpeak task was not queued: ${JSON.stringify(queued)}`)
  }
  if (!String(queued.message).includes('已加入错峰队列')) {
    throw new Error(`queued message missing expected text: ${queued.message}`)
  }
  console.log('PASS offpeak_submit queued with #offpeak auto-detection')

  const status = registered.find((definition) => definition.name === 'offpeak_status')
  const statusResult = await status.execute({ task_id: queued.task_id }, exec)
  if (statusResult.status !== 'pending') {
    throw new Error(`status mismatch: ${JSON.stringify(statusResult)}`)
  }
  console.log('PASS offpeak_status returns persisted queue state')

  const report = registered.find((definition) => definition.name === 'offpeak_report')
  const reportResult = await report.execute({ period: 'day' }, exec)
  // 账单只统计真正错峰（priority 1/2）的执行；上面的 realtime 用例不能计入。
  if (reportResult.executions !== 0 || reportResult.pending_tasks !== 1) {
    throw new Error(`report did not preserve the expected realtime/queued split: ${JSON.stringify(reportResult)}`)
  }
  if (!String(reportResult.text).includes('错峰省钱账单')) {
    throw new Error('report text missing header')
  }
  console.log('PASS offpeak_report aggregates billing log')

  const settings = registered.find((definition) => definition.name === 'offpeak_settings')
  const settingsResult = await settings.execute({ action: 'get' }, exec)
  if (!String(settingsResult.settings).includes('peak_hours')) {
    throw new Error('settings get missing config')
  }
  if (String(settingsResult.settings).includes('sk-integration-test')) {
    throw new Error('settings leaked the plaintext API key')
  }
  console.log('PASS offpeak_settings readable')

  const cancel = registered.find((definition) => definition.name === 'offpeak_cancel')
  const cancelResult = await cancel.execute({ task_id: queued.task_id }, exec)
  if (cancelResult.status !== 'cancelled') {
    throw new Error(`cancel failed: ${JSON.stringify(cancelResult)}`)
  }
  console.log('PASS offpeak_cancel transitions pending -> cancelled')

  const offpeakEvents = events.filter((event) => event.name.startsWith('offpeak/'))
  if (offpeakEvents.length === 0) {
    throw new Error('no offpeak/* events emitted')
  }
  console.log(`PASS emitted ${offpeakEvents.length} offpeak/* events`)

  await disposer()
  console.log('PASS packed artifact loaded, tools callable end-to-end, cleanup ran')
  rmSync(dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

async function guardScenario() {
  const { dir, pluginIndex } = installAndLoad('guard', '0.1.0-rc.3')
  const plugin = await import(pathToFileURL(pluginIndex).href)
  let threw = false
  try {
    plugin.apply(
      {
        tools: { register: () => () => {} },
        effect: (fn) => fn(),
        on: () => () => {},
        emit: () => {},
      },
      { api_key: 'x' },
    )
  } catch (error) {
    threw = true
    if (!String(error instanceof Error ? error.message : error).includes('tested with ^0.1.0-rc.6')) {
      throw new Error(`guard threw an unexpected error: ${String(error)}`)
    }
  }
  if (!threw) {
    throw new Error('runtime guard did not reject incompatible dsh-tools version')
  }
  console.log('PASS runtime guard rejected @deepseek-ai/dsh-tools 0.1.0-rc.3')
  rmSync(dir, { recursive: true, force: true })
}

await happyScenario()
await guardScenario()
