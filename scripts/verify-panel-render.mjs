/**
 * 真实浏览器渲染验证：playwright-core 驱动系统 Chrome headless，
 * 打开 dsh web，等待“错峰省钱”设置页出现，截图并输出关键文本。
 */

import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = process.env.PANEL_URL ?? 'http://127.0.0.1:3080/'
const shot = path.resolve(process.argv[2] ?? path.join(process.env.TEMP ?? '/tmp', 'dsh-panel-playwright.png'))

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(8000)

  await page.waitForSelector('text=错峰省钱', { timeout: 20_000 }).catch(() => {})
  // 点侧边栏入口按钮（title 为“错峰省钱”的 button），打开 overlay 面板
  const entryButton = page.locator('button[title="错峰省钱"]')
  const entryCount = await entryButton.count()
  await entryButton.first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(5000)

  const found = await page.getByText('错峰省钱').count()
  const panelTitle = await page.getByText('错峰省钱调度器').count()
  const todaySavings = await page.getByText('今日节省').count()
  const queueTitle = await page.getByText('待执行任务', { exact: false }).count()
  const runningTitle = await page.getByText(/正在执行/).count()
  const liveTask = await page.getByText('面板实时验证').count()
  const dialogVisible = await page.locator('[role="dialog"]').count()
  const dialogText = dialogVisible > 0 ? await page.locator('[role="dialog"]').innerText().catch(() => '') : ''
  console.log(`dialog text length: ${dialogText.length}`)
  console.log('--- dialog text head ---')
  console.log(dialogText.split('\n').slice(0, 12).join('\n'))
  console.log('--- console errors ---')
  console.log(consoleErrors.slice(0, 6).join('\n') || '(none)')
  console.log('--- page errors ---')
  console.log(pageErrors.slice(0, 6).join('\n') || '(none)')
  await page.screenshot({ path: shot, fullPage: false })

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .split('\n')
    .filter((line) => line.includes('错峰') || line.includes('节省') || line.includes('队列') || line.includes('空闲') || line.includes('¥'))
    .slice(0, 20)

  console.log(`matched 错峰省钱: ${found}`)
  console.log(`sidebar entry buttons: ${entryCount}`)
  console.log(`overlay dialog: ${dialogVisible}`)
  console.log(`panel title: ${panelTitle}`)
  console.log(`今日节省: ${todaySavings}`)
  console.log(`待执行任务: ${queueTitle}`)
  console.log(`正在执行: ${runningTitle}`)
  console.log(`面板实时验证: ${liveTask}`)
  console.log(`page url: ${page.url()}`)
  console.log(`page title: ${await page.title()}`)
  console.log(`screenshot: ${shot}`)
  console.log('--- key lines ---')
  console.log(bodyText.join('\n'))
} finally {
  await browser.close()
}
