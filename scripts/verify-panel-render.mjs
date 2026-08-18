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
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(8000)

  // 尝试点开设置入口（按钮/导航带“设置”文本）
  const settingsButtons = await page.getByText('设置', { exact: true }).count()
  if (settingsButtons > 0) {
    await page.getByText('设置', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(5000)
  }

  await page.waitForSelector('text=错峰省钱', { timeout: 20_000 }).catch(() => {})
  // 点击“错峰省钱”导航项展开设置页
  await page.getByText('错峰省钱').first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(5000)

  const found = await page.getByText('错峰省钱').count()
  const panelTitle = await page.getByText('错峰省钱调度器').count()
  const todaySavings = await page.getByText('今日节省').count()
  const queueTitle = await page.getByText('待执行任务', { exact: false }).count()
  const runningTitle = await page.getByText(/正在执行/).count()
  const liveTask = await page.getByText('面板实时验证').count()
  await page.screenshot({ path: shot, fullPage: false })

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .split('\n')
    .filter((line) => line.includes('错峰') || line.includes('节省') || line.includes('队列') || line.includes('空闲') || line.includes('¥'))
    .slice(0, 20)

  console.log(`matched 错峰省钱: ${found}`)
  console.log(`panel title: ${panelTitle}`)
  console.log(`今日节省: ${todaySavings}`)
  console.log(`待执行任务: ${queueTitle}`)
  console.log(`正在执行: ${runningTitle}`)
  console.log(`面板实时验证: ${liveTask}`)
  console.log(`settings buttons found: ${settingsButtons}`)
  console.log(`page url: ${page.url()}`)
  console.log(`page title: ${await page.title()}`)
  console.log(`screenshot: ${shot}`)
  console.log('--- key lines ---')
  console.log(bodyText.join('\n'))
} finally {
  await browser.close()
}
