import { _electron as electron, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-real-dsh-'))
await mkdir('test-results', { recursive: true })
const portReservation = createServer().listen(0, '127.0.0.1')
await once(portReservation, 'listening')
const port = portReservation.address().port
await new Promise(resolve => portReservation.close(resolve))
let runtime, client
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH startup did not announce a ready URL within 90 seconds')), 90000)
    runtime = spawn(process.env.DSH_BIN ?? 'dsh', ['web', '--no-open', '--port', String(port)], {
      env: { ...process.env, DSH_HOME: path.join(directory, 'dsh-home') },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const consume = chunk => {
      buffer = (buffer + chunk.toString()).slice(-65536)
      const match = buffer.match(/https?:\/\/[^\s"'<>]*[?&]token=[^\s"'<>]+/)
      if (match) { clearTimeout(timer); resolve(match[0].replace(/\x1b\[[0-9;]*m/g, '')) }
    }
    runtime.stdout.on('data', consume)
    runtime.stderr.on('data', consume)
    runtime.once('error', error => { clearTimeout(timer); reject(error) })
    runtime.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH exited before readiness (${code})`)) })
  })
  const extra = process.env.SWITCHER_TEST_HEADLESS === '1' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  client = await electron.launch({ args: [process.cwd(), ...extra], env: { ...process.env, DSH_HOME: path.join(directory, 'client-home'), SWITCHER_USER_DATA: path.join(directory, 'client'), SWITCHER_DEV_URL: '' }, timeout: 30000 })
  await expect.poll(() => client.windows().some(page => page.url().includes('/renderer/index.html') && !page.url().includes('surface=overlay')), { timeout: 15000 }).toBe(true)
  const page = client.windows().find(page => page.url().includes('/renderer/index.html') && !page.url().includes('surface=overlay'))
  const result = await page.evaluate(url => window.desktop.command({ type: 'save', name: '真实 DSH 本地验证', url }), url)
  assert.equal(result.ok, true)
  await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).servers[0]?.status, { timeout: 30000 }).toBe('ready')
  const clean = new URL(url); clean.search = ''; clean.hash = ''
  const nativePage = client.windows().find(item => item.url().startsWith(clean.href))
  assert.ok(nativePage, 'Native DSH WebContents is exposed to the browser automation')
  await expect(nativePage.locator('body')).toContainText(/DeepSeek|Harness|新对话/, { timeout: 45000 })
  const continueButton = nativePage.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await continueButton.isVisible()) {
    await continueButton.click()
    await expect(continueButton).toBeHidden()
  }
  const workspaceButton = nativePage.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ })
  try {
    // A clean DSH home requires a workspace before it offers a message composer.
    await expect(workspaceButton).toBeVisible({ timeout: 20000 })
  } catch (error) {
    await writeFile('test-results/real-dsh-failure.txt', await nativePage.locator('body').innerText())
    await nativePage.screenshot({ path: 'test-results/real-dsh-failure.png' })
    throw error
  }
  await nativePage.screenshot({ path: 'test-results/real-dsh-web.png' })
  await page.evaluate(() => window.desktop.command({ type: 'overlay', overlay: { kind: 'instances' } }))
  const overlay = client.windows().find(item => item.url().includes('surface=overlay'))
  await expect(overlay.getByRole('heading', { name: '服务器连接' })).toBeVisible()
  await overlay.screenshot({ path: 'test-results/real-dsh-overlay.png', omitBackground: true })
  const info = await nativePage.evaluate(() => ({
    title: document.title,
    pageHasClientBridge: typeof window.desktop !== 'undefined',
    buttonCount: document.querySelectorAll('button').length,
  }))
  assert.equal(info.pageHasClientBridge, false)
  await writeFile('test-results/real-dsh-result.json', JSON.stringify(info, null, 2))
  console.log('PASS: installed DSH starts in an isolated home, launch-token login succeeds, the native workspace chooser loads, and the switcher menu opens above it')
} finally {
  if (client) await client.close()
  if (runtime?.pid && runtime.exitCode === null) {
    const exited = once(runtime, 'exit')
    if (process.platform !== 'win32') process.kill(-runtime.pid, 'SIGTERM')
    else runtime.kill('SIGTERM')
    const force = setTimeout(() => {
      try { if (process.platform !== 'win32') process.kill(-runtime.pid, 'SIGKILL'); else runtime.kill('SIGKILL') } catch { /* Process already reaped. */ }
    }, 5000)
    await exited
    clearTimeout(force)
  }
  await rm(directory, { recursive: true, force: true })
}
