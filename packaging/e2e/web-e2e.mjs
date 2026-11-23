// The web app in a real browser against a real backend: send a message, see the answer and the task, open the
// settings. Takes screenshots along the way.
//
// Usage: node web-e2e.mjs <base-url> <screenshot-dir>      (needs the `playwright` package and its Chromium)
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const [base, shots] = process.argv.slice(2)
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch()
const failures = []
async function run(name, size, scheme, locale, steps) {
  const context = await browser.newContext({ viewport: size, colorScheme: scheme, locale, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const problems = []
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
  page.on('pageerror', error => problems.push(String(error)))
  page.on('requestfailed', request => problems.push(`request failed: ${request.url()}`))
  page.on('request', request => { if (!request.url().startsWith(base)) problems.push(`left the server: ${request.url()}`) })
  try {
    await page.goto(base, { waitUntil: 'load' })
    // Flutter draws on a canvas; its accessibility tree gives the test names to act on.
    await page.waitForSelector('flt-semantics-placeholder', { state: 'attached', timeout: 60_000 })
    await page.evaluate(() => document.querySelector('flt-semantics-placeholder').click())
    await page.waitForSelector('flt-semantics', { state: 'attached', timeout: 30_000 })
    await steps(page, async label => { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/${name}-${label}.png` }) })
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    await page.screenshot({ path: `${shots}/${name}-failure.png` }).catch(() => {})
  }
  if (problems.length) failures.push(`${name}: ${[...new Set(problems)].join(' | ')}`)
  await context.close()
}
// Flutter names what it draws in its accessibility tree, as text or as a label; the innermost node that says
// `value` is the one to wait for or click.
const find = value => {
  const nodes = [...document.querySelectorAll('flt-semantics')].filter(node => (node.getAttribute('aria-label') ?? '').includes(value) || node.textContent.includes(value))
  const node = nodes.find(candidate => !nodes.some(other => other !== candidate && candidate.contains(other)))
  if (!node) return null
  const box = node.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const seen = (page, value, timeout = 30_000) => page.waitForFunction(find, value, { timeout })
const click = async (page, value) => {
  const at = await (await seen(page, value)).jsonValue()
  await page.mouse.click(at.x, at.y)
}

await run('wide-light', { width: 1180, height: 780 }, 'light', 'zh-CN', async (page, shot) => {
  await seen(page, '开始对话', 30_000)
  await shot('1-empty')
  await page.getByRole('textbox').first().click()
  await page.keyboard.type('请把结果写进文件。')
  await shot('2-typed')
  await click(page, '发送')
  await seen(page, '收到：正在把结果写进文件。', 180_000)
  await seen(page, '结果已写入文件。', 240_000)
  await shot('3-answered')
  await page.getByRole('button', { name: '任务' }).first().click().catch(async () => { await click(page, '任务') })
  await seen(page, 'Write the result file', 30_000)
  await click(page, 'Write the result file')
  await seen(page, 'result.txt', 30_000)
  await shot('4-task')
  await click(page, '设置')
  await seen(page, 'Antigravity', 30_000)
  await shot('5-settings')
})
await run('narrow-dark', { width: 420, height: 820 }, 'dark', 'zh-CN', async (page, shot) => {
  await seen(page, '结果已写入文件。', 60_000)
  await shot('1-chat')
  await click(page, '设置')
  await seen(page, 'Antigravity', 30_000)
  await shot('2-settings')
})
await run('wide-english', { width: 1180, height: 780 }, 'light', 'en-US', async (page, shot) => {
  await seen(page, '结果已写入文件。', 60_000)
  await click(page, 'Tasks')
  await seen(page, 'Write the result file', 30_000)
  await shot('1-tasks')
})
await browser.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('web e2e passed')
